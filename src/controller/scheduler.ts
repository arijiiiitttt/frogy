import crypto from "node:crypto";
import { Cron } from "croner";
import { alert } from "../shared/alerts.js";
import { env } from "../shared/util.js";
import { buildDigest, formatDigest } from "./digest.js";
import { getSetting, q, setSetting } from "./db.js";

export function nextRun(cron: string, timezone: string, from = new Date()): Date | null {
  return new Cron(cron, { timezone }).nextRun(from);
}

/** Enqueue due schedules (actions, goals, or agents). The idempotency key (schedule + slot time) makes duplicate firing after restarts impossible. */
export async function schedulerTick(): Promise<void> {
  const due = await q("SELECT * FROM schedules WHERE enabled AND next_run_at IS NOT NULL AND next_run_at <= now()");
  for (const s of due.rows) {
    const slot = (s.next_run_at as Date).toISOString();
    const key = `sched:${s.id}:${slot}`;
    if (s.agent) {
      const a = s.agent as { role: string; act: boolean; plan: boolean; verify: boolean; maxSteps?: number; budgetTokens?: number };
      const id = crypto.randomUUID();
      await q(
        `INSERT INTO tasks (id, kind, goal, role, root_id, allow_actions, want_plan, want_verify, max_steps, budget_tokens, schedule_id, idempotency_key)
         VALUES ($1,'agent',$2,$3,$1,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (idempotency_key) DO NOTHING`,
        [id, s.goal, a.role, a.act, a.plan, a.verify, a.maxSteps ?? null, a.budgetTokens ?? null, s.id, key],
      );
    } else {
      await q(`INSERT INTO tasks (kind, action, input, goal, schedule_id, idempotency_key) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (idempotency_key) DO NOTHING`, [s.action ? "action" : "goal", s.action, JSON.stringify(s.input ?? {}), s.goal, s.id, key]);
    }
    await q("UPDATE schedules SET next_run_at=$2 WHERE id=$1", [s.id, nextRun(s.cron, s.timezone)]);
  }
}

/** Once per UTC day, at DIGEST_HOUR_UTC (0-23), push a summary via Telegram/webhook. Off unless the variable is set. */
export async function digestTick(now = new Date()): Promise<boolean> {
  const hour = env("DIGEST_HOUR_UTC");
  if (hour === undefined || Number(hour) !== now.getUTCHours()) return false;
  const today = now.toISOString().slice(0, 10);
  if ((await getSetting<string>("last_digest_date", "")) === today) return false;
  await setSetting("last_digest_date", today);
  await alert("digest", formatDigest(await buildDigest(24)), 0);
  return true;
}
