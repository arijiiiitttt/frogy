// Fake OpenAI-compatible LLM that scripts agent behaviour deterministically (no real API needed).
import http from "node:http";
const port = Number(process.env.FAKE_LLM_PORT ?? 9912);
let n = 0;
const reviewed = new Set();
const tc = (name, args) => ({ id: `call_${++n}`, type: "function", function: { name, arguments: JSON.stringify(args) } });

function decide(messages, hasTools) {
  const sys = String(messages[0]?.content ?? "");
  if (!hasTools && sys.startsWith("You are a strict reviewer")) {
    const g = String(messages[1]?.content ?? "");
    if (g.includes("verify-fail-once") && !reviewed.has(g.slice(0, 80))) {
      reviewed.add(g.slice(0, 80));
      return { content: '{"ok":false,"issue":"missing the totals"}' };
    }
    return { content: '{"ok":true,"issue":""}' };
  }
  if (!hasTools) {
    if (sys.startsWith("You map a user")) return { content: '{"action":null,"input":{},"reason":"no matching action"}' };
    return { content: "fake text" };
  }
  const role = /\[role: (\w+)\]/.exec(sys)?.[1] ?? "general";
  const goal = String(messages[1]?.content ?? "");
  const tools = messages.filter((m) => m.role === "tool");
  const last = tools[tools.length - 1]?.content ?? "";
  const fin = (result) => ({ calls: [tc("finish", { result })] });

  if (role === "orchestrator") {
    if (tools.length === 0) return { calls: [tc("spawn_agent", { role: "researcher", goal: "topic A" }), tc("spawn_agent", { role: "researcher", goal: "topic B" })] };
    if (!tools.some((m) => String(m.content).includes("sub-agents finished"))) return { calls: [tc("wait_for_agents", {})] };
    return fin(`combined: ${String(last).replace(/\n/g, " ").slice(0, 300)}`);
  }
  if (role === "researcher") {
    if (goal.includes("fetch-local")) return tools.length === 0 ? { calls: [tc("web_fetch", { url: "http://127.0.0.1:8080/healthz" })] } : fin(`fetch result: ${String(last).slice(0, 100)}`);
    return tools.length === 0 ? { calls: [tc("memory_save", { key: `note ${goal.slice(0, 20)}`, text: `finding for ${goal}` })] } : fin(`researched: ${goal}`);
  }
  if (role === "operator") {
    const to = /to ([\w.+-]+@[\w.-]+)/.exec(goal)?.[1] ?? /([\w.+-]+@[\w.-]+)/.exec(goal)?.[1];
    return tools.length === 0 ? { calls: [tc("act", { action: "email.send", input: { to, subject: "agent mail", body: "hello from agent" } })] } : fin(`act result: ${String(last).slice(0, 160)}`);
  }
  if (goal.includes("mcp-demo")) {
    if (tools.length === 0) return { calls: [tc("mcp__docs__search", { query: "pricing" })] };
    if (tools.length === 1) return { calls: [tc("act", { action: "email.send", input: { to: "carol@corp.io", subject: "from mcp", body: "summary" } })] };
    return fin(`done: ${String(last).slice(0, 120)}`);
  }
  if (goal.includes("mcp-write")) return tools.length === 0 ? { calls: [tc("mcp__docs__create_ticket", { title: "t" })] } : fin(`ticket: ${String(last).slice(0, 140)}`);
  if (goal.includes("skill-demo")) return tools.length === 0 ? { calls: [tc("use_skill", { name: "house-style" })] } : fin(`skill said: ${String(last).replace(/\n/g, " ").slice(0, 100)}`);
  if (goal.includes("ask-me")) return tools.length === 0 ? { calls: [tc("ask_human", { question: "which color?" })] } : fin(`owner said: ${String(last)}`);
  return fin("ok");
}

http.createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    if (req.url !== "/v1/chat/completions") { res.statusCode = 404; return res.end("{}"); }
    const body = JSON.parse(b);
    const d = decide(body.messages, Boolean(body.tools?.length));
    const message = d.calls ? { role: "assistant", content: null, tool_calls: d.calls } : { role: "assistant", content: d.content };
    res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 50, completion_tokens: 20 } }));
  });
}).listen(port, "127.0.0.1", () => console.log("fake llm on", port));
