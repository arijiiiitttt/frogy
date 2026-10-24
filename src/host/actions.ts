import { EmailSendInput, SandboxExecInput, ScriptRunInput, validateInput } from "../actions/registry.js";
import { sha256Hex, stableStringify } from "../shared/util.js";
import { alert } from "../shared/alerts.js";
import { Vault, VaultLocked } from "./vault.js";
import { HostState, type HostConfig } from "./state.js";
import { Audit } from "./audit.js";
import { createDraft, GoogleError, sendEmail } from "./google.js";
import { runScript } from "./scripts.js";
import { sandboxExec } from "./sandbox.js";

export interface Ctx {
  vault: Vault;
  state: HostState;
  audit: Audit;
}
export interface Reply {
  status: number;
  body: Record<string, unknown>;
}
interface Call {
  input: unknown;
  dryRun?: boolean;
  idempotencyKey?: string;
  taskId?: string;
}

const err = (status: number, code: string, message: string, extra: Record<string, unknown> = {}): Reply => ({
  status,
  body: { error: code, message, ...extra },
});

export function recipientAllowed(addr: string, allow: string[]): boolean {
  const a = addr.toLowerCase();
  return allow.some((e) => {
    const x = e.toLowerCase();
    return x.startsWith("@") ? a.endsWith(x) : a === x;
  });
}

export async function handleAction(ctx: Ctx, name: string, call: Call): Promise<Reply> {
  const cfg = ctx.state.loadConfig();
  const v = validateInput(name, call.input);
  if (!v.ok) return err(400, "invalid_input", v.error);
  const dryRun = Boolean(call.dryRun);
  const audit = (status: string, extra: Record<string, unknown> = {}) =>
    ctx.audit.write({ action: name, status, dryRun, taskId: call.taskId, ...extra });

  try {
    if (name === "email.send") return await emailSend(ctx, cfg, EmailSendInput.parse(call.input), call, dryRun, audit);
    if (name === "script.run") return await scriptRun(ctx, cfg, ScriptRunInput.parse(call.input), call, dryRun, audit);
    if (name === "sandbox.exec") return await sandboxRun(ctx, cfg, SandboxExecInput.parse(call.input), call, dryRun, audit);
    if (name === "instagram.unfollow" || name === "linkedin.remove_connection") {
      if (cfg.enabled[name] !== true) {
        audit("denied_disabled");
        return err(403, "disabled", `${name} is disabled. It violates the platform's terms and can get your account restricted. Enable it explicitly in host config only if you accept that risk.`);
      }
      audit("not_implemented");
      return err(501, "not_implemented", "Browser automation is not included in this scaffold. See docs/BROWSER_ACTIONS.md.");
    }
    return err(404, "unknown_action", `Unknown action ${name}`);
  } catch (e) {
    if (e instanceof VaultLocked) return err(423, "locked", "Credential vault is locked. Run: frogy-host unlock");
    if (e instanceof GoogleError) {
      audit("google_error", { code: e.code });
      if (e.code === "token_invalid" || e.code === "token_refresh_failed") void alert("google-token", `Google token problem (${e.code}). Tasks paused until re-auth: frogy-host auth-google`);
      return err(e.status, e.code, e.message);
    }
    audit("error", { message: (e as Error).message });
    return err(500, "internal_error", "Internal error");
  }
}

