import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}
function writeJson(file: string, value: unknown): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export interface Approval {
  id: string;
  action: string;
  inputHash: string;
  summary: string;
  status: "pending" | "approved" | "used" | "denied";
  createdAt: string;
}

export interface HostConfig {
  apiTokenHash: string;
  allowedRecipients: string[];
  requireApprovalForNewRecipients: boolean;
  maxRecipientsPerMessage: number;
  dailyCaps: Record<string, number>;
  /** Risky actions are OFF unless explicitly set to true. */
  enabled: Record<string, boolean>;
  scripts: Record<string, { cmd: string; args?: string[]; timeoutSec?: number }>;
  sandbox?: { image: string; memory: string; cpus: string; timeoutSec: number; network: "none" | "bridge" };
}

export const defaultHostConfig = (apiTokenHash: string): HostConfig => ({
  apiTokenHash,
  allowedRecipients: [],
  requireApprovalForNewRecipients: true,
  maxRecipientsPerMessage: 5,
  dailyCaps: { "email.send": 50, "script.run": 200, "sandbox.exec": 200, "instagram.unfollow": 20, "linkedin.remove_connection": 10 },
  enabled: { "instagram.unfollow": false, "linkedin.remove_connection": false, "sandbox.exec": false },
  scripts: {},
  sandbox: { image: "debian:stable-slim", memory: "512m", cpus: "1", timeoutSec: 60, network: "none" },
});

const APPROVAL_TTL_MS = 24 * 3600_000;

/** File-backed host state: config, daily counters, approvals, idempotency records. */
export class HostState {
  readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  p = (f: string) => path.join(this.dir, f);

  loadConfig(): HostConfig {
    return readJson<HostConfig>(this.p("config.json"), defaultHostConfig(""));
  }
  saveConfig(c: HostConfig): void {
    writeJson(this.p("config.json"), c);
  }

  // ---- daily counters (UTC day) ----
  private day = () => new Date().toISOString().slice(0, 10);
  count(action: string): number {
    const c = readJson<Record<string, Record<string, number>>>(this.p("counters.json"), {});
    return c[this.day()]?.[action] ?? 0;
  }
  incr(action: string): void {
    const c = readJson<Record<string, Record<string, number>>>(this.p("counters.json"), {});
    const d = this.day();
    const keep: Record<string, Record<string, number>> = { [d]: c[d] ?? {} };
    keep[d]![action] = (keep[d]![action] ?? 0) + 1;
    writeJson(this.p("counters.json"), keep);
  }

  // ---- idempotency ----
  getIdem(key: string): Record<string, unknown> | undefined {
    const m = readJson<Record<string, Record<string, unknown>>>(this.p("idempotency.json"), {});
    return m[key];
  }
  putIdem(key: string, result: Record<string, unknown>): void {
    const m = readJson<Record<string, Record<string, unknown>>>(this.p("idempotency.json"), {});
    m[key] = result;
    const keys = Object.keys(m);
    if (keys.length > 5000) for (const k of keys.slice(0, keys.length - 5000)) delete m[k];
    writeJson(this.p("idempotency.json"), m);
  }

  // ---- approvals ----
  private approvals(): Approval[] {
    const now = Date.now();
    return readJson<Approval[]>(this.p("approvals.json"), []).filter((a) => now - Date.parse(a.createdAt) < APPROVAL_TTL_MS);
  }
  findApproval(action: string, inputHash: string): Approval | undefined {
    return this.approvals().find((a) => a.action === action && a.inputHash === inputHash && a.status !== "used");
  }
  createApproval(action: string, inputHash: string, summary: string): Approval {
    const list = this.approvals();
    const a: Approval = {
      id: crypto.randomBytes(4).toString("hex"),
      action,
      inputHash,
      summary,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    list.push(a);
    writeJson(this.p("approvals.json"), list);
    return a;
  }
  setApproval(id: string, status: Approval["status"]): Approval | undefined {
    const list = this.approvals();
    const a = list.find((x) => x.id === id);
    if (!a) return undefined;
    a.status = status;
    writeJson(this.p("approvals.json"), list);
    return a;
  }
  listPending(): Approval[] {
    return this.approvals().filter((a) => a.status === "pending");
  }
}
