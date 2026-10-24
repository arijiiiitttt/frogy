import test from "node:test";
import assert from "node:assert/strict";
import { newState, runAgent } from "../src/agent/loop.js";
import type { AgentDeps, AgentTool } from "../src/agent/types.js";
import type { ChatResult, ToolCall } from "../src/gateway/types.js";
import { handleTelegramCommand, type TgDeps } from "../src/controller/telegram.js";
import { formatDigest, type Digest } from "../src/controller/digest.js";
import { usd } from "../src/controller/llm.js";

const call = (name: string, args: Record<string, unknown> = {}, id = `c${Math.random().toString(36).slice(2, 8)}`): ToolCall => ({ id, name, args });
function harness(script: Partial<ChatResult>[]) {
  const chats: any[] = [];
  const events: any[] = [];
  let i = 0;
  const deps: AgentDeps = {
    chat: async (req) => {
      chats.push(req);
      return { text: "", toolCalls: [], provider: "p", model: "m", via: "direct", inputTokens: 10, outputTokens: 5, latencyMs: 1, failures: [], ...(script[i++] ?? { text: "fallback" }) } as ChatResult;
    },
    tools: {} as Record<string, AgentTool>,
    save: async () => undefined,
    isStopped: async () => false,
    event: async (type, p) => void events.push({ type, ...p }),
    limits: { maxSteps: 10, maxTokens: 10_000, compactAtChars: 100_000, keepLast: 8 },
  };
  return { deps, chats, events };
}

test("verify: reviewer accepts a good result with ONE extra call on the mid tier", async () => {
  const { deps, chats, events } = harness([{ toolCalls: [call("finish", { result: "good" })] }, { text: '{"ok":true,"issue":""}' }]);
  const out = await runAgent(deps, newState("sys", "goal", "cheap", false, true));
  assert.deepEqual(out, { status: "done", result: "good" });
  assert.equal(chats.length, 2);
  assert.equal(chats[1].tier, "mid");
  assert.ok(events.some((e) => e.type === "reviewed" && e.ok === true));
});

test("verify: a rejected result sends the agent back once; the second answer is accepted without another review", async () => {
  const { deps, chats, events } = harness([
    { toolCalls: [call("finish", { result: "draft" })] },
    { text: '{"ok":false,"issue":"missing the price"}' },
    { toolCalls: [call("finish", { result: "final with price" })] },
  ]);
  const st = newState("sys", "goal", "cheap", false, true);
  const out = await runAgent(deps, st);
  assert.deepEqual(out, { status: "done", result: "final with price" });
  assert.equal(chats.length, 3, "only one review ever happens");
  assert.ok(st.messages.some((m) => m.role === "user" && /missing the price/.test(m.content)));
  assert.ok(events.some((e) => e.type === "reviewed" && e.ok === false));
  // history stays valid: every tool call has its result
  const ids = new Set<string>();
  for (const m of st.messages) { m.toolCalls?.forEach((t) => ids.add(t.id)); if (m.role === "tool") assert.ok(ids.has(m.toolCallId!)); }
});

test("verify: works for plain-text answers, and an unparseable review never blocks the result", async () => {
  let h = harness([{ text: "my answer" }, { text: '{"ok":false,"issue":"wrong"}' }, { text: "better answer" }]);
  assert.deepEqual(await runAgent(h.deps, newState("s", "g", "cheap", false, true)), { status: "done", result: "better answer" });
  h = harness([{ text: "my answer" }, { text: "I think it looks fine!" }]);
  assert.deepEqual(await runAgent(h.deps, newState("s", "g", "cheap", false, true)), { status: "done", result: "my answer" });
  h = harness([{ text: "no review wanted" }]);
  await runAgent(h.deps, newState("s", "g", "cheap"));
  assert.equal(h.chats.length, 1, "verify is off by default");
});

function tgDeps(log: string[]): TgDeps {
  return {
    status: async () => (log.push("status"), "ok-status"),
    digest: async () => (log.push("digest"), "ok-digest"),
    tasks: async () => (log.push("tasks"), "ok-tasks"),
    answer: async (id, t) => (log.push(`answer:${id}:${t}`), "answered"),
    stop: async (id) => (log.push(`stop:${id}`), "stopped"),
    stopAll: async () => (log.push("STOPALL"), "killed"),
  };
}

test("telegram: commands route correctly; the kill switch needs explicit confirmation; unknown text only shows help", async () => {
  const log: string[] = [];
  const d = tgDeps(log);
  assert.equal(await handleTelegramCommand("/status", d), "ok-status");
  assert.equal(await handleTelegramCommand("/status@frogy_bot", d), "ok-status");
  assert.equal(await handleTelegramCommand("/answer ab12cd blue is nice", d), "answered");
  assert.ok(log.includes("answer:ab12cd:blue is nice"));
  assert.match(await handleTelegramCommand("/answer ab12cd", d), /Usage/);
  assert.match(await handleTelegramCommand("/stopall", d), /Send: \/stopall confirm/);
  assert.ok(!log.includes("STOPALL"));
  assert.equal(await handleTelegramCommand("/stopall confirm", d), "killed");
  assert.match(await handleTelegramCommand("send an email to bob please", d), /Commands:/);
  assert.match(await handleTelegramCommand("/do email.send to=x@y.com", d), /Commands:/, "there is NO command that starts work or sends mail");
});

test("digest: formats counts, spend, what waits on you, and failures", () => {
  const d: Digest = {
    hours: 24, counts: { succeeded: 7, failed: 1 },
    failed: [{ id: "aaaaaaaa-1111", what: "email.send", error: "daily_cap: reached" }],
    waiting: [{ id: "bbbbbbbb-2222", what: "email dave", why: "waiting for owner approval (ab12)" }],
    tokens: 12345, usd: 0.42, byModel: [{ model: "anthropic/claude-haiku-5-5", calls: 9, tokens: 12000 }],
  };
  const t = formatDigest(d);
  assert.match(t, /done: 7\s+failed: 1/);
  assert.match(t, /12345 tokens \(~\$0\.42\)/);
  assert.match(t, /Waiting on you:[\s\S]*bbbbbbbb email dave/);
  assert.match(t, /Failed:[\s\S]*aaaaaaaa email\.send/);
  assert.match(formatDigest({ ...d, failed: [], waiting: [], usd: 0 }), /Nothing needs your attention/);
});

test("prices: dollars come only from prices you configured; unknown models cost 0", () => {
  assert.equal(usd({ in: 3, out: 15 }, 1_000_000, 100_000), 4.5);
  assert.equal(usd(undefined, 1_000_000, 1_000_000), 0);
});
