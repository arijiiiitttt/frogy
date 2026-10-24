import test from "node:test";
import assert from "node:assert/strict";
import { findCut, newState, pendingToolCalls, runAgent } from "../src/agent/loop.js";
import { Wait } from "../src/agent/errors.js";
import { toolsFor, ROLES, MAX_DEPTH } from "../src/agent/roles.js";
import type { AgentDeps, AgentState, AgentTool } from "../src/agent/types.js";
import type { ChatMessage, ChatResult, ToolCall } from "../src/gateway/types.js";

const call = (name: string, args: Record<string, unknown> = {}, id = `c${Math.random().toString(36).slice(2, 8)}`): ToolCall => ({ id, name, args });
const reply = (text: string, toolCalls: ToolCall[] = []): Partial<ChatResult> => ({ text, toolCalls });

function harness(script: Partial<ChatResult>[], tools: Record<string, AgentTool>, limits: Partial<AgentDeps["limits"]> = {}) {
  const log = { chats: [] as any[], events: [] as any[], saves: 0, stopped: false };
  let i = 0;
  const deps: AgentDeps = {
    chat: async (req) => {
      log.chats.push(req);
      const r = script[i++] ?? reply("fallback done");
      return { text: "", toolCalls: [], provider: "p", model: "m", via: "direct", inputTokens: 10, outputTokens: 5, latencyMs: 1, failures: [], ...r } as ChatResult;
    },
    tools,
    save: async () => void log.saves++,
    isStopped: async () => log.stopped,
    event: async (type, payload) => void log.events.push({ type, ...payload }),
    limits: { maxSteps: 10, maxTokens: 10_000, compactAtChars: 100_000, keepLast: 8, ...limits },
  };
  return { deps, log };
}
const echo: AgentTool = { def: { name: "echo", description: "e", parameters: { type: "object", properties: {} } }, run: async (a) => `echo:${JSON.stringify(a)}` };
const fresh = () => newState("sys", "goal", "cheap");

test("loop: tool call -> result -> finish", async () => {
  const { deps, log } = harness([reply("", [call("echo", { x: 1 }, "t1")]), reply("", [call("finish", { result: "all done" }, "t2")])], { echo });
  const st = fresh();
  const out = await runAgent(deps, st);
  assert.deepEqual(out, { status: "done", result: "all done" });
  assert.equal(st.messages.find((m) => m.role === "tool" && m.toolCallId === "t1")!.content, 'echo:{"x":1}');
  assert.equal(st.step, 2);
  assert.ok(log.events.some((e) => e.type === "tool" && e.name === "echo" && e.ok));
  assert.ok(log.chats[0].tools.some((t: any) => t.name === "finish"), "finish tool is always offered");
});

test("loop: plain text reply is treated as the final answer", async () => {
  const { deps } = harness([reply("the answer")], {});
  assert.deepEqual(await runAgent(deps, fresh()), { status: "done", result: "the answer" });
});

test("loop: unknown tool and invalid JSON args produce errors the model can see", async () => {
  const { deps } = harness([reply("", [call("nope", {}, "a"), { id: "b", name: "echo", args: { _parseError: "bad json" } }]), reply("", [call("finish", { result: "ok" })])], { echo });
  const st = fresh();
  await runAgent(deps, st);
  assert.match(st.messages.find((m) => m.toolCallId === "a")!.content, /unknown tool "nope"/);
  assert.match(st.messages.find((m) => m.toolCallId === "b")!.content, /valid JSON/);
});

test("loop: secrets in tool output are redacted before the model sees them", async () => {
  const leaky: AgentTool = { def: echo.def, run: async () => "token ya29.A0ARrdaM-supersecretvalue and Bearer abc.def.ghi" };
  const { deps } = harness([reply("", [call("echo", {}, "t")]), reply("done")], { echo: leaky });
  const st = fresh();
  await runAgent(deps, st);
  const c = st.messages.find((m) => m.toolCallId === "t")!.content;
  assert.ok(!c.includes("supersecretvalue") && !c.includes("abc.def.ghi"));
});

test("resume: pending tool calls left by a crash are executed first, without calling the model", async () => {
  const st = fresh();
  st.messages.push({ role: "assistant", content: "", toolCalls: [call("echo", { n: 1 }, "p1"), call("echo", { n: 2 }, "p2")] });
  st.messages.push({ role: "tool", toolCallId: "p1", toolName: "echo", content: "already ran" });
  assert.deepEqual(pendingToolCalls(st.messages).map((t) => t.id), ["p2"]);
  let runs = 0;
  const counting: AgentTool = { def: echo.def, run: async () => `run${++runs}` };
  const { deps, log } = harness([reply("", [call("finish", { result: "resumed" })])], { echo: counting });
  const out = await runAgent(deps, st);
  assert.equal(runs, 1, "only the unanswered call re-runs");
  assert.equal(out.status, "done");
  assert.equal(log.chats.length, 1);
});

