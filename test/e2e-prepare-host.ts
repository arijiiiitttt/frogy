// Non-interactive host init for the e2e script (the real flow uses `frogy-host init`, which prompts).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Vault } from "../src/host/vault.js";
import { HostState, defaultHostConfig } from "../src/host/state.js";
import { sha256Hex } from "../src/shared/util.js";
const dir = path.resolve(process.argv[2]!);
const state = new HostState(dir);
const vault = new Vault(state.p("vault.enc"));
vault.init("e2e-test-passphrase-123");
vault.update((d) => {
  d.oauthClient = { clientId: "cid", clientSecret: "cs" };
  d.google = { refreshToken: "1//e2e-fake-refresh-token-0123456789", scopes: [], connectedAt: new Date().toISOString() };
});
fs.writeFileSync(path.join(dir, "admin.key"), crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
const token = "frogy_e2e_host_token";
state.saveConfig({ ...defaultHostConfig(sha256Hex(token)), allowedRecipients: ["@corp.io"] });
