#!/usr/bin/env node
import { Command } from "commander";
import { api, saveCfg } from "./api.js";

const program = new Command("frogy").description("Control your Frogy sandbox from the terminal").version("0.1.0");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** key=value pairs -> object. Values stay strings; the server validates and coerces. */
function kv(pairs: string[]): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const p of pairs) {
    const i = p.indexOf("=");
    if (i < 1) {
      console.error(`Bad argument "${p}". Use key=value`);
      process.exit(1);
    }
    o[p.slice(0, i)] = p.slice(i + 1);
  }
  return o;
}
const short = (id: string) => id.slice(0, 8);
const DONE = new Set(["succeeded", "failed", "stopped"]);

async function waitFor(id: string, timeoutSec = 180) {
  let after = 0;
  const end = Date.now() + timeoutSec * 1000;
  while (Date.now() < end) {
    const ev = await api("GET", `/tasks/${id}/events?after=${after}`);
    for (const e of ev) {
      after = e.id;
      if (e.type === "deferred") console.log(`  … ${e.payload.note} (retry in ${e.payload.retryInSeconds}s)`);
      if (e.type === "retry") console.log(`  … retrying: ${e.payload.error}`);
    }
    const t = await api("GET", `/tasks/${id}`);
    if (DONE.has(t.status)) {
      console.log(`${t.status.toUpperCase()}`);
      if (t.error) console.log(`error: ${t.error}`);
      if (t.result) console.log(JSON.stringify(t.result, null, 2));
      return t;
    }
    await sleep(1500);
  }
  console.log(`Still running. Check later: frogy logs ${id} --follow`);
}

program
  .command("login")
  .requiredOption("--url <url>")
  .requiredOption("--token <token>")
  .action((o: { url: string; token: string }) => {
    saveCfg({ url: o.url, token: o.token });
    console.log("Saved.");
  });

program
  .command("do <action> [pairs...]")
  .description("Run a deterministic action (zero AI). Example: frogy do email.send to=a@b.com subject=Hi body='Hello' --dry-run")
  .option("--dry-run", "preview only; nothing is sent")
  .option("--json <json>", "input as a JSON object instead of key=value pairs")
  .option("--key <idempotencyKey>", "idempotency key (re-running with the same key never repeats the action)")
  .option("--no-wait", "queue and return immediately")
  .action(async (action: string, pairs: string[], o: { dryRun?: boolean; json?: string; key?: string; wait: boolean }) => {
    const input = o.json ? JSON.parse(o.json) : kv(pairs);
    const t = await api("POST", "/tasks", { action, input, dryRun: Boolean(o.dryRun), idempotencyKey: o.key });
    console.log(`task ${t.id}${t.existing ? " (already existed)" : ""}`);
    if (o.wait) await waitFor(t.id);
  });

program
  .command("run <goal...>")
  .description("Free-text request. Tries recipes and cache first (0 tokens), then ONE cheap AI call to map it to an action; always shows a dry-run first.")
  .option("--model <provider/model>")
  .option("--tier <tier>", "cheap | mid | strong")
  .option("--no-wait")
  .action(async (goal: string[], o: { model?: string; tier?: string; wait: boolean }) => {
    const t = await api("POST", "/tasks", { goal: goal.join(" "), model: o.model, tier: o.tier });
    console.log(`task ${t.id}`);
    if (o.wait) await waitFor(t.id);
  });

program
  .command("agent <goal...>")
  .description("Start an AI agent. It plans, calls tools, may spawn sub-agents, and finishes with a result. Read-only/dry-run unless you pass --act.")
  .option("--role <role>", "general | orchestrator | researcher | operator | coder", "general")
  .option("--act", "let the agent perform real actions (email.send, shell) through host policy. Needs the admin token")
  .option("--plan", "make a strong-model plan first, then execute with the cheaper model")
  .option("--verify", "have a second model review the result against the goal once (costs a little more, catches mistakes)")
  .option("--max-steps <n>", "step limit for this agent")
  .option("--budget <tokens>", "token budget for this agent")
  .option("--model <provider/model>")
  .option("--tier <tier>", "cheap | mid | strong")
  .option("--no-wait")
  .action(async (goal: string[], o: { role: string; act?: boolean; plan?: boolean; verify?: boolean; maxSteps?: string; budget?: string; model?: string; tier?: string; wait: boolean }) => {
    const t = await api("POST", "/tasks", {
      goal: goal.join(" "),
      model: o.model,
      tier: o.tier,
      agent: { role: o.role, act: Boolean(o.act), plan: Boolean(o.plan), verify: Boolean(o.verify), maxSteps: o.maxSteps ? Number(o.maxSteps) : undefined, budgetTokens: o.budget ? Number(o.budget) : undefined },
    });
    console.log(`agent ${t.id}  (watch: frogy logs ${t.id} -f | tree: frogy agents ${t.id})`);
    if (o.wait) await waitFor(t.id, 600);
  });

