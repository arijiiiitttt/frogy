import { getAction, validateInput, callHostAction, HostError } from "../actions/index.js";
import { alert } from "../shared/alerts.js";
import { intEnv } from "../shared/util.js";
import { addEvent, getSetting, q } from "./db.js";
import { findRecipe, parseIntent, type Step } from "./triage.js";
import { runAgent, newState } from "../agent/loop.js";
import { Wait } from "../agent/errors.js";
import { ROLES, systemPrompt, toolsFor } from "../agent/roles.js";
import type { AgentDeps, AgentState, AgentTool } from "../agent/types.js";
import type { Tier } from "../gateway/types.js";
import { buildAgentTools } from "./agent-tools.js";
import { llmChat } from "./llm.js";
import crypto from "node:crypto";
import { loadMcpConfig, McpRegistry } from "../agent/mcp.js";
import { pickTier, type TierStats } from "../agent/routing.js";

const MAX_ATTEMPTS = 3;
const APPROVAL_TIMEOUT_MS = intEnv("APPROVAL_TIMEOUT_HOURS", 12) * 3600_000;
let mcp: McpRegistry | null | undefined;
const mcpRegistry = () => {
  if (mcp === undefined) {
    const c = loadMcpConfig();
    mcp = c ? new McpRegistry(c) : null;
  }
  return mcp;
};
const LOCKED_POLL_S = intEnv("LOCKED_POLL_SECONDS", 60);
const APPROVAL_POLL_S = intEnv("APPROVAL_POLL_SECONDS", 120);

interface Task {
  id: string;
  kind: "action" | "goal" | "agent";
  role: string | null;
  depth: number;
  root_id: string | null;
  allow_actions: boolean;
  agent_state: AgentState | null;
  max_steps: number | null;
  budget_tokens: number | null;
  want_plan: boolean;
  want_verify: boolean;
  action: string | null;
  input: Record<string, unknown>;
  goal: string | null;
  dry_run: boolean;
  attempts: number;
  idempotency_key: string | null;
  model: string | null;
  tier: "cheap" | "mid" | "strong" | null;
  created_at: Date;
}

/** Raised to push a task back onto the queue without counting it as a failed attempt. */
class Defer extends Error {
  constructor(public seconds: number, public note: string) {
    super(note);
  }
}
class Fail extends Error {}

export class Worker {
  private running = new Set<string>();
  private timer?: NodeJS.Timeout;
  private beat?: NodeJS.Timeout;
  private sweep?: NodeJS.Timeout;
  private stopping = false;
  private ticking = false;

  async start(): Promise<void> {
    await this.recoverOrphans(0); // at boot: anything "running" belongs to a dead process
    this.timer = setInterval(() => void this.tick(), 1500);
    this.beat = setInterval(() => void this.heartbeat(), 20_000);
    this.sweep = setInterval(() => void this.recoverOrphans(90), 30_000);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    clearInterval(this.timer);
    clearInterval(this.beat);
    clearInterval(this.sweep);
    const ids = [...this.running];
    if (ids.length) await q("UPDATE tasks SET status='queued', attempts=GREATEST(attempts-1,0), locked_at=NULL, updated_at=now() WHERE id = ANY($1::uuid[]) AND status='running'", [ids]);
  }

  /** Requeue tasks whose owner stopped heartbeating (restart/crash). Give up after MAX_ATTEMPTS. */
  private async recoverOrphans(staleSeconds: number): Promise<void> {
    const own = [...this.running];
    const r = await q(
      `UPDATE tasks SET
         status = CASE WHEN attempts >= $2 THEN 'failed' ELSE 'queued' END,
         error  = CASE WHEN attempts >= $2 THEN 'worker restarted too many times' ELSE error END,
         locked_at = NULL, updated_at = now()
       WHERE status='running' AND (locked_at IS NULL OR locked_at < now() - make_interval(secs => $1)) AND NOT (id = ANY($3::uuid[]))
       RETURNING id, status`,
      [staleSeconds, MAX_ATTEMPTS, own],
    );
    for (const row of r.rows) await addEvent(row.id, "recovered", { status: row.status });
  }