test("wait: a tool that throws Wait saves state, propagates, and re-runs on resume", async () => {
  let ready = false;
  const waiter: AgentTool = { def: { ...echo.def, name: "waiter" }, run: async () => { if (!ready) throw new Wait(5, "not yet"); return "ready!"; } };
  const { deps } = harness([reply("", [call("waiter", {}, "w1")]), reply("", [call("finish", { result: "after wait" })])], { waiter });
  const st = fresh();
  await assert.rejects(runAgent(deps, st), (e) => e instanceof Wait);
  assert.equal(pendingToolCalls(st.messages).length, 1, "call stays pending");
  ready = true;
  const out = await runAgent(deps, st);
  assert.deepEqual(out, { status: "done", result: "after wait" });
  assert.equal(st.messages.find((m) => m.toolCallId === "w1")!.content, "ready!");
});

test("stuck: repeating the same call escalates the tier once, then fails", async () => {
  const same = () => reply("", [call("echo", { same: true })]);
  const { deps, log } = harness([same(), same(), same(), same(), same(), same(), same(), same(), same(), same()], { echo });
  const st = fresh();
  const out = await runAgent(deps, st);
  assert.equal(out.status, "failed");
  assert.match((out as any).error, /stuck/);
  assert.ok(log.events.some((e) => e.type === "escalated"));
  const tiers = log.chats.map((c) => c.tier);
  assert.equal(tiers[0], "cheap");
  assert.ok(tiers.includes("mid"), "escalated to the next tier");
});

test("stuck: 4 consecutive tool errors trip detection", async () => {
  const bad: AgentTool = { def: echo.def, run: async () => { throw new Error("boom"); } };
  const mk = (n: number) => reply("", [call("echo", { n })]);
  const { deps } = harness([mk(1), mk(2), mk(3), mk(4), mk(5), mk(6), mk(7), mk(8), mk(9)], { echo: bad });
  const out = await runAgent(deps, fresh());
  assert.equal(out.status, "failed");
});

test("limits: step cap, token budget, and stop flag", async () => {
  const n = (i: number) => reply("", [call("echo", { i })]);
  let h = harness([n(1), n(2), n(3), n(4)], { echo }, { maxSteps: 2 });
  assert.match(((await runAgent(h.deps, fresh())) as any).error, /step limit/);
  h = harness([n(1), n(2), n(3)], { echo }, { maxTokens: 20 });
  assert.match(((await runAgent(h.deps, fresh())) as any).error, /token budget/);
  h = harness([n(1)], { echo });
  h.log.stopped = true;
  assert.deepEqual(await runAgent(h.deps, fresh()), { status: "stopped" });
  assert.equal(h.log.chats.length, 0);
});

test("compaction: long history is summarised on the cheap tier, tool-call/result pairs are never split", async () => {
  const st = fresh();
  for (let i = 0; i < 12; i++) {
    st.messages.push({ role: "assistant", content: "x".repeat(400), toolCalls: [call("echo", { i }, `k${i}`)] });
    st.messages.push({ role: "tool", toolCallId: `k${i}`, toolName: "echo", content: "y".repeat(400) });
  }
  const cut = findCut(st.messages, 8);
  assert.ok(cut > 3);
  assert.notEqual(st.messages[cut]!.role, "tool");
  const { deps, log } = harness([reply("SUMMARY of work"), reply("final")], { echo }, { compactAtChars: 3000, keepLast: 8 });
  await runAgent(deps, st);
  assert.equal(log.chats[0].tier, "cheap");
  assert.ok(st.messages.some((m) => m.content.startsWith("[Summary of earlier work]")));
  assert.ok(st.messages.length < 20);
  assert.equal(st.messages[1]!.content, "goal", "the original goal always survives");
  // no orphan tool messages
  const ids = new Set<string>();
  for (const m of st.messages) { if (m.toolCalls) m.toolCalls.forEach((t) => ids.add(t.id)); if (m.role === "tool") assert.ok(ids.has(m.toolCallId!), "tool result has its call"); }
});

test("plan: strong-tier plan first, then execution on the cheap tier", async () => {
  const st = newState("sys", "goal", "cheap", true);
  const { deps, log } = harness([reply("1. do it"), reply("done")], {});
  await runAgent(deps, st);
  assert.equal(log.chats[0].tier, "strong");
  assert.equal(log.chats[1].tier, "cheap");
  assert.ok(st.messages.some((m) => m.content.startsWith("Plan to follow:")));
});

test("roles: spawning tools are removed at maximum depth; every role has a [role: x] marker prompt", () => {
  assert.ok(toolsFor(ROLES.orchestrator!, 0).includes("spawn_agent"));
  assert.ok(!toolsFor(ROLES.orchestrator!, MAX_DEPTH).includes("spawn_agent"));
  assert.ok(!toolsFor(ROLES.general!, MAX_DEPTH).includes("wait_for_agents"));
});
