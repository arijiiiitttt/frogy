import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { redact, redactString } from "../src/shared/redact.js";
import { Vault, VaultLocked } from "../src/host/vault.js";
import { buildMime } from "../src/host/google.js";
import { recipientAllowed } from "../src/host/actions.js";
import { Audit, verifyAudit } from "../src/host/audit.js";
import { validateInput } from "../src/actions/registry.js";
import { Gateway } from "../src/gateway/router.js";
import { ProviderError, type Adapter, type GatewayConfig } from "../src/gateway/types.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "frogy-"));

test("redaction scrubs tokens, keys and sensitive fields", () => {
  const s = redactString("Authorization: Bearer abc.def.ghi and ya29.A0ARrdaM-secretvalue and sk-abcdefghijklmnopqrstuv");
  assert.ok(!s.includes("abc.def.ghi") && !s.includes("secretvalue") && !s.includes("abcdefghijklmnopqrstuv"));
  const o = redact({ user: "x", refreshToken: "1//0gABCDEFGHIJKLMNOPQRSTUVWXYZ", nested: { client_secret: "GOCSPX-zzz", ok: "fine" } }) as any;
  assert.equal(o.refreshToken, "[REDACTED]");
  assert.equal(o.nested.client_secret, "[REDACTED]");
  assert.equal(o.nested.ok, "fine");
});

test("vault: encrypts at rest, wrong passphrase fails, lock wipes memory", () => {
  const file = path.join(tmp(), "vault.enc");
  const v = new Vault(file);
  assert.throws(() => v.init("short"));
  v.init("correct horse battery staple");
  v.update((d) => {
    d.google = { refreshToken: "1//SUPER-SECRET-REFRESH-TOKEN-VALUE", scopes: ["x"], connectedAt: "now" };
  });
  const raw = fs.readFileSync(file, "utf8");
  assert.ok(!raw.includes("SUPER-SECRET"), "plaintext token must not appear on disk");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  const v2 = new Vault(file);
  assert.ok(v2.locked);
  assert.throws(() => v2.read(), VaultLocked);
  assert.throws(() => v2.unlock("wrong passphrase here"), /Wrong passphrase/);
  v2.unlock("correct horse battery staple");
  assert.equal(v2.read().google?.refreshToken, "1//SUPER-SECRET-REFRESH-TOKEN-VALUE");
  v2.lock();
  assert.ok(v2.locked);
  assert.throws(() => v2.read(), VaultLocked);

  // tampering is detected (GCM auth tag)
  const j = JSON.parse(raw);
  j.data = Buffer.from("tampered-ciphertext").toString("base64");
  fs.writeFileSync(file, JSON.stringify(j));
  assert.throws(() => new Vault(file).unlock("correct horse battery staple"));
});

test("mime: blocks header injection and encodes non-ASCII subjects", () => {
  assert.throws(() => buildMime({ to: ["a@b.com"], subject: "Hi\r\nBcc: evil@x.com", body: "x" }));
  assert.throws(() => buildMime({ to: ["a@b.com\r\nBcc: e@x.com"], subject: "Hi", body: "x" }));
  const m = buildMime({ to: ["a@b.com"], subject: "Héllo ✓", body: "text" });
  assert.match(m, /Subject: =\?UTF-8\?B\?/);
  assert.match(m, /To: a@b.com/);
});

test("action schemas: validate and coerce CLI-style input", () => {
  const ok = validateInput("email.send", { to: "a@b.com, c@d.com", subject: "s", body: "b", draft: "true" });
  assert.ok(ok.ok);
  assert.deepEqual((ok as any).value.to, ["a@b.com", "c@d.com"]);
  assert.equal((ok as any).value.draft, true);
  assert.equal(validateInput("email.send", { to: "not-an-email", subject: "s", body: "b" }).ok, false);
  assert.equal(validateInput("email.send", { to: "a@b.com", subject: "x\nBcc: y@z.com", body: "b" }).ok, false);
  assert.equal(validateInput("nope", {}).ok, false);
  assert.equal(validateInput("instagram.unfollow", { username: "bad name!" }).ok, false);
});