program.command("agents <id>").description("Show an agent and all its sub-agents").action(async (id: string) => {
  const rows = await api("GET", `/agents/${id}`);
  for (const a of rows) {
    const indent = "  ".repeat(a.depth);
    console.log(`${indent}${short(a.id)} [${a.role}] ${a.status.toUpperCase()} ${a.tokens} tok  ${a.goal}`);
    if (a.note) console.log(`${indent}   … ${a.note}`);
    if (a.question) console.log(`${indent}   ? ${a.question}   -> frogy answer ${a.id} "..."`);
    if (a.result) console.log(`${indent}   = ${a.result.replace(/\n/g, " ").slice(0, 200)}`);
    if (a.error) console.log(`${indent}   ! ${a.error}`);
  }
});

program.command("answer <id> <answer...>").description("Answer a question an agent asked (ask_human)").action(async (id: string, answer: string[]) => {
  console.log(await api("POST", `/tasks/${id}/answer`, { answer: answer.join(" ") }));
});

program.command("approvals").description("Agent actions waiting for your approval (the agent read untrusted content first)").action(async () => {
  const rows = await api("GET", "/tool-approvals");
  if (!rows.length) return console.log("Nothing pending.");
  for (const a of rows) console.log(`${a.id}  task ${short(a.task_id)}  ${a.summary}\n   approve: frogy approve ${a.id}   deny: frogy deny ${a.id}`);
});
program.command("approve <id>").description("Approve a pending agent action (admin token)").action(async (id: string) => console.log(await api("POST", `/tool-approvals/${id}/approve`)));
program.command("deny <id>").description("Deny a pending agent action (admin token)").action(async (id: string) => console.log(await api("POST", `/tool-approvals/${id}/deny`)));

const skill = program.command("skill").description("Owner-written playbooks agents load on demand (admin token)");
skill
  .command("add <name>")
  .requiredOption("--desc <description>", "one line shown to agents so they know when to use it")
  .requiredOption("--file <path>", "markdown/text instructions (max 8000 chars)")
  .option("--roles <list>", "comma-separated roles allowed to use it (default: all)")
  .action(async (name: string, o: { desc: string; file: string; roles?: string }) => {
    const { readFileSync } = await import("node:fs");
    console.log(await api("PUT", `/skills/${name}`, { description: o.desc, instructions: readFileSync(o.file, "utf8"), roles: o.roles?.split(",").map((r) => r.trim()) }));
  });
skill.command("list").action(async () => {
  for (const s of await api("GET", "/skills")) console.log(`${s.name.padEnd(24)} ${String(s.chars).padStart(5)} chars  ${s.roles ? `[${s.roles.join(",")}]` : "[all roles]"}  ${s.description}`);
});
skill.command("rm <name>").action(async (name: string) => console.log(await api("DELETE", `/skills/${name}`)));

program.command("confirm <id>").description("Execute the action proposed by a `run` task").action(async (id: string) => {
  const t = await api("POST", `/tasks/${id}/confirm`);
  console.log(`task ${t.id}`);
  await waitFor(t.id);
});

program.command("list").option("--status <s>").option("--limit <n>", "", "20").action(async (o: { status?: string; limit: string }) => {
  const rows = await api("GET", `/tasks?limit=${o.limit}${o.status ? `&status=${o.status}` : ""}`);
  for (const t of rows) console.log(`${short(t.id)}  ${t.status.padEnd(10)} ${(t.action ?? t.goal ?? "").slice(0, 50).padEnd(50)} ${t.note ?? ""}${t.error ? ` ! ${t.error}` : ""}`);
});

