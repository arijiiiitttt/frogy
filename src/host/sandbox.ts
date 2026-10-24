import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { redactString } from "../shared/redact.js";
import { truncate } from "../shared/util.js";
import type { HostConfig } from "./state.js";

type Sb = NonNullable<HostConfig["sandbox"]>;
export interface SandboxResult {
  exitCode: number;
  stdoutTail: string;
  stderrTail: string;
  timedOut: boolean;
}

const WS = /^[a-z0-9][a-z0-9-]{7,63}$/;
const IMAGE = /^[a-z0-9][a-z0-9._\/:@-]{0,200}$/i;

export function validateSandboxCfg(sb: Sb): void {
  if (!IMAGE.test(sb.image)) throw new Error("invalid sandbox image");
  if (!/^\d+[mg]$/.test(sb.memory)) throw new Error("invalid sandbox memory (use e.g. 512m)");
  if (!/^\d+(\.\d+)?$/.test(sb.cpus)) throw new Error("invalid sandbox cpus");
  if (sb.network !== "none" && sb.network !== "bridge") throw new Error("invalid sandbox network");
}

/** Pure function: the exact `docker run` arguments. Fixed hardening flags; no host mounts; no secrets in env. */
export function buildDockerArgs(sb: Sb, workspace: string, command: string, name: string): string[] {
  validateSandboxCfg(sb);
  if (!WS.test(workspace)) throw new Error("invalid workspace name");
  return [
    "run", "--rm", "--name", name,
    "--network", sb.network,
    "--memory", sb.memory, "--memory-swap", sb.memory, "--cpus", sb.cpus, "--pids-limit", "256",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--read-only", "--tmpfs", "/tmp:rw,size=64m",
    "--user", "1000:1000",
    "-v", `frogy-ws-${workspace}:/workspace`, "-w", "/workspace",
    "-e", "HOME=/workspace",
    sb.image, "sh", "-c", command,
  ];
}

const dockerBin = () => process.env.DOCKER_BIN ?? "docker";
const dockerEnv = () => {
  const e: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
  for (const k of ["DOCKER_HOST", "XDG_RUNTIME_DIR", "HOME"]) if (process.env[k]) e[k] = process.env[k]!;
  return e;
};

function run(args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    execFile(dockerBin(), args, { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, env: dockerEnv() }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
      resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, stdout: String(stdout), stderr: String(stderr), timedOut: Boolean(e?.killed) });
    });
  });
}

/** First use of a workspace: create the volume and hand it to the unprivileged user. */
async function ensureWorkspace(dataDir: string, sb: Sb, workspace: string): Promise<void> {
  const file = path.join(dataDir, "workspaces.json");
  let known: string[] = [];
  try {
    known = JSON.parse(fs.readFileSync(file, "utf8")) as string[];
  } catch {
    /* none yet */
  }
  if (known.includes(workspace)) return;
  const vol = `frogy-ws-${workspace}`;
  await run(["volume", "create", vol], 20_000);
  await run(["run", "--rm", "--user", "0:0", "--network", "none", "--cap-drop", "ALL", "--cap-add", "CHOWN", "--security-opt", "no-new-privileges", "-v", `${vol}:/workspace`, sb.image, "chown", "1000:1000", "/workspace"], 60_000);
  fs.writeFileSync(file, JSON.stringify([...known, workspace].slice(-500)), { mode: 0o600 });
}

export async function sandboxExec(dataDir: string, cfg: HostConfig, workspace: string, command: string): Promise<SandboxResult> {
  const sb = cfg.sandbox;
  if (!sb) throw new Error("sandbox is not configured");
  const name = `frogy-${crypto.randomBytes(6).toString("hex")}`;
  const args = buildDockerArgs(sb, workspace, command, name); // validates everything first
  await ensureWorkspace(dataDir, sb, workspace);
  const r = await run(args, sb.timeoutSec * 1000);
  if (r.timedOut) await run(["rm", "-f", name], 15_000);
  return {
    exitCode: r.code,
    stdoutTail: redactString(truncate(r.stdout.slice(-8000), 8000)),
    stderrTail: redactString(truncate(r.stderr.slice(-4000), 4000)),
    timedOut: r.timedOut,
  };
}
