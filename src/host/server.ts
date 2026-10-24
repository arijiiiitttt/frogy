import Fastify, { type FastifyInstance } from "fastify";
import fs from "node:fs";
import crypto from "node:crypto";
import { bearer, safeEqual, sha256Hex } from "../shared/util.js";
import { handleAction, type Ctx } from "./actions.js";
import { oauthStatus, revokeGoogle, startOAuthFlow } from "./google.js";
import { lenientJson } from "../shared/http.js";

/** Public-ish API (bind to loopback or your Tailscale/WireGuard IP). Bearer-token protected. */
export function buildApi(ctx: Ctx): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024 });
  lenientJson(app);
  app.addHook("onRequest", async (req, reply) => {
    const tok = bearer(req.headers.authorization);
    const want = ctx.state.loadConfig().apiTokenHash;
    if (!tok || !want || !safeEqual(sha256Hex(tok), want)) {
      await new Promise((r) => setTimeout(r, 250)); // slow down guessing
      return reply.code(401).send({ error: "unauthorized" });
    }
  });
  app.get("/status", async () => {
    let google = false;
    if (!ctx.vault.locked) google = Boolean(ctx.vault.read().google);
    return { ok: true, locked: ctx.vault.locked, googleConnected: google };
  });
  app.post<{ Params: { name: string }; Body: any }>("/actions/:name", async (req, reply) => {
    const r = await handleAction(ctx, req.params.name, ((req.body as unknown) ?? { input: {} }) as { input: unknown });
    return reply.code(r.status).send(r.body);
  });
  return app;
}

/** Admin API: loopback only + secret key file. Used by the local `frogy-host` CLI. */
export function buildAdmin(ctx: Ctx, opts: { adminKeyFile: string; oauthPort: number }): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
  lenientJson(app);
  const fails: { n: number; until: number } = { n: 0, until: 0 };
  app.addHook("onRequest", async (req, reply) => {
    const ip = req.ip;
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(ip)) return reply.code(403).send({ error: "loopback_only" });
    const key = String(req.headers["x-admin-key"] ?? "");
    const want = fs.readFileSync(opts.adminKeyFile, "utf8").trim();
    if (!key || !safeEqual(key, want)) return reply.code(401).send({ error: "unauthorized" });
  });
  app.get("/admin/status", async () => ({
    locked: ctx.vault.locked,
    google: ctx.vault.locked ? null : Boolean(ctx.vault.read().google),
    oauthClient: ctx.vault.locked ? null : Boolean(ctx.vault.read().oauthClient),
    pendingApprovals: ctx.state.listPending(),
    oauth: oauthStatus,
  }));
  app.post<{ Body: { passphrase?: string } }>("/admin/unlock", async (req, reply) => {
    if (Date.now() < fails.until) return reply.code(429).send({ error: "too_many_attempts" });
    try {
      ctx.vault.unlock(String(req.body?.passphrase ?? ""));
      fails.n = 0;
      ctx.audit.write({ action: "vault.unlock", status: "ok" });
      return { locked: false };
    } catch {
      fails.n++;
      if (fails.n >= 5) fails.until = Date.now() + 60_000;
      ctx.audit.write({ action: "vault.unlock", status: "failed" });
      return reply.code(401).send({ error: "wrong_passphrase" });
    }
  });
  app.post("/admin/lock", async () => {
    ctx.vault.lock();
    ctx.audit.write({ action: "vault.lock", status: "ok" });
    return { locked: true };
  });
  app.post<{ Body: { clientId?: string; clientSecret?: string } }>("/admin/oauth-client", async (req, reply) => {
    if (ctx.vault.locked) return reply.code(423).send({ error: "locked" });
    const { clientId, clientSecret } = req.body ?? {};
    if (!clientId || !clientSecret) return reply.code(400).send({ error: "missing_fields" });
    ctx.vault.update((d) => {
      d.oauthClient = { clientId, clientSecret };
    });
    return { ok: true };
  });
  app.post<{ Body: { drafts?: boolean } }>("/admin/google/start", async (req, reply) => {
    if (ctx.vault.locked) return reply.code(423).send({ error: "locked" });
    try {
      const url = startOAuthFlow(ctx.vault, { drafts: Boolean(req.body?.drafts), port: opts.oauthPort });
      ctx.audit.write({ action: "google.auth_start", status: "ok" });
      return { authUrl: url, callbackPort: opts.oauthPort };
    } catch (e) {
      return reply.code(409).send({ error: "cannot_start", message: (e as Error).message });
    }
  });
  app.post("/admin/google/revoke", async (_req, reply) => {
    if (ctx.vault.locked) return reply.code(423).send({ error: "locked" });
    await revokeGoogle(ctx.vault);
    ctx.audit.write({ action: "google.revoke", status: "ok" });
    return { revoked: true };
  });
  app.post<{ Params: { id: string } }>("/admin/approvals/:id/approve", async (req, reply) => {
    const a = ctx.state.setApproval(req.params.id, "approved");
    ctx.audit.write({ action: "approval.approve", status: a ? "ok" : "not_found", approvalId: req.params.id });
    return a ? a : reply.code(404).send({ error: "not_found" });
  });
  app.post<{ Params: { id: string } }>("/admin/approvals/:id/deny", async (req, reply) => {
    const a = ctx.state.setApproval(req.params.id, "denied");
    return a ? a : reply.code(404).send({ error: "not_found" });
  });
  app.post<{ Body: { entry?: string } }>("/admin/allow", async (req, reply) => {
    const e = String(req.body?.entry ?? "").trim().toLowerCase();
    if (!/^(@[a-z0-9.-]+\.[a-z]{2,}|[^@\s]+@[^@\s]+\.[a-z]{2,})$/.test(e)) return reply.code(400).send({ error: "bad_entry" });
    const c = ctx.state.loadConfig();
    if (!c.allowedRecipients.includes(e)) c.allowedRecipients.push(e);
    ctx.state.saveConfig(c);
    ctx.audit.write({ action: "allowlist.add", status: "ok", entry: e });
    return { allowedRecipients: c.allowedRecipients };
  });
  app.get("/admin/config", async () => {
    const { apiTokenHash: _h, ...rest } = ctx.state.loadConfig();
    return rest;
  });
  return app;
}

export function newToken(): string {
  return `frogy_${crypto.randomBytes(24).toString("base64url")}`;
}
