import crypto from "node:crypto";
import { redactString } from "../shared/redact.js";
import { truncate } from "../shared/util.js";
import { ProviderError, type Adapter, type ChatMessage, type ChatRequest, type ToolCall } from "./types.js";

async function post(url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal });
  } catch (e) {
    const timeout = (e as Error).name === "TimeoutError" || (e as Error).name === "AbortError";
    throw new ProviderError(timeout ? 408 : 0, timeout ? "timeout" : `network error: ${(e as Error).message}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const ra = Number(res.headers.get("retry-after"));
    throw new ProviderError(res.status, truncate(redactString(text), 300), Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined);
  }
  return res.json();
}

function parseArgs(v: unknown): Record<string, unknown> {
  if (v && typeof v === "object") return v as Record<string, unknown>;
  try {
    const p = JSON.parse(String(v || "{}"));
    return p && typeof p === "object" && !Array.isArray(p) ? p : {};
  } catch {
    return { _parseError: "tool arguments were not valid JSON" };
  }
}

// ---------------------------------------------------------------- OpenAI-compatible (OpenAI, xAI/Grok, OpenRouter, ...)
export function toOpenAIMessages(ms: ChatMessage[]): unknown[] {
  return ms.map((m) => {
    if (m.role === "assistant" && m.toolCalls?.length) {
      return {
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls.map((tc) => ({ id: tc.id, type: "function", function: { name: tc.name, arguments: JSON.stringify(tc.args) } })),
      };
    }
    if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    return { role: m.role, content: m.content };
  });
}

export const openaiCompat: Adapter = async (cfg, key, model, req, signal) => {
  const base = (cfg.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const body: Record<string, unknown> = { model, messages: toOpenAIMessages(req.messages), max_tokens: req.maxTokens ?? 1024 };
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.tools?.length) body.tools = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
  else if (req.json) body.response_format = { type: "json_object" };
  const j = await post(`${base}/chat/completions`, { authorization: `Bearer ${key}` }, body, signal);
  const msg = j.choices?.[0]?.message ?? {};
  const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((c: any) => ({ id: String(c.id ?? `call_${crypto.randomUUID()}`), name: String(c.function?.name ?? ""), args: parseArgs(c.function?.arguments) }));
  return {
    text: String(msg.content ?? ""),
    toolCalls,
    inputTokens: Number(j.usage?.prompt_tokens ?? 0),
    outputTokens: Number(j.usage?.completion_tokens ?? 0),
  };
};

// ---------------------------------------------------------------- Anthropic
export function toAnthropicMessages(ms: ChatMessage[]): any[] {
  const out: any[] = [];
  for (const m of ms) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      const block = { type: "tool_result", tool_use_id: m.toolCallId, content: m.content };
      const last = out[out.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content) && last.content.every((b: any) => b.type === "tool_result")) last.content.push(block);
      else out.push({ role: "user", content: [block] });
      continue;
    }
    if (m.role === "assistant" && m.toolCalls?.length) {
      const blocks: any[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const tc of m.toolCalls) blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.args });
      out.push({ role: "assistant", content: blocks });
      continue;
    }
    out.push({ role: m.role, content: m.content });
  }
  return out;
}

export const anthropic: Adapter = async (cfg, key, model, req, signal) => {
  const base = (cfg.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
  const system = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const body: Record<string, unknown> = { model, max_tokens: req.maxTokens ?? 1024, messages: toAnthropicMessages(req.messages) };
  if (system) body.system = system;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.tools?.length) body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  const j = await post(`${base}/v1/messages`, { "x-api-key": key, "anthropic-version": "2023-06-01" }, body, signal);
  const blocks: any[] = j.content ?? [];
  const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
  const toolCalls: ToolCall[] = blocks.filter((b) => b.type === "tool_use").map((b) => ({ id: String(b.id), name: String(b.name), args: parseArgs(b.input) }));
  return { text, toolCalls, inputTokens: Number(j.usage?.input_tokens ?? 0), outputTokens: Number(j.usage?.output_tokens ?? 0) };
};

// ---------------------------------------------------------------- Gemini
const stripSchema = (s: any): any => {
  if (Array.isArray(s)) return s.map(stripSchema);
  if (s && typeof s === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(s)) if (k !== "additionalProperties" && k !== "$schema") o[k] = stripSchema(v);
    return o;
  }
  return s;
};

export function toGeminiContents(ms: ChatMessage[]): any[] {
  const out: any[] = [];
  for (const m of ms) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      const part = { functionResponse: { name: m.toolName ?? "tool", response: { result: m.content } } };
      const last = out[out.length - 1];
      if (last && last.role === "user" && last.parts.every((p: any) => p.functionResponse)) last.parts.push(part);
      else out.push({ role: "user", parts: [part] });
      continue;
    }
    if (m.role === "assistant" && m.toolCalls?.length) {
      const parts: any[] = [];
      if (m.content) parts.push({ text: m.content });
      // Echo the provider's raw part back (keeps thought signatures intact when the same provider continues the turn).
      for (const tc of m.toolCalls) parts.push((tc.meta?.gemini as any) ?? { functionCall: { name: tc.name, args: tc.args } });
      out.push({ role: "model", parts });
      continue;
    }
    out.push({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] });
  }
  return out;
}

export const gemini: Adapter = async (cfg, key, model, req, signal) => {
  const base = (cfg.baseUrl ?? "https://generativelanguage.googleapis.com").replace(/\/$/, "");
  const system = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const gen: Record<string, unknown> = { maxOutputTokens: req.maxTokens ?? 1024 };
  if (req.temperature !== undefined) gen.temperature = req.temperature;
  if (req.json && !req.tools?.length) gen.responseMimeType = "application/json";
  const body: Record<string, unknown> = { contents: toGeminiContents(req.messages), generationConfig: gen };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (req.tools?.length) body.tools = [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parameters: stripSchema(t.parameters) })) }];
  const j = await post(`${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`, { "x-goog-api-key": key }, body, signal);
  const parts: any[] = j.candidates?.[0]?.content?.parts ?? [];
  const text = parts.map((p) => p.text ?? "").join("");
  const toolCalls: ToolCall[] = parts
    .filter((p) => p.functionCall)
    .map((p) => ({ id: `call_${crypto.randomUUID()}`, name: String(p.functionCall.name), args: parseArgs(p.functionCall.args), meta: { gemini: p } }));
  return { text, toolCalls, inputTokens: Number(j.usageMetadata?.promptTokenCount ?? 0), outputTokens: Number(j.usageMetadata?.candidatesTokenCount ?? 0) };
};

export const ADAPTERS: Record<string, Adapter> = { "openai-compat": openaiCompat, anthropic, gemini };
export type { ChatRequest };
