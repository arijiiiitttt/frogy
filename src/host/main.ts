#!/usr/bin/env node
import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ask } from "../shared/prompt.js";
import { env, intEnv, sha256Hex } from "../shared/util.js";
import { alert } from "../shared/alerts.js";
import { Vault } from "./vault.js";
import { defaultHostConfig, HostState } from "./state.js";
import { Audit, verifyAudit } from "./audit.js";
import { buildAdmin, buildApi, newToken } from "./server.js";

const dataDir = path.resolve(env("HOST_DATA_DIR", "./host-data")!);
const adminPort = intEnv("HOST_ADMIN_PORT", 8788);
const adminKeyFile = path.join(dataDir, "admin.key");

async function admin(method: "GET" | "POST", p: string, body?: unknown): Promise<any> {
  const key = fs.readFileSync(adminKeyFile, "utf8").trim();
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${adminPort}${p}`, {
      method,
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), "x-admin-key": key },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    console.error("Cannot reach the host. Is `frogy-host serve` running?");
    process.exit(1);
  }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`Error ${res.status}:`, j);
    process.exit(1);
  }
  return j;
}

const program = new Command("frogy-host").description("Frogy sandbox host: credential broker + action executor");

program
  .command("init")
  .description("Create the encrypted vault, admin key, and API token (run once)")
  .action(async () => {
    const state = new HostState(dataDir);
    const vault = new Vault(state.p("vault.enc"));
    if (vault.exists()) return console.error("Already initialised.");
    const p1 = await ask("Choose a vault passphrase (min 12 chars): ", true);
    const p2 = await ask("Repeat passphrase: ", true);
    if (p1 !== p2) return console.error("Passphrases do not match.");
    vault.init(p1);
    fs.writeFileSync(adminKeyFile, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
    const token = newToken();
    state.saveConfig(defaultHostConfig(sha256Hex(token)));
    console.log("\nVault created. Files are in", dataDir);
    console.log("\nHOST_TOKEN (shown ONCE — set it as a secret env var on the controller):\n");
    console.log(`  ${token}\n`);
    console.log("Next: frogy-host serve   (then in another terminal: frogy-host unlock)");
  });

program
  .command("serve")
  .description("Run the host (starts LOCKED unless FROGY_HOST_PASSPHRASE is set — weaker, see docs)")
  .action(async () => {
    const state = new HostState(dataDir);
    const vault = new Vault(state.p("vault.enc"));
    if (!vault.exists() || !fs.existsSync(adminKeyFile)) return console.error("Run `frogy-host init` first.");
    const audit = new Audit(state.p("audit.jsonl"));
    const ctx = { vault, state, audit };
    if (env("FROGY_HOST_PASSPHRASE")) {
      vault.unlock(env("FROGY_HOST_PASSPHRASE")!);
      console.warn("Auto-unlocked from FROGY_HOST_PASSPHRASE (weaker mode).");
    }
    const bind = env("HOST_BIND", "127.0.0.1")!;
    const port = intEnv("HOST_PORT", 8787);
    const api = buildApi(ctx);
    const adm = buildAdmin(ctx, { adminKeyFile, oauthPort: intEnv("GOOGLE_OAUTH_PORT", 8789) });
    await api.listen({ host: bind, port });
    await adm.listen({ host: "127.0.0.1", port: adminPort });
    console.log(`Host API on http://${bind}:${port} (bearer token) | admin on 127.0.0.1:${adminPort} (loopback + key file)`);
    console.log(vault.locked ? "Vault is LOCKED. Run: frogy-host unlock" : "Vault is unlocked.");
    audit.write({ action: "host.start", status: "ok", locked: vault.locked });
    if (vault.locked) void alert("host-start-locked", "Host started and is LOCKED. Tasks needing credentials are paused until you run: frogy-host unlock", 60 * 60_000);
    const stop = () => {
      vault.lock();
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });

program.command("unlock").description("Unlock the vault (prompts for passphrase)").action(async () => {
  const passphrase = await ask("Vault passphrase: ", true);
  console.log(await admin("POST", "/admin/unlock", { passphrase }));
});
program.command("lock").description("Lock the vault (wipes the key from memory)").action(async () => console.log(await admin("POST", "/admin/lock")));
program.command("status").action(async () => console.log(JSON.stringify(await admin("GET", "/admin/status"), null, 2)));

program.command("set-oauth-client").description("Store your Google OAuth client (type: Desktop app) in the encrypted vault").action(async () => {
  const clientId = (await ask("Google OAuth client ID: ")).trim();
  const clientSecret = (await ask("Google OAuth client secret: ", true)).trim();
  console.log(await admin("POST", "/admin/oauth-client", { clientId, clientSecret }));
});

program
  .command("auth-google")
  .description("Connect your Google account (send-only scope by default)")
  .option("--drafts", "also request gmail.compose so --draft works")
  .action(async (o: { drafts?: boolean }) => {
    const r = await admin("POST", "/admin/google/start", { drafts: Boolean(o.drafts) });
    console.log(`\nOpen this URL in a browser ON THE HOST (or forward port ${r.callbackPort} over SSH):\n\n${r.authUrl}\n`);
    for (let i = 0; i < 150; i++) {
      await new Promise((res) => setTimeout(res, 2000));
      const s = await admin("GET", "/admin/status");
      if (s.oauth.state === "done" && s.google) return console.log("Google connected. Token is stored encrypted in the vault.");
      if (s.oauth.state === "error") return console.error("Failed:", s.oauth.message);
    }
    console.error("Timed out.");
  });

program.command("revoke-google").description("Revoke the token at Google and delete it locally").action(async () => console.log(await admin("POST", "/admin/google/revoke")));
program.command("approvals").description("List pending approvals").action(async () => {
  const s = await admin("GET", "/admin/status");
  console.log(s.pendingApprovals.length ? s.pendingApprovals : "No pending approvals.");
});
program.command("approve <id>").action(async (id: string) => console.log(await admin("POST", `/admin/approvals/${id}/approve`)));
program.command("deny <id>").action(async (id: string) => console.log(await admin("POST", `/admin/approvals/${id}/deny`)));
program.command("allow <entry>").description("Allow a recipient (a@b.com) or domain (@b.com) without approval").action(async (e: string) => console.log(await admin("POST", "/admin/allow", { entry: e })));
program.command("config").description("Show host policy config").action(async () => console.log(JSON.stringify(await admin("GET", "/admin/config"), null, 2)));
program.command("verify-audit").description("Verify the audit log hash chain").action(() => {
  const bad = verifyAudit(path.join(dataDir, "audit.jsonl"));
  console.log(bad === -1 ? "Audit log intact." : `TAMPERING DETECTED at line ${bad + 1}`);
  process.exit(bad === -1 ? 0 : 2);
});

program.parseAsync().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
