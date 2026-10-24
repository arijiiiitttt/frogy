import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z } from "zod";
import { getAction, hostStatus, listActions, validateInput } from "../actions/index.js";
import { bearer, env, intEnv, safeEqual } from "../shared/util.js";
import { addEvent, getSetting, q, setSetting } from "./db.js";
import { llmConfigured, tokensUsedToday } from "./llm.js";
import { nextRun } from "./scheduler.js";
import { buildDigest, formatDigest } from "./digest.js";
import { priceOf, usd, usdToday } from "./llm.js";
import { lenientJson } from "../shared/http.js";
import crypto from "node:crypto";
import { ROLES } from "../agent/roles.js";
import { redactString } from "../shared/redact.js";

type Role = "run" | "admin";
declare module "fastify" {
  interface FastifyRequest {
    role?: Role;
  }
}

const TaskBody = z.object({
  action: z.string().optional(),
  input: z.record(z.string(), z.unknown()).default({}),
  goal: z.string().min(1).max(4000).optional(),
  dryRun: z.boolean().default(false),
  idempotencyKey: z.string().max(200).optional(),
  model: z.string().max(200).optional(),
  tier: z.enum(["cheap", "mid", "strong"]).optional(),
  agent: z
    .object({
      role: z.string().default("general"),
      act: z.boolean().default(false),
      plan: z.boolean().default(false),
      verify: z.boolean().default(false),
      maxSteps: z.number().int().min(1).max(50).optional(),
      budgetTokens: z.number().int().min(1000).max(500_000).optional(),
    })
    .optional(),
});

