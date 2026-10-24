export type Role = "system" | "user" | "assistant" | "tool";

/** A tool the model may call. `parameters` is a JSON Schema (keep to type/properties/required/enum/items/description). */
export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** Provider-specific data that must be echoed back to the SAME provider (e.g. Gemini thought signatures). */
  meta?: Record<string, unknown>;
}
export interface ChatMessage {
  role: Role;
  content: string;
  /** assistant messages: tool calls the model made */
  toolCalls?: ToolCall[];
  /** tool messages: which call this answers */
  toolCallId?: string;
  toolName?: string;
}
export type Tier = "cheap" | "mid" | "strong";

export interface ChatRequest {
  messages: ChatMessage[];
  /** Pick a model tier (default "cheap"). Ignored when `model` is set. */
  tier?: Tier;
  /** Pin a specific model as "provider/model-id". */
  model?: string;
  maxTokens?: number;
  temperature?: number;
  json?: boolean;
  tools?: ToolDef[];
}

export interface ChatResult {
  text: string;
  provider: string;
  model: string;
  via: "direct" | "openrouter";
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  toolCalls: ToolCall[];
  switchReason?: string;
  failures: { model: string; error: string }[];
}

export class ProviderError extends Error {
  constructor(
    public status: number,
    message: string,
    public retryAfterMs?: number,
  ) {
    super(message);
  }
  /** Worth retrying / failing over (rate limit, server error, timeout, network). */
  get retryable(): boolean {
    return this.status === 0 || this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

export interface AdapterOutput {
  toolCalls?: ToolCall[];
  text: string;
  inputTokens: number;
  outputTokens: number;
}
export type Adapter = (cfg: ProviderCfg, apiKey: string, model: string, req: ChatRequest, signal: AbortSignal) => Promise<AdapterOutput>;

export interface ProviderCfg {
  type: "openai-compat" | "anthropic" | "gemini";
  baseUrl?: string;
  keyEnv: string;
}

export interface GatewayConfig {
  providers: Record<string, ProviderCfg>;
  tiers: Record<Tier, string[]>;
  /** Provider used as a last resort for the SAME model after direct providers fail (e.g. "openrouter"). */
  fallbackVia?: string;
  /** Map a direct model id ("anthropic/x") to its OpenRouter id, when they differ. */
  aliases?: Record<string, string>;
  timeoutMs?: number;
  /** Optional USD per 1M tokens, keyed "provider/model". You fill these in from each provider's pricing page; unknown models cost 0 in reports. */
  prices?: Record<string, { in: number; out: number }>;
}