  private async heartbeat(): Promise<void> {
    if (this.running.size) await q("UPDATE tasks SET locked_at=now() WHERE id = ANY($1::uuid[]) AND status='running'", [[...this.running]]);
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.stopping) return;
    this.ticking = true;
    try {
      const max = await getSetting<number>("max_concurrent", intEnv("MAX_CONCURRENT", 5));
      const free = max - this.running.size;
      if (free <= 0) return;
      const r = await q<Task>(
        `UPDATE tasks SET status='running', locked_at=now(), attempts=attempts+1, updated_at=now()
         WHERE id IN (SELECT id FROM tasks WHERE status='queued' AND run_after <= now() ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED)
         RETURNING *`,
        [free],
      );
      for (const t of r.rows) {
        this.running.add(t.id);
        void this.execute(t).finally(() => this.running.delete(t.id));
      }
    } catch (e) {
      console.error("tick error:", (e as Error).message);
    } finally {
      this.ticking = false;
    }
  }

  private async finish(id: string, status: "succeeded" | "failed", result: unknown, error?: string): Promise<void> {
    // The status guard means a task stopped by the user stays stopped.
    await q("UPDATE tasks SET status=$2, result=$3, error=$4, locked_at=NULL, updated_at=now() WHERE id=$1 AND status='running'", [id, status, result === undefined ? null : JSON.stringify(result), error ?? null]);
    await addEvent(id, status, error ? { error } : {});
  }

  private async execute(t: Task): Promise<void> {
    try {
      await addEvent(t.id, "started", { attempt: t.attempts, kind: t.kind });
      const result = t.kind === "action" ? await this.runStep(t, { action: t.action!, input: t.input }, 0) : t.kind === "agent" ? await this.runAgentTask(t) : await this.runGoal(t);
      await this.finish(t.id, "succeeded", result);
    } catch (e) {
      if (e instanceof Defer || e instanceof Wait) {
        await q("UPDATE tasks SET status='queued', attempts=GREATEST(attempts-1,0), note=$2, run_after=now() + make_interval(secs => $3), locked_at=NULL, updated_at=now() WHERE id=$1 AND status='running'", [t.id, e.note, e.seconds]);
        await addEvent(t.id, "deferred", { note: e.note, retryInSeconds: e.seconds });
        return;
      }
      const msg = (e as Error).message;
      const retryable = !(e instanceof Fail);
      if (retryable && t.attempts < MAX_ATTEMPTS) {
        const wait = 30 * t.attempts;
        await q("UPDATE tasks SET status='queued', error=$2, run_after=now() + make_interval(secs => $3), locked_at=NULL, updated_at=now() WHERE id=$1 AND status='running'", [t.id, msg, wait]);
        await addEvent(t.id, "retry", { error: msg, inSeconds: wait });
      } else {
        await this.finish(t.id, "failed", undefined, msg);
        void alert(`task-failed-${t.id}`, `Task ${t.id.slice(0, 8)} failed: ${msg}`, 60_000);
      }
    }
  }

  /** Run ONE deterministic action through the host broker. No AI involved. */
  private async runStep(t: Task, step: Step, index: number, forceDry = false): Promise<Record<string, unknown>> {
    const def = getAction(step.action);
    if (!def) throw new Fail(`Unknown action: ${step.action}`);
    const v = validateInput(step.action, step.input);
    if (!v.ok) throw new Fail(v.error);
    const key = `${t.idempotency_key ?? t.id}:${index}`;
    try {
      const out = await callHostAction(step.action, { input: v.value, dryRun: t.dry_run || forceDry, idempotencyKey: key, taskId: t.id });
      await addEvent(t.id, "action_result", { action: step.action, index, result: out });
      return { action: step.action, ...out };
    } catch (e) {
      if (!(e instanceof HostError)) throw e;
      if (e.code === "locked") {
        void alert("host-locked", "Credential vault is LOCKED — tasks are paused. Run `frogy-host unlock` on the host.", 30 * 60_000);
        throw new Defer(LOCKED_POLL_S, "waiting for vault unlock");
      }
      if (e.code === "unreachable" || e.status >= 500) throw e; // retryable
      if (e.code === "needs_approval") {
        if (Date.now() - t.created_at.getTime() > APPROVAL_TIMEOUT_MS) throw new Fail("approval timed out; task skipped");
        throw new Defer(APPROVAL_POLL_S, `waiting for owner approval (${String(e.data?.approvalId ?? "")})`);
      }
      throw new Fail(`${e.code}: ${e.message}`);
    }
  }

  /** Free-text goals: recipe -> cache -> one cheap-model intent parse. Proposes; never auto-executes destructive work. */
  private async runGoal(t: Task): Promise<Record<string, unknown>> {
    const goal = t.goal ?? "";
    const recipe = await findRecipe(goal);
    if (recipe) {
      await addEvent(t.id, "triage", { route: "recipe", steps: recipe.length });
      const results: unknown[] = [];
      for (let i = 0; i < recipe.length; i++) results.push(await this.runStep(t, recipe[i]!, i));
      return { route: "recipe", results };
    }
    const { step, cached, reason } = await parseIntent(t.id, goal, { model: t.model ?? undefined, tier: t.tier ?? undefined }).catch((e) => {
      throw new Fail((e as Error).message);
    });
    await addEvent(t.id, "triage", { route: cached ? "cache" : "intent-parser", action: step?.action ?? null });
    if (!step) throw new Fail(`No matching action (${reason ?? "none"}). For open-ended work use: frogy agent "<goal>" (or define an action/recipe).`);
    const preview = await this.runStep(t, step, 0, true); // ALWAYS a dry run first
    return { route: cached ? "cache" : "intent-parser", proposed: step, preview, next: `Run \`frogy confirm ${t.id}\` to execute for real.` };
  }

  /** One agent (root or sub-agent). State is saved after every step, so crashes/restarts resume mid-run. */
  private async runAgentTask(t: Task): Promise<Record<string, unknown>> {
    const role = ROLES[t.role ?? "general"] ?? ROLES.general!;
    const info = { id: t.id, rootId: t.root_id ?? t.id, depth: t.depth, allowActions: t.allow_actions, createdAt: t.created_at, role: role.name };
    const all = buildAgentTools(info);
    const tools: Record<string, AgentTool> = Object.fromEntries(toolsFor(role, t.depth).filter((n) => all[n]).map((n) => [n, all[n]!]));
    Object.assign(tools, (await mcpRegistry()?.toolsFor(role.name, t.allow_actions)) ?? {}); // allowlisted MCP tools, if configured for this role

    let st = t.agent_state;
    if (!st) {
      // Adaptive start tier: begin on the cheapest tier that has actually been working for this role.
      let tier = (t.tier ?? role.tier) as Tier;
      if (!t.tier && !t.model) {
        const r = await q(
          `SELECT start_tier, status, count(*)::int AS n FROM (
             SELECT start_tier, status FROM tasks WHERE kind='agent' AND role=$1 AND status IN ('succeeded','failed') AND start_tier IS NOT NULL ORDER BY updated_at DESC LIMIT 60
           ) s GROUP BY 1,2`,
          [role.name],
        );
        const stats: TierStats = {};
        for (const row of r.rows) {
          const e = (stats[row.start_tier as Tier] ??= { n: 0, failed: 0 });
          e.n += row.n;
          if (row.status === "failed") e.failed += row.n;
        }
        const picked = pickTier(role.tier, stats);
        if (picked !== role.tier) await addEvent(t.id, "tier_chosen", { from: role.tier, to: picked, reason: "recent runs on the cheaper tier kept failing" });
        tier = picked;
      }
      await q("UPDATE tasks SET start_tier=$2 WHERE id=$1 AND start_tier IS NULL", [t.id, tier]);
      const skills = (await q("SELECT name, description FROM skills WHERE roles IS NULL OR $1 = ANY(roles) ORDER BY name LIMIT 20", [role.name])).rows;
      st = newState(systemPrompt(role, skills), t.goal ?? "", tier, t.want_plan, t.want_verify);
    }

    const waitMs = intEnv("APPROVAL_TIMEOUT_HOURS", 12) * 3600_000;
    const deps: AgentDeps = {
      chat: (req) => llmChat(t.id, { ...req, model: t.model ?? undefined }),
      tools,
      save: async (s) => void (await q("UPDATE tasks SET agent_state=$2, locked_at=now(), updated_at=now() WHERE id=$1", [t.id, JSON.stringify(s)])),
      isStopped: async () => (await q("SELECT status FROM tasks WHERE id=$1", [t.id])).rows[0]?.status === "stopped",
      event: async (type, payload) => {
        await addEvent(t.id, type, payload);
        if (type === "injection_suspected") void alert(`inject-${t.id}`, `Possible prompt injection in content read by agent ${t.id.slice(0, 8)} (${String(payload.tool)}). The run is now tainted: side effects need your approval.`, 10 * 60_000);
      },
      limits: { maxSteps: t.max_steps ?? intEnv("AGENT_MAX_STEPS", 15), maxTokens: t.budget_tokens ?? intEnv("AGENT_TOKEN_BUDGET", 100_000), compactAtChars: 24_000, keepLast: 8 },
      taintPolicy: (process.env.TAINT_POLICY as "approve" | "flag" | "off" | undefined) ?? "approve",
      approval: async (call, summary) => {
        const r = await q("SELECT id, status, created_at FROM tool_approvals WHERE task_id=$1 AND tool_call_id=$2", [t.id, call.toolCallId]);
        const row = r.rows[0];
        if (!row) {
          const id = crypto.randomBytes(4).toString("hex");
          await q("INSERT INTO tool_approvals (id, task_id, tool_call_id, summary) VALUES ($1,$2,$3,$4) ON CONFLICT (task_id, tool_call_id) DO NOTHING", [id, t.id, call.toolCallId, summary.slice(0, 500)]);
          await addEvent(t.id, "approval_requested", { id, summary: summary.slice(0, 200) });
          void alert(`toolap-${id}`, `Approval needed (${id}): agent ${t.id.slice(0, 8)} wants to: ${summary.slice(0, 200)}\nIt has read untrusted content, so you decide.\nApprove: frogy approve ${id}   Deny: frogy deny ${id}`, 60_000);
          return "pending";
        }
        if (row.status === "pending" && Date.now() - new Date(row.created_at).getTime() > waitMs) return "denied";
        return row.status as "approved" | "pending" | "denied";
      },
    };
    const out = await runAgent(deps, st);
    if (out.status === "failed") throw new Fail(out.error);
    if (out.status === "stopped") return { stopped: true };
    return { result: out.result, steps: st.step, tokens: st.tokensUsed, tainted: Boolean(st.meta.tainted) };
  }
}
