/** Heuristic detector for instruction-like text hidden in untrusted content (web pages, MCP output, notes). Flags, never trusts. */
const PATTERNS: RegExp[] = [
  /ignore\s+(all\s+|any\s+|the\s+)?(previous|prior|above|earlier)\s+(instructions?|rules?|prompts?)/i,
  /disregard\s+(the\s+|all\s+|any\s+)?(system|previous|prior|above)/i,
  /\byou\s+are\s+now\b/i,
  /\bnew\s+instructions?\s*:/i,
  /\b(reveal|print|show|repeat)\s+(your\s+)?(system\s+prompt|instructions)/i,
  /do\s+not\s+(tell|inform|mention)\s+(this\s+to\s+)?the\s+(user|owner|human)/i,
  /\b(send|forward|email|mail|post|upload)\b[^.\n]{0,80}\b(to|at)\b[^.\n]{0,40}[\w.+-]+@[\w-]+\.[\w.]+/i,
  /<\s*\/?\s*(system|assistant|instructions?)\s*>/i,
  /\bBEGIN\s+(SYSTEM|INSTRUCTIONS?)\b/i,
  /\b(api[_ -]?key|password|passphrase|refresh[_ -]?token)\b[^.\n]{0,40}\b(send|include|append|reveal)\b/i,
];

export function looksLikeInjection(text: string): boolean {
  const t = text.slice(0, 30_000);
  return PATTERNS.some((re) => re.test(t));
}