program.command("logs <id>").option("-f, --follow").action(async (id: string, o: { follow?: boolean }) => {
  let after = 0;
  for (;;) {
    const ev = await api("GET", `/tasks/${id}/events?after=${after}`);
    for (const e of ev) {
      after = e.id;
      console.log(`${new Date(e.ts).toISOString()}  ${e.type.padEnd(14)} ${JSON.stringify(e.payload)}`);
    }
    if (!o.follow) return;
    const t = await api("GET", `/tasks/${id}`);
    if (DONE.has(t.status)) return;
    await sleep(1500);
  }
});

program.command("stop <id>").action(async (id: string) => console.log(await api("POST", `/tasks/${id}/stop`)));
program.command("stop-all").description("KILL SWITCH: stop all tasks and disable all schedules (admin token)").action(async () => console.log(await api("POST", "/stop-all")));
program.command("status").action(async () => console.log(JSON.stringify(await api("GET", "/status"), null, 2)));
program.command("cost").description("AI usage today: tokens, and dollars for models you set prices for").action(async () => {
  const c = await api("GET", "/cost");
  console.log(`tokens today: ${c.tokensToday} / ${c.tokenBudget}   usd today: $${c.usdToday}${c.usdBudget ? ` / $${c.usdBudget}` : ""}`);
  for (const m of c.byModel) console.log(`  ${m.provider}/${m.model}  ${m.calls} calls  in ${m.input_tokens} out ${m.output_tokens}  ${m.priced ? `$${m.usd}` : "(no price set)"}`);
});
program.command("digest").description("Summary of the last 24h: done, failed, waiting on you, AI spend").option("--hours <n>", "", "24").action(async (o: { hours: string }) => {
  console.log((await api("GET", `/digest?hours=${o.hours}&text=1`)).text);
});
program.command("actions").action(async () => {
  for (const a of await api("GET", "/actions")) console.log(`${a.name.padEnd(28)} [${a.risk}] ${a.description}`);
});

const sched = program.command("schedule").description("Cron schedules (admin token)");
sched
  .command("add <cron> [pairs...]")
  .description('Either --action <name> key=value..., or --agent --goal "..." [--role R] [--act] [--plan] [--verify]')
  .option("--action <action>", "deterministic action (zero AI)")
  .option("--agent", "run an AI agent on this schedule")
  .option("--goal <goal>", "the agent's goal")
  .option("--role <role>", "agent role", "general")
  .option("--act", "agent may perform real actions through host policy")
  .option("--plan")
  .option("--verify")
  .option("--tz <timezone>", "IANA timezone", "UTC")
  .action(async (cron: string, pairs: string[], o: { action?: string; agent?: boolean; goal?: string; role: string; act?: boolean; plan?: boolean; verify?: boolean; tz: string }) => {
    if (o.agent) {
      if (!o.goal) return void console.error("--agent needs --goal");
      console.log(await api("POST", "/schedules", { cron, timezone: o.tz, goal: o.goal, agent: { role: o.role, act: Boolean(o.act), plan: Boolean(o.plan), verify: Boolean(o.verify) } }));
    } else if (o.action) {
      console.log(await api("POST", "/schedules", { cron, timezone: o.tz, action: o.action, input: kv(pairs) }));
    } else console.error("Use --action <name> or --agent --goal <text>");
  });
sched.command("list").action(async () => console.log(await api("GET", "/schedules")));
sched.command("rm <id>").action(async (id: string) => console.log(await api("DELETE", `/schedules/${id}`)));

const recipe = program.command("recipe").description("Saved zero-token step lists (admin token)");
recipe.command("add <name> <stepsJson>").description('stepsJson e.g. \'[{"action":"email.send","input":{"to":"a@b.com","subject":"x","body":"y"}}]\'').action(async (name: string, stepsJson: string) => {
  console.log(await api("PUT", `/recipes/${encodeURIComponent(name)}`, { steps: JSON.parse(stepsJson) }));
});
recipe.command("promote <taskId> <name>").description("Turn the real actions an agent performed (started with --act) into a zero-token recipe").action(async (taskId: string, name: string) => {
  console.log(await api("POST", "/recipes/promote", { taskId, name }));
});
recipe.command("list").action(async () => console.log(await api("GET", "/recipes")));

program.command("config <key> <value>").description("Set a config value. Supported: max_concurrent").action(async (key: string, value: string) => {
  console.log(await api("PUT", `/config/${key}`, { value }));
});

program.parseAsync().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
