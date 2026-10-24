import { ADAPTERS } from "./adapters.js";
import { ProviderError, type Adapter, type ChatRequest, type ChatResult, type GatewayConfig, type Tier } from "./types.js";
import { sleep } from "../shared/util.js";

const TIER_ORDER: Tier[] = ["cheap", "mid", "strong"];
const BREAKER_THRESHOLD = 3;
const BREAKER_MS = 5 * 60_000;

interface Breaker {
  failures: number;
  openUntil: number;
}

export class Gateway {
  private breakers = new Map<string, Breaker>();

  constructor(
    private cfg: GatewayConfig,
    private deps: { adapters?: Record<string, Adapter>; getKey?: (envName: string) => string | undefined } = {},
  ) {}

  private key(envName: string) {
    return (this.deps.getKey ?? ((n: string) => process.env[n]))(envName);
  }
  private adapter(type: string): Adapter {
    return (this.deps.adapters ?? ADAPTERS)[type]!;
  }

  /** Entries that are placeholders or whose provider has no key are skipped silently. */
  private usable(id: string): { provider: string; model: string } | null {
    if (id.includes("REPLACE")) return null;
    const slash = id.indexOf("/");
    if (slash < 1) return null;
    const provider = id.slice(0, slash);
    const p = this.cfg.providers[provider];
    if (!p || !this.key(p.keyEnv)) return null;
    return { provider, model: id.slice(slash + 1) };
  }

  private candidates(req: ChatRequest): string[] {
    if (req.model) return [req.model];
    const start = TIER_ORDER.indexOf(req.tier ?? "cheap");
    // Fail over upward (to costlier tiers) only after the whole tier failed.
    return TIER_ORDER.slice(start).flatMap((t) => this.cfg.tiers[t] ?? []);
  }

  private breakerOpen(id: string): boolean {
    const b = this.breakers.get(id);
    return Boolean(b && b.openUntil > Date.now());
  }
  private recordFailure(id: string) {
    const b = this.breakers.get(id) ?? { failures: 0, openUntil: 0 };
    b.failures++;
    if (b.failures >= BREAKER_THRESHOLD) b.openUntil = Date.now() + BREAKER_MS;
    this.breakers.set(id, b);
  }
  private recordSuccess(id: string) {
    this.breakers.delete(id);
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const failures: ChatResult["failures"] = [];
    const tried: string[] = [];

    const attempt = async (id: string, via: "direct" | "openrouter", providerId: string, modelId: string, retries: number): Promise<ChatResult | null> => {
      const p = this.cfg.providers[providerId]!;
      const apiKey = this.key(p.keyEnv)!;
      for (let i = 0; i <= retries; i++) {
        const started = Date.now();
        try {
          const out = await this.adapter(p.type)(p, apiKey, modelId, req, AbortSignal.timeout(this.cfg.timeoutMs ?? 60_000));
          this.recordSuccess(id);
          return {
            ...out,
            toolCalls: out.toolCalls ?? [],
            provider: providerId,
            model: modelId,
            via,
            latencyMs: Date.now() - started,
            switchReason: tried.length ? `failover after ${tried.join(", ")}` : undefined,
            failures,
          };
        } catch (e) {
          const pe = e instanceof ProviderError ? e : new ProviderError(0, (e as Error).message);
          if (!pe.retryable) {
            // 400/401/403/404: config problem — don't retry, don't trip breaker for transient reasons.
            failures.push({ model: id, error: `${pe.status}: ${pe.message}` });
            return null;
          }
          if (i < retries) await sleep(Math.min(pe.retryAfterMs ?? 500 * 2 ** i, 8000));
          else {
            this.recordFailure(id);
            failures.push({ model: id, error: `${pe.status}: ${pe.message}` });
          }
        }
      }
      return null;
    };

    for (const id of this.candidates(req)) {
      const u = this.usable(id);
      if (!u || this.breakerOpen(id)) continue;
      const r = await attempt(id, "direct", u.provider, u.model, 1);
      if (r) return r;
      tried.push(id);
    }

    // Last resort: same model(s) via the fallback aggregator (e.g. OpenRouter). Cross-model switching stays above.
    const fb = this.cfg.fallbackVia;
    if (fb && this.cfg.providers[fb] && this.key(this.cfg.providers[fb].keyEnv)) {
      for (const id of tried.slice(0, 2)) {
        const alias = this.cfg.aliases?.[id] ?? id;
        const r = await attempt(`${fb}:${id}`, "openrouter", fb, alias, 0);
        if (r) return r;
      }
    }
    throw new Error(`All models failed or none configured. ${failures.map((f) => `${f.model} -> ${f.error}`).join(" | ") || "No usable models (check keys and config)."}`);
  }
}
