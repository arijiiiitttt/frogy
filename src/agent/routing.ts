import type { Tier } from "../gateway/types.js";

const ORDER: Tier[] = ["cheap", "mid", "strong"];
export type TierStats = Partial<Record<Tier, { n: number; failed: number }>>;

/**
 * Start each agent on the cheapest tier that has actually been working for this role.
 * If recent runs that started on a tier failed >= 40% of the time (with at least 5 samples), start one tier higher.
 */
export function pickTier(roleDefault: Tier, stats: TierStats, minSamples = 5, failRate = 0.4): Tier {
  let i = ORDER.indexOf(roleDefault);
  while (i < ORDER.length - 1) {
    const s = stats[ORDER[i]!];
    if (s && s.n >= minSamples && s.failed / s.n >= failRate) i++;
    else break;
  }
  return ORDER[i]!;
}
