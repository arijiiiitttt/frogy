import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const cfgDir = path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "frogy");
const cfgFile = path.join(cfgDir, "config.json");

export interface CliConfig {
  url: string;
  token: string;
}

export function loadCfg(): CliConfig {
  const url = process.env.FROGY_URL;
  const token = process.env.FROGY_TOKEN;
  if (url && token) return { url, token };
  try {
    return JSON.parse(fs.readFileSync(cfgFile, "utf8")) as CliConfig;
  } catch {
    console.error("Not logged in. Run: frogy login --url https://YOUR-APP.onrender.com --token <API_TOKEN or ADMIN_TOKEN>");
    process.exit(1);
  }
}

export function saveCfg(c: CliConfig): void {
  fs.mkdirSync(cfgDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(cfgFile, JSON.stringify(c), { mode: 0o600 }); // TIP: prefer FROGY_TOKEN from your OS keychain / password manager
}

export async function api(method: string, p: string, body?: unknown): Promise<any> {
  const { url, token } = loadCfg();
  let res: Response;
  try {
    res = await fetch(`${url.replace(/\/$/, "")}${p}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      // Free-tier instances may need ~1 min to wake: be patient.
      signal: AbortSignal.timeout(90_000),
    });
  } catch (e) {
    console.error(`Cannot reach controller: ${(e as Error).message}`);
    process.exit(1);
  }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`Error ${res.status}: ${j.message ?? j.error ?? "request failed"}`);
    process.exit(1);
  }
  return j;
}