async function emailSend(ctx: Ctx, cfg: HostConfig, input: ReturnType<typeof EmailSendInput.parse>, call: Call, dryRun: boolean, audit: (s: string, x?: Record<string, unknown>) => void): Promise<Reply> {
  const name = "email.send";
  const to = input.to as string[];
  if (to.length > cfg.maxRecipientsPerMessage) {
    audit("denied_too_many_recipients", { count: to.length });
    return err(403, "too_many_recipients", `Max ${cfg.maxRecipientsPerMessage} recipients per message`);
  }
  const unknown = to.filter((r) => !recipientAllowed(r, cfg.allowedRecipients));
  const needsApproval = !input.draft && unknown.length > 0 && cfg.requireApprovalForNewRecipients;
  const inputHash = sha256Hex(stableStringify({ name, input: { to: [...to].sort(), subject: input.subject, body: input.body } }));

  if (dryRun) {
    return {
      status: 200,
      body: {
        dryRun: true,
        preview: { to, subject: input.subject, bodyPreview: input.body.slice(0, 200), bytes: Buffer.byteLength(input.body), draft: Boolean(input.draft) },
        policy: { decision: needsApproval ? "needs_approval" : "allow", unknownRecipients: unknown, sentToday: ctx.state.count(name), dailyCap: cfg.dailyCaps[name] },
      },
    };
  }

  const idemKey = call.idempotencyKey ? `${name}:${call.idempotencyKey}` : undefined;
  if (idemKey) {
    const prev = ctx.state.getIdem(idemKey);
    if (prev) {
      audit("replayed", { idempotencyKey: call.idempotencyKey });
      return { status: 200, body: { ...prev, replayed: true } };
    }
  }

  ctx.vault.read(); // throws VaultLocked when locked

  if (!input.draft) {
    const cap = cfg.dailyCaps[name] ?? 50;
    if (ctx.state.count(name) >= cap) {
      audit("denied_daily_cap", { cap });
      return err(429, "daily_cap", `Daily cap of ${cap} reached for ${name}`);
    }
    if (needsApproval) {
      const ap = ctx.state.findApproval(name, inputHash);
      if (ap?.status === "approved") {
        ctx.state.setApproval(ap.id, "used");
      } else if (ap?.status === "denied") {
        audit("denied_by_owner", { approvalId: ap.id });
        return err(403, "denied", "The owner denied this action");
      } else {
        const a = ap ?? ctx.state.createApproval(name, inputHash, `email to ${to.join(", ")} — "${input.subject.slice(0, 60)}"`);
        audit("needs_approval", { approvalId: a.id });
        void alert(`approval-${a.id}`, `Approval needed (${a.id}): ${a.summary}. On the host run: frogy-host approve ${a.id}`);
        return err(428, "needs_approval", "Owner approval required for new recipient(s)", { approvalId: a.id });
      }
    }
  }

  const sent = input.draft ? await createDraft(ctx.vault, { to, subject: input.subject, body: input.body }) : await sendEmail(ctx.vault, { to, subject: input.subject, body: input.body });
  if (!input.draft) ctx.state.incr(name);
  const result = { sent: !input.draft, drafted: Boolean(input.draft), messageId: sent.id, threadId: sent.threadId };
  if (idemKey) ctx.state.putIdem(idemKey, result);
  audit(input.draft ? "drafted" : "sent", { to, subject: input.subject.slice(0, 80), messageId: sent.id });
  return { status: 200, body: result };
}

async function scriptRun(ctx: Ctx, cfg: HostConfig, input: ReturnType<typeof ScriptRunInput.parse>, call: Call, dryRun: boolean, audit: (s: string, x?: Record<string, unknown>) => void): Promise<Reply> {
  const name = "script.run";
  const def = cfg.scripts[input.name];
  if (!def) return err(404, "unknown_script", `Script not allowlisted: ${input.name}`);
  if (dryRun) return { status: 200, body: { dryRun: true, preview: { script: input.name, cmd: def.cmd, args: input.args ?? [] } } };
  const idemKey = call.idempotencyKey ? `${name}:${call.idempotencyKey}` : undefined;
  if (idemKey) {
    const prev = ctx.state.getIdem(idemKey);
    if (prev) return { status: 200, body: { ...prev, replayed: true } };
  }
  const cap = cfg.dailyCaps[name] ?? 200;
  if (ctx.state.count(name) >= cap) return err(429, "daily_cap", `Daily cap of ${cap} reached for ${name}`);
  const r = await runScript(ctx.state.dir, cfg, input.name, (input.args as string[] | undefined) ?? []);
  ctx.state.incr(name);
  if (idemKey) ctx.state.putIdem(idemKey, { ...r });
  audit(r.exitCode === 0 ? "ran" : "ran_failed", { script: input.name, exitCode: r.exitCode });
  return { status: 200, body: { ...r } };
}

async function sandboxRun(ctx: Ctx, cfg: HostConfig, input: ReturnType<typeof SandboxExecInput.parse>, call: Call, dryRun: boolean, audit: (s: string, x?: Record<string, unknown>) => void): Promise<Reply> {
  const name = "sandbox.exec";
  if (cfg.enabled[name] !== true) {
    audit("denied_disabled");
    return err(403, "disabled", "sandbox.exec is disabled on this host. It needs Docker; enable it in host config (enabled.\"sandbox.exec\": true).");
  }
  if (dryRun) return { status: 200, body: { dryRun: true, preview: { workspace: input.workspace, command: input.command.slice(0, 500), network: cfg.sandbox?.network ?? "none" } } };
  const idemKey = call.idempotencyKey ? `${name}:${call.idempotencyKey}` : undefined;
  if (idemKey) {
    const prev = ctx.state.getIdem(idemKey);
    if (prev) return { status: 200, body: { ...prev, replayed: true } };
  }
  const cap = cfg.dailyCaps[name] ?? 200;
  if (ctx.state.count(name) >= cap) return err(429, "daily_cap", `Daily cap of ${cap} reached for ${name}`);
  const r = await sandboxExec(ctx.state.dir, cfg, input.workspace, input.command);
  ctx.state.incr(name);
  if (idemKey) ctx.state.putIdem(idemKey, { ...r });
  audit(r.exitCode === 0 ? "ran" : "ran_failed", { workspace: input.workspace, command: input.command.slice(0, 200), exitCode: r.exitCode });
  return { status: 200, body: { ...r } };
}
