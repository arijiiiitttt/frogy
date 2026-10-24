import { q } from "./db.js";
import { priceOf, usd } from "./llm.js";

export interface Digest {
  hours: number;
  counts: Record<string, number>;
  failed: { id: string; what: string; error: string }[];
  waiting: { id: string; what: string; why: string }[];
  tokens: number;
  usd: number;
  byModel: { model: string; calls: number; tokens: number }[];
}

export async function buildDigest(hours = 24): Promise<Digest> {
  const c = await q("SELECT status, count(*)::int AS n FROM tasks WHERE updated_at > now() - make_interval(hours => $1) AND status IN ('succeeded','failed','stopped') GROUP BY status", [hours]);
  const f = await q("SELECT id, coalesce(action, left(goal,60)) AS what, left(coalesce(error,''),140) AS error FROM tasks WHERE status='failed' AND updated_at > now() - make_interval(hours => $1) ORDER BY updated_at DESC LIMIT 10", [hours]);
  const w = await q("SELECT id, coalesce(action, left(goal,60)) AS what, coalesce(question, note) AS why FROM tasks WHERE status='queued' AND (note ILIKE 'waiting%' OR question IS NOT NULL) ORDER BY created_at LIMIT 10");
  const m = await q("SELECT provider, model, count(*)::int AS calls, sum(input_tokens)::bigint AS i, sum(output_tokens)::bigint AS o FROM llm_calls WHERE ts > now() - make_interval(hours => $1) GROUP BY provider, model ORDER BY 5 DESC", [hours]);
  let tokens = 0;
  let cost = 0;
  const byModel = m.rows.map((x) => {
    const t = Number(x.i) + Number(x.o);
    tokens += t;
    cost += usd(priceOf(x.provider, x.model), Number(x.i), Number(x.o));
    return { model: `${x.provider}/${x.model}`, calls: x.calls, tokens: t };
  });
  return {
    hours,
    counts: Object.fromEntries(c.rows.map((r) => [r.status, r.n])),
    failed: f.rows.map((r) => ({ id: r.id, what: r.what, error: r.error })),
    waiting: w.rows.map((r) => ({ id: r.id, what: r.what, why: String(r.why ?? "") })),
    tokens,
    usd: cost,
    byModel,
  };
}

export function formatDigest(d: Digest): string {
  const n = (k: string) => d.counts[k] ?? 0;
  const lines = [`Frogy digest — last ${d.hours}h`, `done: ${n("succeeded")}   failed: ${n("failed")}   stopped: ${n("stopped")}`, `AI: ${d.tokens} tokens${d.usd ? ` (~$${d.usd.toFixed(2)})` : ""}${d.byModel.length ? ` — ${d.byModel.slice(0, 3).map((x) => `${x.model} ${x.tokens}`).join(", ")}` : ""}`];
  if (d.waiting.length) {
    lines.push("", "Waiting on you:");
    for (const x of d.waiting) lines.push(`• ${x.id.slice(0, 8)} ${x.what} — ${x.why.slice(0, 100)}`);
  }
  if (d.failed.length) {
    lines.push("", "Failed:");
    for (const x of d.failed.slice(0, 5)) lines.push(`• ${x.id.slice(0, 8)} ${x.what} — ${x.error}`);
  }
  if (!d.waiting.length && !d.failed.length) lines.push("", "Nothing needs your attention.");
  return lines.join("\n");
}
