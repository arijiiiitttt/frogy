import test from "node:test";
import assert from "node:assert/strict";
import { anthropic, gemini, openaiCompat, toAnthropicMessages, toGeminiContents, toOpenAIMessages } from "../src/gateway/adapters.js";
import type { ChatMessage, ProviderCfg } from "../src/gateway/types.js";

const tools = [{ name: "web_fetch", description: "fetch", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false } }];
const convo: ChatMessage[] = [
  { role: "system", content: "sys" },
  { role: "user", content: "go" },
  { role: "assistant", content: "ok", toolCalls: [
    { id: "c1", name: "web_fetch", args: { url: "https://a.example" } },
    { id: "c2", name: "web_fetch", args: { url: "https://b.example" } } ] },
  { role: "tool", toolCallId: "c1", toolName: "web_fetch", content: "A" },
  { role: "tool", toolCallId: "c2", toolName: "web_fetch", content: "B" },
];

function mockFetch(reply: unknown) {
  const seen: { url: string; headers: any; body: any }[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    seen.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { seen, restore: () => (globalThis.fetch = orig) };
}
const sig = () => AbortSignal.timeout(2000);
const cfg = (type: ProviderCfg["type"]): ProviderCfg => ({ type, keyEnv: "K" });

test("openai-compat: tool defs, assistant tool_calls, tool results, parsed tool calls", async () => {
  const m = toOpenAIMessages(convo) as any[];
  assert.equal(m[2].tool_calls[0].function.arguments, '{"url":"https://a.example"}');
  assert.deepEqual([m[3].role, m[3].tool_call_id], ["tool", "c1"]);
  const f = mockFetch({ choices: [{ message: { content: null, tool_calls: [{ id: "x1", type: "function", function: { name: "web_fetch", arguments: '{"url":"https://z.example"}' } }, { id: "x2", type: "function", function: { name: "web_fetch", arguments: "{not json" } }] } }], usage: { prompt_tokens: 11, completion_tokens: 7 } });
  try {
    const r = await openaiCompat(cfg("openai-compat"), "k", "m", { messages: convo, tools }, sig());
    assert.equal(f.seen[0]!.body.tools[0].function.name, "web_fetch");
    assert.equal(r.toolCalls![0]!.args.url, "https://z.example");
    assert.ok(r.toolCalls![1]!.args._parseError, "bad JSON arguments are flagged, not crashed");
    assert.equal(r.inputTokens, 11);
  } finally { f.restore(); }
});

test("anthropic: tool_use blocks, results merged into ONE user message, tools->input_schema", async () => {
  const m = toAnthropicMessages(convo);
  assert.equal(m.length, 3); // user, assistant(tool_use x2), user(tool_result x2)
  assert.equal(m[1].content[0].type, "text");
  assert.equal(m[1].content.filter((b: any) => b.type === "tool_use").length, 2);
  assert.equal(m[2].content.length, 2);
  assert.equal(m[2].content[0].tool_use_id, "c1");
  const f = mockFetch({ content: [{ type: "text", text: "hi" }, { type: "tool_use", id: "tu1", name: "web_fetch", input: { url: "https://q.example" } }], usage: { input_tokens: 5, output_tokens: 3 } });
  try {
    const r = await anthropic(cfg("anthropic"), "k", "m", { messages: convo, tools }, sig());
    assert.equal(f.seen[0]!.body.tools[0].input_schema.type, "object");
    assert.equal(f.seen[0]!.body.system, "sys");
    assert.deepEqual(r.toolCalls![0], { id: "tu1", name: "web_fetch", args: { url: "https://q.example" } });
  } finally { f.restore(); }
});

test("gemini: functionCall/functionResponse parts, schema sanitised, raw part (thought signature) echoed back", async () => {
  const raw = { functionCall: { name: "web_fetch", args: { url: "https://a.example" } }, thoughtSignature: "SIG123" };
  const withMeta: ChatMessage[] = [
    { role: "user", content: "go" },
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "web_fetch", args: { url: "https://a.example" }, meta: { gemini: raw } }] },
    { role: "tool", toolCallId: "c1", toolName: "web_fetch", content: "A" },
  ];
  const c = toGeminiContents(withMeta);
  assert.equal(c[1].role, "model");
  assert.equal(c[1].parts[0].thoughtSignature, "SIG123");
  assert.equal(c[2].parts[0].functionResponse.name, "web_fetch");
  const f = mockFetch({ candidates: [{ content: { parts: [{ functionCall: { name: "web_fetch", args: { url: "https://n.example" } }, thoughtSignature: "S2" }] } }], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4 } });
  try {
    const r = await gemini(cfg("gemini"), "k", "m", { messages: convo, tools }, sig());
    const decl = f.seen[0]!.body.tools[0].functionDeclarations[0];
    assert.equal(decl.name, "web_fetch");
    assert.ok(!("additionalProperties" in decl.parameters), "unsupported schema keys are stripped");
    assert.equal(r.toolCalls![0]!.args.url, "https://n.example");
    assert.equal((r.toolCalls![0]!.meta as any).gemini.thoughtSignature, "S2");
  } finally { f.restore(); }
});
