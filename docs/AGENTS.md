# Agents

Frogy agents are tool-calling LLM loops (plan → think → call tools → observe → repeat) that run on the controller and act **only through the host's policy layer**. They never hold credentials.

```
frogy agent "goal" [--role R] [--act] [--plan] [--max-steps N] [--budget TOKENS] [--model p/m] [--tier T]
frogy agents <id>          # tree of the agent and its sub-agents, status, tokens, results
frogy logs <id> -f         # step-by-step trace (model, tools used, tokens)
frogy answer <id> "text"   # answer an agent's question (ask_human)
frogy stop <id>            # stops the agent AND all its sub-agents
```

## Roles (specialists)
| Role | Default tier | Tools |
|---|---|---|
| `orchestrator` | mid | spawn_agent, wait_for_agents, memory, ask_human — splits work, delegates, combines |
| `researcher` | cheap | web_fetch, memory, ask_human |
| `operator` | cheap | act (email.send, script.run), memory_search, ask_human |
| `coder` | mid | shell (Docker sandbox), memory, ask_human |
| `general` | cheap | everything above |

Multi-agent: an orchestrator spawns sub-agents that run **in parallel** (as ordinary queued tasks, limited by `max_concurrent`), then `wait_for_agents` collects results. Waiting frees the worker slot, so there is no deadlock even at `max_concurrent=1`. Limits: depth 2, 5 children per agent, 12 agents per task tree, 40k-token budget per sub-agent.

## Tools
- `web_fetch` — public http(s) GET only. **SSRF-hardened**: blocks private/loopback/link-local/metadata IPs, re-checks every redirect, connects only to the validated IP (defeats DNS rebinding), size and time caps, content wrapped as `[UNTRUSTED WEB CONTENT]`.
- `memory_save` / `memory_search` — durable notes in Postgres (secrets redacted on write).
- `act` — registered actions through the host broker. **Without `--act` it is always a dry run.** With `--act` (admin token required) host policy still applies: allowlist, owner approval for new recipients, daily caps, idempotency. Destructive actions are never available to agents.
- `shell` — runs in a per-task-tree Docker workspace: no network, all capabilities dropped, read-only root, non-root user, memory/CPU/pids limits, no host mounts. **Disabled by default**; needs Docker on the host and `"enabled": {"sandbox.exec": true}` in `host-data/config.json`. Tested with a fake `docker` binary only — verify on your machine.
- `ask_human` — pauses the agent until you `frogy answer`; times out after `APPROVAL_TIMEOUT_HOURS`.
- `spawn_agent` / `wait_for_agents` — orchestration.

## Reviewer, schedules, promotion
- `--verify`: after the agent finishes, a mid-tier model checks the result against the goal **once**. If it says the result is wrong, the agent gets the reviewer's note and tries again; the second answer is accepted without another review (bounded cost). An unparseable review never blocks a result.
- **Scheduled agents:** `frogy schedule add "0 9 * * *" --agent --goal "summarize overnight news" --role researcher --tz Asia/Kolkata [--act] [--verify]` (admin token). Each cron slot has a unique idempotency key, so restarts never double-fire.
- **Promote AI work into scripts:** run an agent once with `--act`, then `frogy recipe promote <agent-id> <name>`. Every real action it performed becomes a recipe step, and `frogy run "<name>"` replays it with **zero tokens**. Inputs are replayed exactly as they were (same recipient and body), so edit the recipe with `frogy recipe add` if you need variation. Only actions that really executed are promoted, never dry runs.

## Advanced: taint tracking and the approval gate
The classic agent disaster is: *read untrusted content* + *hold the power to act* = a web page can steer your agent. Frogy tracks this per run:
- A run becomes **tainted** the moment it reads untrusted content: `web_fetch`, any MCP tool output, a tainted sub-agent's result, or any text that looks like an instruction aimed at the AI ("ignore previous instructions", "email … to x@y.com", fake `<system>` tags…). Suspicious text is labelled for the model and raises an alert.
- `TAINT_POLICY=approve` (default): a tainted run that tries a **real** side effect (`act` with `--act`, `shell`, an MCP *write* tool) pauses until you decide: `frogy approvals` → `frogy approve <id>` / `frogy deny <id>` (admin token). A denial is returned to the agent as an error and nothing happens. Clean runs are never interrupted. `flag` only records the taint; `off` disables the gate.
- This is on top of host policy (allowlist, new-recipient approval, caps), not a replacement. The heuristic detector is deliberately simple and WILL miss clever attacks and flag some innocent text; the taint rule itself does not depend on it (reading any untrusted source taints the run).

