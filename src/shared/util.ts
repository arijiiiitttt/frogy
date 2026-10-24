import crypto from "node:crypto";

export function env(name: string, fallback?: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}
export function requireEnv(name: string): string {
  const v = env(name);
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}
export function intEnv(name: string, fallback: number): number {
  const v = env(name);
  const n = v === undefined ? NaN : Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export const sha256Hex = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function bearer(header: string | undefined): string {
  if (!header) return "";
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m ? m[1]!.trim() : "";
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…[truncated ${s.length - max} chars]`;
}
