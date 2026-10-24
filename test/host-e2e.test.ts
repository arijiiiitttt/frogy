import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Fake Google (token + Gmail) server so no real credentials are ever needed in tests.
const sent: any[] = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/token") return res.end(JSON.stringify({ access_token: "ya29.fake", expires_in: 3600 }));
    if (req.url === "/gmail/v1/users/me/messages/send") {
      assert.equal(req.headers.authorization, "Bearer ya29.fake");
      sent.push(JSON.parse(body));
      return res.end(JSON.stringify({ id: `msg${sent.length}`, threadId: "t1" }));
    }
    if (req.url === "/gmail/v1/users/me/drafts") return res.end(JSON.stringify({ id: "draft1" }));
    res.statusCode = 404;
    res.end("{}");
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as any).port;
process.env.GMAIL_API_BASE = `http://127.0.0.1:${port}`;
process.env.GOOGLE_TOKEN_URL = `http://127.0.0.1:${port}/token`;

const { Vault } = await import("../src/host/vault.js");
const { HostState, defaultHostConfig } = await import("../src/host/state.js");
const { Audit, verifyAudit } = await import("../src/host/audit.js");
const { handleAction } = await import("../src/host/actions.js");

function setup(cfgPatch: Record<string, unknown> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "frogy-host-"));
  const state = new HostState(dir);
  state.saveConfig({ ...defaultHostConfig("x"), ...cfgPatch } as any);
  const vault = new Vault(state.p("vault.enc"));
  vault.init("a-long-test-passphrase");
  vault.update((d) => {
    d.oauthClient = { clientId: "cid", clientSecret: "csecret" };
    d.google = { refreshToken: "1//fake-refresh-token-value-1234567890", scopes: [], connectedAt: "now" };
  });
  return { dir, state, vault, audit: new Audit(state.p("audit.jsonl")) };
}
const mail = (to = "new@person.com", subject = "Hello") => ({ input: { to, subject, body: "Hi there" }, idempotencyKey: `k-${to}-${subject}`, taskId: "t1" });

test("dry run works without unlocking and never sends", async () => {
  const ctx = setup();
  ctx.vault.lock();
  const r = await handleAction(ctx, "email.send", { ...mail(), dryRun: true });
  assert.equal(r.status, 200);
  assert.equal((r.body as any).policy.decision, "needs_approval");
  assert.equal(sent.length, 0);
});

test("locked vault blocks real sends with 423", async () => {
  const ctx = setup({ requireApprovalForNewRecipients: false });
  ctx.vault.lock();
  const r = await handleAction(ctx, "email.send", mail());
  assert.equal(r.status, 423);
  assert.equal(r.body.error, "locked");
});

test("new recipient needs owner approval, then sends exactly once", async () => {
  const ctx = setup();
  const before = sent.length;
  const r1 = await handleAction(ctx, "email.send", mail("bob@x.com", "Approve me"));
  assert.equal(r1.status, 428);
  const id = r1.body.approvalId as string;
  assert.equal(sent.length, before);

  ctx.state.setApproval(id, "approved"); // what `frogy-host approve <id>` does
  const r2 = await handleAction(ctx, "email.send", mail("bob@x.com", "Approve me"));
  assert.equal(r2.status, 200);
  assert.equal(r2.body.sent, true);
  assert.equal(sent.length, before + 1);

  // Same idempotency key again (e.g. after a crash/retry) must NOT send twice.
  const r3 = await handleAction(ctx, "email.send", mail("bob@x.com", "Approve me"));
  assert.equal(r3.body.replayed, true);
  assert.equal(sent.length, before + 1);

  // A different message to the same person needs a fresh approval (approval was single-use).
  const r4 = await handleAction(ctx, "email.send", { ...mail("bob@x.com", "Another"), idempotencyKey: "other" });
  assert.equal(r4.status, 428);
});

test("allowlisted recipients send without approval; daily cap enforced", async () => {
  const ctx = setup({ allowedRecipients: ["@corp.io"], dailyCaps: { "email.send": 2 } });
  const a = await handleAction(ctx, "email.send", { ...mail("a@corp.io", "1"), idempotencyKey: "1" });
  const b = await handleAction(ctx, "email.send", { ...mail("a@corp.io", "2"), idempotencyKey: "2" });
  const c = await handleAction(ctx, "email.send", { ...mail("a@corp.io", "3"), idempotencyKey: "3" });
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(c.status, 429);
  assert.equal(c.body.error, "daily_cap");
});