test("recipient allowlist: exact and @domain entries", () => {
  assert.ok(recipientAllowed("Bob@Example.com", ["bob@example.com"]));
  assert.ok(recipientAllowed("anyone@corp.io", ["@corp.io"]));
  assert.ok(!recipientAllowed("anyone@evilcorp.io", ["@corp.io"]));
  assert.ok(!recipientAllowed("x@y.com", []));
});

test("audit log is hash-chained and tamper-evident; secrets are redacted", () => {
  const f = path.join(tmp(), "audit.jsonl");
  const a = new Audit(f);
  a.write({ action: "email.send", status: "sent", refreshToken: "1//AAAAAAAAAAAAAAAAAAAAAAAA" });
  a.write({ action: "email.send", status: "sent" });
  assert.equal(verifyAudit(f), -1);
  assert.ok(!fs.readFileSync(f, "utf8").includes("AAAAAAAAAAAAAAAAAAAAAAAA"));
  const lines = fs.readFileSync(f, "utf8").trim().split("\n");
  lines[0] = lines[0]!.replace("sent", "deleted");
  fs.writeFileSync(f, lines.join("\n") + "\n");
  assert.notEqual(verifyAudit(f), -1);
});

const cfg: GatewayConfig = {
  providers: { a: { type: "openai-compat", keyEnv: "KA" }, b: { type: "anthropic", keyEnv: "KB" }, or: { type: "openai-compat", keyEnv: "KOR" } },
  tiers: { cheap: ["a/m1", "a/REPLACE_ME", "b/m2"], mid: [], strong: ["b/m3"] },
  fallbackVia: "or",
  timeoutMs: 1000,
};
const keys = (n: string) => ({ KA: "ka", KB: "kb", KOR: "kor" } as Record<string, string>)[n];

test("gateway: fails over on 429, skips placeholders, trips breaker, falls back via OpenRouter", async () => {
  const calls: string[] = [];
  const adapter: Adapter = async (_c, _k, model) => {
    calls.push(model);
    if (model === "m1") throw new ProviderError(429, "rate limited");
    return { text: `ok:${model}`, inputTokens: 5, outputTokens: 3 };
  };
  const gw = new Gateway(cfg, { adapters: { "openai-compat": adapter, anthropic: adapter }, getKey: keys });
  const r = await gw.chat({ messages: [{ role: "user", content: "hi" }], tier: "cheap" });
  assert.equal(r.model, "m2");
  assert.match(r.switchReason ?? "", /failover after a\/m1/);
  assert.ok(!calls.includes("REPLACE_ME"));
});

test("gateway: non-retryable (401) errors skip to next model without retries", async () => {
  let n = 0;
  const adapter: Adapter = async (_c, _k, model) => {
    n++;
    if (model === "m1") throw new ProviderError(401, "bad key");
    return { text: "ok", inputTokens: 1, outputTokens: 1 };
  };
  const gw = new Gateway(cfg, { adapters: { "openai-compat": adapter, anthropic: adapter }, getKey: keys });
  const r = await gw.chat({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(r.model, "m2");
  assert.equal(n, 2); // m1 once (no retry), m2 once
});

test("gateway: OpenRouter is only a last resort for the same model", async () => {
  const adapter: Adapter = async (c, _k, model) => {
    if (c.keyEnv !== "KOR") throw new ProviderError(503, "down");
    return { text: `via-or:${model}`, inputTokens: 1, outputTokens: 1 };
  };
  const gw = new Gateway({ ...cfg, aliases: { "a/m1": "vendor/m1-alias" } }, { adapters: { "openai-compat": adapter, anthropic: adapter }, getKey: keys });
  const r = await gw.chat({ messages: [{ role: "user", content: "hi" }], tier: "cheap" });
  assert.equal(r.via, "openrouter");
  assert.equal(r.model, "vendor/m1-alias");
});

test("gateway: no usable models gives a clear error", async () => {
  const gw = new Gateway(cfg, { adapters: {}, getKey: () => undefined });
  await assert.rejects(gw.chat({ messages: [{ role: "user", content: "hi" }] }), /No usable models/);
});
