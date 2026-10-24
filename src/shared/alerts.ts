import { env, truncate } from "./util.js";
import { redactString } from "./redact.js";

const lastSent = new Map<string, number>();

/** Send an alert via Telegram and/or a generic webhook. Never throws. Rate-limited per key. */
export async function alert(key: string, message: string, minIntervalMs = 15 * 60_000): Promise<void> {
  const text = truncate(redactString(`[frogy] ${message}`), 1500);
  console.warn(text);
  const now = Date.now();
  const prev = lastSent.get(key) ?? 0;
  if (now - prev < minIntervalMs) return;
  lastSent.set(key, now);

  const tgToken = env("TELEGRAM_BOT_TOKEN");
  const tgChat = env("TELEGRAM_CHAT_ID");
  const hook = env("ALERT_WEBHOOK_URL");
  const jobs: Promise<unknown>[] = [];
  if (tgToken && tgChat) {
    jobs.push(
      fetch(`${env("TELEGRAM_API_BASE", "https://api.telegram.org")}/bot${tgToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: tgChat, text }),
        signal: AbortSignal.timeout(10_000),
      }).catch(() => undefined),
    );
  }
  if (hook) {
    jobs.push(
      fetch(hook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(10_000),
      }).catch(() => undefined),
    );
  }
  await Promise.all(jobs);
}
