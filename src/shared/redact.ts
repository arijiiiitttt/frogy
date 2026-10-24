// Redaction applied to ALL logs, audit entries, alerts, and anything sent to an LLM.
const SENSITIVE_KEYS = /(token|secret|password|passwd|authorization|cookie|api[_-]?key|refresh|private[_-]?key|passphrase|client[_-]?secret)/i;

const PATTERNS: [RegExp, string][] = [
  [/Bearer\s+[A-Za-z0-9._~+\/-]+=*/g, "Bearer [REDACTED]"],
  [/ya29\.[A-Za-z0-9._-]+/g, "[REDACTED_GOOGLE_TOKEN]"],
  [/1\/\/[A-Za-z0-9._-]{20,}/g, "[REDACTED_REFRESH_TOKEN]"],
  [/GOCSPX-[A-Za-z0-9_-]+/g, "[REDACTED_CLIENT_SECRET]"],
  [/AIza[0-9A-Za-z_-]{30,}/g, "[REDACTED_API_KEY]"],
  [/sk-[A-Za-z0-9_-]{16,}/g, "[REDACTED_API_KEY]"],
  [/xai-[A-Za-z0-9]{16,}/g, "[REDACTED_API_KEY]"],
  [/\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/g, "[REDACTED_BOT_TOKEN]"],
];

export function redactString(s: string): string {
  let out = s;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[TRUNCATED]";
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.test(k) ? "[REDACTED]" : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}
