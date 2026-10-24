import { execFile } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { redactString } from "../shared/redact.js";
import { truncate } from "../shared/util.js";
import type { HostConfig } from "./state.js";

export interface ScriptResult {
  exitCode: number;
  stdoutTail: string;
  stderrTail: string;
  timedOut: boolean;
}

/**
 * Runs an allowlisted script from <dataDir>/scripts with a scrubbed environment (no secrets),
 * a timeout, and truncated/redacted output.
 * NOTE: this is process-level isolation only. Run the host inside a container/VM for stronger isolation.
 */
export function runScript(dataDir: string, cfg: HostConfig, name: string, args: string[]): Promise<ScriptResult> {
  const def = cfg.scripts[name];
  if (!def) return Promise.reject(Object.assign(new Error(`Script not allowlisted: ${name}`), { code: "unknown_script", status: 404 }));
  const cwd = path.join(dataDir, "scripts");
  fs.mkdirSync(cwd, { recursive: true });
  const cmd = path.isAbsolute(def.cmd) ? def.cmd : path.join(cwd, def.cmd);
  return new Promise((resolve) => {
    execFile(
      cmd,
      [...(def.args ?? []), ...args],
      {
        cwd,
        timeout: (def.timeoutSec ?? 60) * 1000,
        maxBuffer: 1024 * 1024,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8", HOME: cwd },
      },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
        resolve({
          exitCode: e ? (typeof e.code === "number" ? e.code : 1) : 0,
          stdoutTail: redactString(truncate(String(stdout).slice(-8000), 8000)),
          stderrTail: redactString(truncate(String(stderr).slice(-4000), 4000)),
          timedOut: Boolean(e?.killed),
        });
      },
    );
  });
}
