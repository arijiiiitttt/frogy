import fs from "node:fs";
import crypto from "node:crypto";
import { redact } from "../shared/redact.js";

/** Append-only, hash-chained audit log (JSONL). Entries are redacted before writing. */
export class Audit {
  private last = "genesis";
  constructor(private file: string) {
    try {
      const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
      if (lines.length) this.last = (JSON.parse(lines[lines.length - 1]!) as { hash: string }).hash;
    } catch {
      /* new file */
    }
  }
  write(entry: Record<string, unknown>): void {
    const body = { ts: new Date().toISOString(), ...(redact(entry) as Record<string, unknown>), prev: this.last };
    const hash = crypto.createHash("sha256").update(this.last + JSON.stringify(body)).digest("hex");
    fs.appendFileSync(this.file, `${JSON.stringify({ ...body, hash })}\n`, { mode: 0o600 });
    this.last = hash;
  }
}

/** Verify the hash chain of an audit file. Returns the index of the first bad line, or -1 if intact. */
export function verifyAudit(file: string): number {
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
  let prev = "genesis";
  for (let i = 0; i < lines.length; i++) {
    const { hash, ...body } = JSON.parse(lines[i]!) as Record<string, unknown> & { hash: string; prev: string };
    if (body.prev !== prev) return i;
    const h = crypto.createHash("sha256").update(prev + JSON.stringify(body)).digest("hex");
    if (h !== hash) return i;
    prev = hash;
  }
  return -1;
}