test("too many recipients and header injection are rejected", async () => {
  const ctx = setup({ allowedRecipients: ["@corp.io"], maxRecipientsPerMessage: 2 });
  const many = await handleAction(ctx, "email.send", { input: { to: "a@corp.io,b@corp.io,c@corp.io", subject: "s", body: "b" } });
  assert.equal(many.status, 403);
  const inj = await handleAction(ctx, "email.send", { input: { to: "a@corp.io", subject: "s\r\nBcc: x@y.com", body: "b" } });
  assert.equal(inj.status, 400);
});

test("drafts need no approval and do not count toward the send cap", async () => {
  const ctx = setup();
  const r = await handleAction(ctx, "email.send", { input: { to: "stranger@x.com", subject: "d", body: "b", draft: true }, idempotencyKey: "d1" });
  assert.equal(r.status, 200);
  assert.equal(r.body.drafted, true);
  assert.equal(ctx.state.count("email.send"), 0);
});

test("browser actions are disabled by default; unknown scripts refused", async () => {
  const ctx = setup();
  const ig = await handleAction(ctx, "instagram.unfollow", { input: { username: "someone" } });
  assert.equal(ig.status, 403);
  assert.equal(ig.body.error, "disabled");
  const sc = await handleAction(ctx, "script.run", { input: { name: "rm-everything" } });
  assert.equal(sc.status, 404);
});

test("allowlisted script runs with a scrubbed environment (no secrets leak)", async () => {
  const ctx = setup({ scripts: { envcheck: { cmd: "/usr/bin/env" } } });
  process.env.SUPER_SECRET_KEY = "leak-me";
  const r = await handleAction(ctx, "script.run", { input: { name: "envcheck" }, idempotencyKey: "s1" });
  assert.equal(r.status, 200);
  assert.ok(!String(r.body.stdoutTail).includes("leak-me"));
  assert.ok(!String(r.body.stdoutTail).includes("SUPER_SECRET_KEY"));
});

test("audit log never contains message bodies or tokens and stays intact", async () => {
  const ctx = setup({ allowedRecipients: ["@corp.io"] });
  await handleAction(ctx, "email.send", { input: { to: "a@corp.io", subject: "audit me", body: "TOP-SECRET-BODY" }, idempotencyKey: "au1" });
  const log = fs.readFileSync(ctx.state.p("audit.jsonl"), "utf8");
  assert.ok(!log.includes("TOP-SECRET-BODY"));
  assert.ok(!log.includes("fake-refresh-token"));
  assert.equal(verifyAudit(ctx.state.p("audit.jsonl")), -1);
});

test("sandbox.exec: disabled by default; when enabled it runs via docker and obeys caps and dry-run", async () => {
  const ctx = setup();
  const off = await handleAction(ctx, "sandbox.exec", { input: { workspace: "ws-12345678", command: "ls" } });
  assert.equal(off.status, 403);
  assert.equal(off.body.error, "disabled");

  const bin = path.join(ctx.dir, "docker");
  fs.writeFileSync(bin, "#!/bin/sh\necho ran-in-sandbox\n", { mode: 0o755 });
  process.env.DOCKER_BIN = bin;
  try {
    const on = setup({ enabled: { "sandbox.exec": true }, dailyCaps: { "sandbox.exec": 1 } });
    fs.writeFileSync(path.join(on.dir, "docker"), "#!/bin/sh\necho ran-in-sandbox\n", { mode: 0o755 });
    process.env.DOCKER_BIN = path.join(on.dir, "docker");
    const dry = await handleAction(on, "sandbox.exec", { input: { workspace: "ws-12345678", command: "rm -rf /" }, dryRun: true });
    assert.equal(dry.status, 200);
    assert.equal((dry.body as any).preview.network, "none");
    const ok = await handleAction(on, "sandbox.exec", { input: { workspace: "ws-12345678", command: "echo hi" }, idempotencyKey: "sb1" });
    assert.equal(ok.status, 200);
    assert.match(String(ok.body.stdoutTail), /ran-in-sandbox/);
    const capped = await handleAction(on, "sandbox.exec", { input: { workspace: "ws-12345678", command: "echo 2" }, idempotencyKey: "sb2" });
    assert.equal(capped.status, 429);
    const bad = await handleAction(on, "sandbox.exec", { input: { workspace: "../../etc", command: "x" } });
    assert.equal(bad.status, 400);
  } finally {
    delete process.env.DOCKER_BIN;
  }
});

test.after(() => server.close());