function roleOf(req: FastifyRequest): Role | null {
  const t = bearer(req.headers.authorization);
  if (!t) return null;
  const admin = env("ADMIN_TOKEN");
  const run = env("API_TOKEN");
  if (admin && safeEqual(t, admin)) return "admin";
  if (run && safeEqual(t, run)) return "run";
  return null;
}

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 512 * 1024, trustProxy: true });

  lenientJson(app);

  // The ONLY unauthenticated route. Reveals nothing. External pingers hit this to keep the free instance awake.
  app.get("/healthz", async () => ({ ok: true }));

  app.addHook("onRequest", async (req, reply) => {
    if (req.url === "/healthz") return;
    const role = roleOf(req);
    if (!role) {
      await new Promise((r) => setTimeout(r, 300)); // slow down token guessing
      return reply.code(401).send({ error: "unauthorized" });
    }
    req.role = role;
  });
  const needAdmin = (req: FastifyRequest) => req.role === "admin";

  app.get("/actions", async () => listActions().map(({ schema: _s, ...a }) => a));

  app.post("/tasks", async (req, reply) => {
    const p = TaskBody.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: "invalid_body", message: p.error.issues.map((i) => i.message).join("; ") });
    const b = p.data;
    if (!b.action && !b.goal) return reply.code(400).send({ error: "need_action_or_goal" });
    if (b.action) {
      const def = getAction(b.action);
      if (!def) return reply.code(400).send({ error: "unknown_action" });
      const v = validateInput(b.action, b.input);
      if (!v.ok) return reply.code(400).send({ error: "invalid_input", message: v.error });
      if (def.risk === "destructive" && !needAdmin(req)) return reply.code(403).send({ error: "admin_required", message: "Destructive actions need the admin token" });
    }
    if (b.agent) {
      if (!b.goal) return reply.code(400).send({ error: "agent_needs_goal" });
      if (!ROLES[b.agent.role]) return reply.code(400).send({ error: "unknown_role", message: `Roles: ${Object.keys(ROLES).join(", ")}` });
      if (!llmConfigured()) return reply.code(400).send({ error: "llm_not_configured", message: "Create frogy.config.json and set provider keys first" });
      if (b.agent.act && !needAdmin(req)) return reply.code(403).send({ error: "admin_required", message: "Letting an agent act (--act) needs the admin token" });
      const id = crypto.randomUUID();
      await q("INSERT INTO tasks (id, kind, goal, role, root_id, allow_actions, want_plan, want_verify, max_steps, budget_tokens, model, tier, idempotency_key) VALUES ($1,'agent',$2,$3,$1,$4,$5,$11,$6,$7,$8,$9,$10)", [
        id, b.goal, b.agent.role, b.agent.act, b.agent.plan, b.agent.maxSteps ?? null, b.agent.budgetTokens ?? null, b.model ?? null, b.tier ?? null, b.idempotencyKey ?? null, b.agent.verify,
      ]);
      await addEvent(id, "queued", { kind: "agent", role: b.agent.role, act: b.agent.act });
      return reply.code(201).send({ id, status: "queued" });
    }
    if (b.idempotencyKey) {
      const ex = await q("SELECT id,status FROM tasks WHERE idempotency_key=$1", [b.idempotencyKey]);
      if (ex.rows[0]) return { id: ex.rows[0].id, status: ex.rows[0].status, existing: true };
    }
    const r = await q("INSERT INTO tasks (kind, action, input, goal, dry_run, idempotency_key, model, tier) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,status", [
      b.action ? "action" : "goal", b.action ?? null, JSON.stringify(b.input), b.goal ?? null, b.dryRun, b.idempotencyKey ?? null, b.model ?? null, b.tier ?? null,
    ]);
    await addEvent(r.rows[0].id, "queued", { kind: b.action ? "action" : "goal" });
    return reply.code(201).send(r.rows[0]);
  });

  app.get<{ Querystring: { limit?: string; status?: string } }>("/tasks", async (req) => {
    const limit = Math.min(Number(req.query.limit ?? 20) || 20, 200);
    const r = await q(
      `SELECT id, kind, action, goal, status, note, attempts, dry_run, created_at, updated_at, left(coalesce(error,''),200) AS error
       FROM tasks WHERE ($2::text IS NULL OR status=$2) ORDER BY created_at DESC LIMIT $1`,
      [limit, req.query.status ?? null],
    );
    return r.rows;
  });

  app.get<{ Params: { id: string } }>("/tasks/:id", async (req, reply) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return reply.code(400).send({ error: "bad_id" });
    const r = await q("SELECT * FROM tasks WHERE id=$1", [req.params.id]);
    return r.rows[0] ?? reply.code(404).send({ error: "not_found" });
  });

  app.get<{ Params: { id: string }; Querystring: { after?: string } }>("/tasks/:id/events", async (req, reply) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return reply.code(400).send({ error: "bad_id" });
    const r = await q("SELECT id, ts, type, payload FROM events WHERE task_id=$1 AND id > $2 ORDER BY id LIMIT 500", [req.params.id, Number(req.query.after ?? 0) || 0]);
    return r.rows;
  });

  app.post<{ Params: { id: string } }>("/tasks/:id/stop", async (req, reply) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return reply.code(400).send({ error: "bad_id" });
    const r = await q("UPDATE tasks SET status='stopped', locked_at=NULL, updated_at=now() WHERE (id=$1 OR root_id=$1) AND status IN ('queued','running') RETURNING id", [req.params.id]);
    for (const row of r.rows) await addEvent(row.id, "stopped", {});
    return { stopped: r.rows.length };
  });

  // Agent tree: the root and all sub-agents, with token usage.
  app.get<{ Params: { id: string } }>("/agents/:id", async (req, reply) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return reply.code(400).send({ error: "bad_id" });
    const r = await q(
      `SELECT t.id, t.parent_id, t.role, t.depth, t.status, t.note, t.question, left(t.goal,120) AS goal, left(coalesce(t.result->>'result',''),400) AS result,
              left(coalesce(t.error,''),200) AS error, coalesce((SELECT sum(input_tokens+output_tokens) FROM llm_calls l WHERE l.task_id=t.id),0)::int AS tokens
       FROM tasks t WHERE t.kind='agent' AND (t.id=$1 OR t.root_id=$1) ORDER BY t.created_at`,
      [req.params.id],
    );
    return r.rows;
  });

  // The owner answers an agent's ask_human question.
  app.post<{ Params: { id: string } }>("/tasks/:id/answer", async (req, reply) => {
    const a = z.object({ answer: z.string().min(1).max(2000) }).safeParse(req.body);
    if (!a.success) return reply.code(400).send({ error: "invalid_body" });
    const r = await q("UPDATE tasks SET answer=$2 WHERE id=$1 AND question IS NOT NULL RETURNING id", [req.params.id, a.data.answer]);
    return r.rows[0] ? { answered: true } : reply.code(404).send({ error: "no_open_question" });
  });

  // ---- tool approvals (tainted agents asking to act) ----
  app.get("/tool-approvals", async () => (await q("SELECT id, task_id, summary, status, created_at FROM tool_approvals WHERE status='pending' ORDER BY created_at")).rows);
  for (const verdict of ["approve", "deny"] as const) {
    app.post<{ Params: { id: string } }>(`/tool-approvals/:id/${verdict}`, async (req, reply) => {
      if (!needAdmin(req)) return reply.code(403).send({ error: "admin_required" });
      const r = await q("UPDATE tool_approvals SET status=$2 WHERE id=$1 AND status='pending' RETURNING id, task_id", [req.params.id, verdict === "approve" ? "approved" : "denied"]);
      if (!r.rows[0]) return reply.code(404).send({ error: "no_pending_approval" });
      await addEvent(r.rows[0].task_id, `approval_${verdict === "approve" ? "granted" : "denied"}`, { id: req.params.id });
      return { id: req.params.id, status: verdict === "approve" ? "approved" : "denied" };
    });
  }

  // ---- skills: owner-written playbooks loaded on demand (progressive disclosure) ----
  app.put<{ Params: { name: string } }>("/skills/:name", async (req, reply) => {
    if (!needAdmin(req)) return reply.code(403).send({ error: "admin_required" });
    const b = z.object({ description: z.string().min(3).max(200), instructions: z.string().min(1).max(8000), roles: z.array(z.string()).optional() }).safeParse(req.body);
    if (!b.success || !/^[a-z0-9][a-z0-9_-]{0,40}$/.test(req.params.name)) return reply.code(400).send({ error: "invalid_body", message: "name: lowercase letters/digits/_/-; description 3-200 chars; instructions up to 8000 chars" });
    if (b.data.roles?.some((r) => !ROLES[r])) return reply.code(400).send({ error: "unknown_role" });
    await q("INSERT INTO skills (name, description, instructions, roles) VALUES ($1,$2,$3,$4) ON CONFLICT (name) DO UPDATE SET description=EXCLUDED.description, instructions=EXCLUDED.instructions, roles=EXCLUDED.roles, updated_at=now()", [req.params.name, b.data.description, redactString(b.data.instructions), b.data.roles ?? null]);
    return { saved: req.params.name };
  });
  app.get("/skills", async () => (await q("SELECT name, description, roles, length(instructions) AS chars FROM skills ORDER BY name")).rows);
  app.delete<{ Params: { name: string } }>("/skills/:name", async (req, reply) => {
    if (!needAdmin(req)) return reply.code(403).send({ error: "admin_required" });
    return { deleted: Boolean((await q("DELETE FROM skills WHERE name=$1 RETURNING name", [req.params.name])).rows[0]) };
  });

  // KILL SWITCH: stop everything, disable all schedules.
  app.post("/stop-all", async (req, reply) => {
    if (!needAdmin(req)) return reply.code(403).send({ error: "admin_required" });
    const t = await q("UPDATE tasks SET status='stopped', locked_at=NULL, updated_at=now() WHERE status IN ('queued','running') RETURNING id");
    await q("UPDATE schedules SET enabled=false");
    return { stopped: t.rowCount };
  });

  // Turn a goal's dry-run proposal into a real task.
  app.post<{ Params: { id: string } }>("/tasks/:id/confirm", async (req, reply) => {
    const r = await q("SELECT * FROM tasks WHERE id=$1 AND kind='goal' AND status='succeeded'", [req.params.id]);
    const t = r.rows[0];
    const prop = t?.result?.proposed as { action: string; input: Record<string, unknown> } | undefined;
    if (!prop) return reply.code(404).send({ error: "no_proposal" });
    const def = getAction(prop.action);
    if (def?.risk === "destructive" && !needAdmin(req)) return reply.code(403).send({ error: "admin_required" });
    const n = await q("INSERT INTO tasks (kind, action, input, idempotency_key) VALUES ('action',$1,$2,$3) ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key RETURNING id,status", [prop.action, JSON.stringify(prop.input), `confirm:${t.id}`]);
    await addEvent(n.rows[0].id, "queued", { confirmedFrom: t.id });
    return reply.code(201).send(n.rows[0]);
  });

  // ---- schedules ----
  app.post("/schedules", async (req, reply) => {
    if (!needAdmin(req)) return reply.code(403).send({ error: "admin_required" });
    const b = z.object({ cron: z.string().max(100), timezone: z.string().default("UTC"), action: z.string().optional(), input: z.record(z.string(), z.unknown()).default({}), goal: z.string().optional(), agent: z.object({ role: z.string().default("general"), act: z.boolean().default(false), plan: z.boolean().default(false), verify: z.boolean().default(false), maxSteps: z.number().int().min(1).max(50).optional(), budgetTokens: z.number().int().min(1000).max(500_000).optional() }).optional() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "invalid_body" });
    const { cron, timezone, action, input, goal, agent } = b.data;
    if (!action && !goal) return reply.code(400).send({ error: "need_action_or_goal" });
    if (agent) {
      if (!goal) return reply.code(400).send({ error: "agent_needs_goal" });
      if (!ROLES[agent.role]) return reply.code(400).send({ error: "unknown_role" });
      if (!llmConfigured()) return reply.code(400).send({ error: "llm_not_configured" });
    }
    if (action) {
      const v = validateInput(action, input);
      if (!v.ok) return reply.code(400).send({ error: "invalid_input", message: v.error });
    }
    let n: Date | null;
    try {
      n = nextRun(cron, timezone);
    } catch (e) {
      return reply.code(400).send({ error: "bad_cron", message: (e as Error).message });
    }
    const r = await q("INSERT INTO schedules (cron,timezone,action,input,goal,next_run_at,agent) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id,next_run_at", [cron, timezone, action ?? null, JSON.stringify(input), goal ?? null, n, agent ? JSON.stringify(agent) : null]);
    return reply.code(201).send(r.rows[0]);
  });
  app.get("/schedules", async () => (await q("SELECT id,cron,timezone,action,goal,agent IS NOT NULL AS is_agent,enabled,next_run_at FROM schedules ORDER BY created_at")).rows);
  app.delete<{ Params: { id: string } }>("/schedules/:id", async (req, reply) => {
    if (!needAdmin(req)) return reply.code(403).send({ error: "admin_required" });
    const r = await q("DELETE FROM schedules WHERE id=$1 RETURNING id", [req.params.id]);
    return { deleted: Boolean(r.rows[0]) };
  });

  // ---- recipes (reusable zero-token step lists) ----
  app.put<{ Params: { name: string } }>("/recipes/:name", async (req, reply) => {
    if (!needAdmin(req)) return reply.code(403).send({ error: "admin_required" });
    const b = z.object({ steps: z.array(z.object({ action: z.string(), input: z.record(z.string(), z.unknown()).default({}) })).min(1).max(20) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "invalid_body" });
    for (const s of b.data.steps) {
      const v = validateInput(s.action, s.input);
      if (!v.ok) return reply.code(400).send({ error: "invalid_step", message: v.error });
    }
    await q("INSERT INTO recipes (name,steps) VALUES ($1,$2) ON CONFLICT (name) DO UPDATE SET steps=EXCLUDED.steps", [req.params.name, JSON.stringify(b.data.steps)]);
    return { saved: req.params.name };
  });
  // Turn the real actions an agent performed into a zero-token recipe (AI -> script). Replays the SAME inputs.
  app.post("/recipes/promote", async (req, reply) => {
    if (!needAdmin(req)) return reply.code(403).send({ error: "admin_required" });
    const b = z.object({ taskId: z.string().uuid(), name: z.string().regex(/^[\w .-]{1,80}$/) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "invalid_body" });
    const ev = await q("SELECT e.payload FROM events e JOIN tasks t ON t.id=e.task_id WHERE e.type='act_ok' AND (t.id=$1 OR t.root_id=$1) ORDER BY e.id", [b.data.taskId]);
    if (!ev.rows.length) return reply.code(400).send({ error: "nothing_to_promote", message: "That run has no successful real actions (was it started with --act?)" });
    const steps = ev.rows.map((r) => ({ action: r.payload.action as string, input: r.payload.input as Record<string, unknown> }));
    for (const s of steps) {
      const v = validateInput(s.action, s.input);
      if (!v.ok) return reply.code(400).send({ error: "invalid_step", message: v.error });
    }
    await q("INSERT INTO recipes (name,steps) VALUES ($1,$2) ON CONFLICT (name) DO UPDATE SET steps=EXCLUDED.steps", [b.data.name, JSON.stringify(steps)]);
    return { saved: b.data.name, steps: steps.length, next: `frogy run "${b.data.name}"  (0 tokens; edit with: frogy recipe add)` };
  });
  app.get<{ Querystring: { hours?: string; text?: string } }>("/digest", async (req) => {
    const d = await buildDigest(Math.min(Number(req.query.hours ?? 24) || 24, 168));
    return req.query.text ? { text: formatDigest(d) } : d;
  });
  app.get("/recipes", async () => (await q("SELECT name, jsonb_array_length(steps) AS steps FROM recipes ORDER BY name")).rows);

  // ---- status / cost / config ----
  app.get("/status", async () => {
    const counts = await q("SELECT status, count(*)::int AS n FROM tasks GROUP BY status");
    let host: unknown;
    try {
      host = await hostStatus();
    } catch (e) {
      host = { ok: false, error: (e as Error).message };
    }
    return {
      ok: true,
      tasks: Object.fromEntries(counts.rows.map((r) => [r.status, r.n])),
      maxConcurrent: await getSetting("max_concurrent", intEnv("MAX_CONCURRENT", 5)),
      llmConfigured: llmConfigured(),
      host,
    };
  });
  app.get("/cost", async () => {
    const r = await q("SELECT provider, model, count(*)::int AS calls, sum(input_tokens)::int AS input_tokens, sum(output_tokens)::int AS output_tokens FROM llm_calls WHERE ts >= date_trunc('day', now()) GROUP BY provider, model ORDER BY 1,2");
    const byModel = r.rows.map((x) => ({ ...x, usd: Number(usd(priceOf(x.provider, x.model), x.input_tokens, x.output_tokens).toFixed(4)), priced: Boolean(priceOf(x.provider, x.model)) }));
    return { tokensToday: await tokensUsedToday(), tokenBudget: intEnv("DAILY_TOKEN_BUDGET", 500_000), usdToday: Number((await usdToday()).toFixed(4)), usdBudget: Number(env("DAILY_USD_BUDGET", "0")), byModel };
  });
  app.put<{ Params: { key: string } }>("/config/:key", async (req, reply) => {
    if (!needAdmin(req)) return reply.code(403).send({ error: "admin_required" });
    if (req.params.key !== "max_concurrent") return reply.code(400).send({ error: "unknown_key" });
    const n = z.coerce.number().int().min(1).max(200).safeParse((req.body as { value?: unknown })?.value);
    if (!n.success) return reply.code(400).send({ error: "invalid_value" });
    await setSetting("max_concurrent", n.data);
    return { max_concurrent: n.data };
  });
  return app;
}
