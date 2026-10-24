import { Gateway, loadGatewayConfig, type ChatRequest, type ChatResult } from "../gateway/index.js";
import { alert } from "../shared/alerts.js";
import { intEnv } from "../shared/util.js";
import { q } from "./db.js";

let gw: Gateway | null | undefined;
function gateway(): Gateway | null {
  if (gw === undefined) {
    const cfg = loadGatewayConfig();
    gw = cfg ? new Gateway(cfg) : null;
  }
  return gw;
}

export const llmConfigured = () => gateway() !== null;

/** USD per 1M tokens from frogy.config.json "prices" (you provide them; unknown models count as 0). */
export function priceOf(provider: string, model: string): { in: number; out: number } | undefined {
  return loadGatewayConfig()?.prices?.[`${provider}/${model}`];
}
export const usd = (p: { in: number; out: number } | undefined, inTok: number, outTok: number) => (p ? (inTok * p.in + outTok * p.out) / 1_000_000 : 0);

export async function usdToday(): Promise<number> {
  const r = await q("SELECT provider, model, sum(input_tokens)::bigint AS i, sum(output_tokens)::bigint AS o FROM llm_calls WHERE ts >= date_trunc('day', now()) GROUP BY provider, model");
  return r.rows.reduce((n, x) => n + usd(priceOf(x.provider, x.model), Number(x.i), Number(x.o)), 0);
}

export async function tokensUsedToday(): Promise<number> {
  const r = await q("SELECT COALESCE(SUM(input_tokens+output_tokens),0)::bigint AS n FROM llm_calls WHERE ts >= date_trunc('day', now())");
  return Number(r.rows[0].n);
}

/** All LLM use goes through here: daily token budget check, then gateway, then usage logging. */
export async function llmChat(taskId: string | null, req: ChatRequest): Promise<ChatResult> {
  const g = gateway();
  if (!g) throw new Error("llm_not_configured: create frogy.config.json (see frogy.config.example.json) and set provider API keys");
  const budget = intEnv("DAILY_TOKEN_BUDGET", 500_000);
  const used = await tokensUsedToday();
  if (used >= budget) {
    void alert("budget", `Daily LLM token budget reached (${used}/${budget}). AI steps are paused until tomorrow (UTC).`);
    throw new Error("daily_token_budget_exceeded");
  }
  const usdBudget = Number(process.env.DAILY_USD_BUDGET ?? 0);
  if (usdBudget > 0) {
    const spent = await usdToday();
    if (spent >= usdBudget) {
      void alert("budget-usd", `Daily USD budget reached ($${spent.toFixed(2)}/$${usdBudget}). AI steps are paused until tomorrow (UTC).`);
      throw new Error("daily_usd_budget_exceeded");
    }
  }
  const res = await g.chat(req);
  await q("INSERT INTO llm_calls (task_id, provider, model, via, input_tokens, output_tokens, latency_ms, switch_reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [
    taskId, res.provider, res.model, res.via, res.inputTokens, res.outputTokens, res.latencyMs, res.switchReason ?? null,
  ]);
  return res;
}