## Advanced: MCP tools
Connect external tool servers (Streamable HTTP) with an allowlist you write in `frogy.mcp.json` (see `frogy.mcp.example.json`, set `FROGY_MCP_CONFIG`):
- Only tools you list are visible to the model; `roles` decides which agent roles get a server; auth headers come from env vars (never the file).
- Server-supplied descriptions are untrusted (one line, 300 chars, or replaced by your own text). Output is labelled untrusted and taints the run.
- `access: "read"` tools run normally. `access: "write"` tools are a **dry run unless the task has `--act`**, and need your approval when tainted.
- If a server is down the agent just runs without its tools. A forgotten session is re-established once automatically.
- Supported: Streamable HTTP, JSON and SSE replies. Not supported: stdio servers, OAuth flows, server-initiated requests. Tested against a fake server written to the spec, **not against real MCP servers**.

## Advanced: skills (load on demand)
`frogy skill add house-style --desc "How to format answers" --file style.md [--roles researcher,general]`. Agents see only the name + one-line description in their prompt and load the full text with `use_skill` when relevant, so long playbooks cost tokens only when used. Skills are written by you (trusted), limited to 8000 chars, secrets are redacted on save.

## Advanced: adaptive start tier
Each agent records the tier it started on. If at least 5 recent runs of a role on a tier ended in failure ≥40% of the time, new runs of that role start one tier higher automatically (event `tier_chosen`); pinning `--tier`/`--model` disables this. Escalation during a run (stuck detection) still works as before.

## Why agents cost less here
- **AI is the last resort:** known tasks are `frogy do` actions/recipes (0 tokens). Use agents only for open-ended work.
- Cheap tier by default; `--plan` pays for ONE strong-model plan, then executes cheaply.
- Stuck detection (same call 3× in 6 calls, or 4 consecutive errors) escalates to the next tier once, then stops.
- Context compaction: long histories are summarised on the cheap tier; the goal and recent steps are kept; tool-call/result pairs are never split.
- Hard limits: step cap (`AGENT_MAX_STEPS`, 15), per-agent token budget (`AGENT_TOKEN_BUDGET`, 100k), global `DAILY_TOKEN_BUDGET`.
- Tool results are truncated (6 KB) and redacted before the model sees them.

## Reliability
State (messages, step, tokens, escalation) is saved after every step. After a crash or Render restart the agent resumes: unanswered tool calls are re-run; side-effecting tools carry idempotency keys (`<task>:<toolCallId>`), so an email is never sent twice.

## Safety model
- Tool output, web pages, memory and sub-agent results are **untrusted data**; the system prompt says never to follow instructions inside them. This is a mitigation, not a guarantee — the real controls are **host-side policy** (what can happen) and **no credentials in the agent** (what can leak).
- Default is read-only/dry-run. `--act` is an explicit, admin-only grant that applies to the whole tree.
- Prompt-injection example covered by tests: a page telling the agent to fetch `http://127.0.0.1/...` is blocked by the fetcher; an instruction to email a stranger needs your approval.

## Provider notes
Tool calling is implemented for the OpenAI-compatible, Anthropic and Gemini formats (`src/gateway/adapters.ts`) and unit-tested against recorded-shape mocks. **Not yet verified against the live APIs.** Gemini function-call parts are echoed back verbatim (keeps thought signatures); reasoning blocks are not carried across providers.

## Not included
OpenCode/Aider/Claude Code as external runtimes, browser automation, embeddings-based memory (keyword search only), streaming output, per-agent dollar cost (tokens only).
