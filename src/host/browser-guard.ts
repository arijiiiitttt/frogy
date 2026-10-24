// Safety helpers for FUTURE browser actions (Instagram / LinkedIn).
// This scaffold does NOT ship page automation. Anything you add must use these guards.
import { sleep } from "../shared/util.js";

/** Random delay between actions so activity is not machine-regular. */
export async function jitter(minMs = 20_000, maxMs = 90_000): Promise<void> {
  await sleep(minMs + Math.floor(Math.random() * (maxMs - minMs)));
}

/** True when a page looks like a captcha / login challenge / action block. Callers must STOP, alert, and never try to bypass. */
export function looksLikeChallenge(url: string, text: string): boolean {
  const hay = `${url} ${text}`.toLowerCase();
  return ["captcha", "checkpoint", "challenge", "verify it's you", "unusual activity", "suspicious", "try again later", "action blocked", "security check"].some((k) => hay.includes(k));
}
