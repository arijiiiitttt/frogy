import { alert } from "../shared/alerts.js";
import { env, sleep } from "../shared/util.js";
import { buildDigest, formatDigest } from "./digest.js";
import { q } from "./db.js";

export interface TgDeps {
  status(): Promise<string>;
  digest(): Promise<string>;
  tasks(): Promise<string>;
  answer(idPrefix: string, text: string): Promise<string>;
  stop(idPrefix: string): Promise<string>;
  stopAll(): Promise<string>;
}

const HELP = "Commands: /status /digest /tasks /answer <id> <text> /stop <id> /stopall confirm";

/** Parse and run one Telegram command. Read / stop / answer only: it can never start work, send mail or change policy. */
export async function handleTelegramCommand(text: string, d: TgDeps): Promise<string> {
  const [cmdRaw, ...rest] = text.trim().split(/\s+/);
  const cmd = (cmdRaw ?? "").split("@")[0]!.toLowerCase();
  switch (cmd) {
    case "/start":
    case "/help":
      return HELP;
    case "/status":
      return d.status();
    case "/digest":
      return d.digest();
    case "/tasks":
      return d.tasks();
    case "/answer": {
      const [id, ...ans] = rest;
      return id && ans.length ? d.answer(id, ans.join(" ")) : "Usage: /answer <task-id> <your answer>";
    }
    case "/stop":
      return rest[0] ? d.stop(rest[0]) : "Usage: /stop <task-id>";
    case "/stopall":
      return rest[0]?.toLowerCase() === "confirm" ? d.stopAll() : "This stops ALL tasks and disables ALL schedules. Send: /stopall confirm";
    default:
      return HELP;
  }
}

async function resolveId(prefix: string): Promise<{ id?: string; error?: string }> {
  if (!/^[0-9a-f-]{4,36}$/i.test(prefix)) return { error: "Give at least 4 characters of the task id." };
  const r = await q("SELECT id FROM tasks WHERE id::text LIKE $1 LIMIT 2", [`${prefix.toLowerCase()}%`]);
  if (r.rows.length === 0) return { error: "No task with that id." };
  if (r.rows.length > 1) return { error: "That id prefix is ambiguous; send more characters." };
  return { id: r.rows[0].id };
}

export const dbDeps: TgDeps = {
  async status() {
    const r = await q("SELECT status, count(*)::int AS n FROM tasks GROUP BY status");
    return `Tasks: ${r.rows.map((x) => `${x.status} ${x.n}`).join(", ") || "none"}`;
  },
  async digest() {
    return formatDigest(await buildDigest(24));
  },
  async tasks() {
    const r = await q("SELECT id, status, coalesce(action, left(goal,40)) AS what, coalesce(note,'') AS note FROM tasks ORDER BY created_at DESC LIMIT 8");
    return r.rows.map((x) => `${x.id.slice(0, 8)} ${x.status} ${x.what}${x.note ? ` (${x.note.slice(0, 40)})` : ""}`).join("\n") || "No tasks.";
  },
  async answer(prefix, text) {
    const t = await resolveId(prefix);
    if (!t.id) return t.error!;
    const r = await q("UPDATE tasks SET answer=$2 WHERE id=$1 AND question IS NOT NULL RETURNING id", [t.id, text.slice(0, 2000)]);
    return r.rows[0] ? "Answer delivered." : "That task is not waiting for an answer.";
  },
  async stop(prefix) {
    const t = await resolveId(prefix);
    if (!t.id) return t.error!;
    const r = await q("UPDATE tasks SET status='stopped', locked_at=NULL, updated_at=now() WHERE (id=$1 OR root_id=$1) AND status IN ('queued','running') RETURNING id", [t.id]);
    return `Stopped ${r.rows.length} task(s).`;
  },
  async stopAll() {
    const t = await q("UPDATE tasks SET status='stopped', locked_at=NULL, updated_at=now() WHERE status IN ('queued','running') RETURNING id");
    await q("UPDATE schedules SET enabled=false");
    return `KILL SWITCH: stopped ${t.rows.length} task(s), disabled all schedules.`;
  },
};

/** Long-polls Telegram (outbound only; fine on the free tier). Only the configured private chat is obeyed. */
export function startTelegramControl(deps: TgDeps = dbDeps): { stop(): void } | null {
  const token = env("TELEGRAM_BOT_TOKEN");
  const chatId = env("TELEGRAM_CHAT_ID");
  if (!token || !chatId || env("TELEGRAM_CONTROL") !== "true") return null;
  const base = `${env("TELEGRAM_API_BASE", "https://api.telegram.org")}/bot${token}`;
  let running = true;
  let offset = 0;
  const send = (text: string) =>
    fetch(`${base}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 3500) }), signal: AbortSignal.timeout(15_000) }).catch(() => undefined);

  void (async () => {
    while (running) {
      const started = Date.now();
      try {
        const res = await fetch(`${base}/getUpdates?timeout=25&offset=${offset}`, { signal: AbortSignal.timeout(40_000) });
        const j = (await res.json()) as { ok?: boolean; result?: { update_id: number; message?: { text?: string; chat?: { id: number; type?: string } } }[] };
        for (const u of j.result ?? []) {
          offset = u.update_id + 1;
          const m = u.message;
          // Strict gate: the configured chat id AND a private chat. Everything else is silently ignored.
          if (!m?.text || String(m.chat?.id) !== String(chatId) || (m.chat?.type && m.chat.type !== "private")) continue;
          try {
            await send(await handleTelegramCommand(m.text, deps));
          } catch (e) {
            await send(`Error: ${(e as Error).message}`);
          }
        }
      } catch {
        await sleep(5000);
      }
      if (Date.now() - started < 1000) await sleep(1000); // avoid a hot loop if the server returns instantly
    }
  })();
  void alert("telegram-control", "Telegram control is on (status/stop/answer only).", 24 * 3600_000);
  return { stop: () => void (running = false) };
}
