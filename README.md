<p align="center">
  <a>
       <img alt="frogy logo" src="public/frogy.png" width="150">
  </a>
</p>
<p align="center">
 a task first agent sandbox: deterministic actions first, AI last 
</p>


<p align="center">
  <a href="#run-it"><img alt="Node" src="https://img.shields.io/badge/node-20%2B-339933?style=flat-square&logo=nodedotjs&logoColor=white" /></a>
  <a href="#run-it"><img alt="TypeScript" src="https://img.shields.io/badge/typescript-strict-3178C6?style=flat-square&logo=typescript&logoColor=white" /></a>
  <a href="#architecture"><img alt="Fastify" src="https://img.shields.io/badge/fastify-5-000000?style=flat-square&logo=fastify&logoColor=white" /></a>
  <a href="#architecture"><img alt="Postgres" src="https://img.shields.io/badge/postgres-queue%20%2B%20state-4169E1?style=flat-square&logo=postgresql&logoColor=white" /></a>
  <a href="#hardware-notes"><img alt="Render" src="https://img.shields.io/badge/render-free%20tier-46E3B7?style=flat-square&logo=render&logoColor=black" /></a>
</p>


> **⚠️ Honest framing.** Frogy is a single user, self-hosted automation workbench, not a managed platform. There is no multi tenancy and no autoscaling. Known jobs (email, scripts) run as **deterministic actions with zero AI**; agents are the fallback for open-ended work. Instagram and LinkedIn actions are registered but **disabled and not implemented**, because automating them breaks their terms. Several integrations have only been tested against fakes (see [Known limitations](#known-limitations)).


## Table of contents

1. [Capabilities](#capabilities)
2. [Run it](#run-it)
3. [Using Frogy](#using-frogy)
4. [Configuration](#configuration)
5. [Services](#services)
6. [Hardware notes](#hardware-notes)
7. [Architecture](#architecture)
8. [Design decisions](#design-decisions)
9. [Project layout](#project-layout)
10. [Testing](#testing)
11. [Local development](#local-development)
12. [Extending](#extending)
13. [Troubleshooting](#troubleshooting)
14. [Known limitations](#known-limitations)



## Capabilities

**Deterministic tasks (zero AI, zero tokens)**

| Capability | Detail |
| --- | --- |
| `email.send` | Gmail API with send-only OAuth (PKCE); dry-run, drafts (opt-in scope), idempotency keys, header-injection protection |
| `script.run` | Runs pre-approved scripts from an allowlist, scrubbed environment, timeout, redacted output |
| `sandbox.exec` | Shell in a Docker container: no network, all capabilities dropped, read-only root, non-root, no host mounts. **Off by default** |
| Recipes | Saved step lists run by name with no AI; `recipe promote` turns a successful agent run into one |
| Schedules | Cron with timezone, for actions, goals and agents; each slot fires exactly once, even across restarts |
| Queue | Postgres queue with `max_concurrent`, retries, crash/restart recovery, `stop` and a global kill switch |

**Credentials and policy (the broker)**

| Capability | Detail |
| --- | --- |
| Encrypted vault | AES-256-GCM, key from your passphrase (scrypt); starts **locked**; tasks wait for `unlock` instead of failing |
| Host-side policy | Recipient allowlist, owner approval for new recipients, per-message recipient cap, daily caps, idempotency |
| Isolation | Credentials live only on your host; Render never holds them; admin API is loopback-only with a key file |
| Audit | Hash-chained, tamper-evident log (`verify-audit`); secrets redacted from every log, alert and prompt |
| Revocation | `revoke-google` deletes the token locally and at Google |

**Agents**

| Capability | Detail |
| --- | --- |
| Tool-calling loop | Plan (optional) → think → tool → observe → repeat, saved after every step, resumes after crashes |
| Roles | `orchestrator`, `researcher`, `operator`, `coder`, `general` |
| Multi-agent | Orchestrator spawns parallel sub-agents and collects results (depth 2, 5 children, 12 per tree) |
| Tools | `web_fetch` (SSRF-hardened), memory, `act`, `shell`, `ask_human`, `use_skill`, MCP tools |
| Quality controls | `--plan` (strong plan, cheap execution), `--verify` (one reviewer pass), stuck detection with tier escalation, context compaction |
| Skills | Owner-written playbooks loaded on demand, so long instructions cost tokens only when used |
| MCP client | Allowlisted servers and tools over Streamable HTTP; read tools free, write tools gated |
| Adaptive routing | New runs start one tier higher when a role keeps failing on the cheaper tier |

**Multi-model gateway**

| Capability | Detail |
| --- | --- |
| Providers | Anthropic, Gemini, and OpenAI-compatible endpoints (OpenAI, xAI/Grok, OpenRouter) |
| Routing | Cheap / mid / strong tiers, failover with backoff, circuit breaker, OpenRouter as last-resort for the *same* model |
| Tool calling | One neutral message format converted per provider |
| Budgets | Daily token cap, optional daily USD cap from prices you supply |

**Agent safety**

| Capability | Detail |
| --- | --- |
| Dry-run by default | Agents cannot act unless started with `--act` (admin token) |
| Taint tracking | Reading untrusted content (web, MCP, suspicious text, tainted sub-agents) taints the run |
| Approval gate | A tainted run's real side effects wait for `frogy approve <id>`; denial is returned to the agent |
| Injection flags | Instruction-like text is labelled as data and raises an alert |

**Operations**

| Capability | Detail |
| --- | --- |
| Digest | `frogy digest` and an optional daily push: done, failed, waiting on you, AI spend |
| Telegram | Alerts, plus `/status /tasks /digest /answer /stop /stopall confirm` from your private chat only |
| Free-tier friendly | One process, `/healthz` for pingers, external Postgres |
| Cost | Tokens per model, dollars where you set prices |



## Run it

You need **Node 20+**, a free external **Postgres** ([Neon](https://neon.tech) or Supabase), a Render account, and a machine for the **host** (home PC, Raspberry Pi or VPS). Docker is only needed for the optional `shell` sandbox.

```bash
# 1. host machine: create the encrypted vault and connect Google (once)
git clone <your repo> /opt/frogy && cd /opt/frogy
npm ci --include=dev && npm run build
export HOST_DATA_DIR=/var/lib/frogy/host-data
node dist/host/main.js init              # prints HOST_TOKEN once, save it
node dist/host/main.js serve &           # starts LOCKED
node dist/host/main.js unlock
node dist/host/main.js set-oauth-client  # Google OAuth client, type "Desktop app"
node dist/host/main.js auth-google

# 2. controller: deploy render.yaml to Render (free web service) and set the env vars
#    DATABASE_URL, API_TOKEN, ADMIN_TOKEN, HOST_URL, HOST_TOKEN  (see .env.example)

# 3. keep it awake: two external pingers on GET /healthz every 5 minutes (docs/KEEP_AWAKE.md)

# 4. use it
frogy login --url https://YOUR-APP.onrender.com --token <ADMIN_TOKEN>
frogy do email.send to=a@b.com subject="Hi" body="Hello" --dry-run
```

Full walkthrough with the tunnel setup: [`docs/SETUP.md`](docs/SETUP.md).

| Setup | Result |
| --- | --- |
| Host + Render free + Postgres | Full system: actions, schedules, recipes, agents |
| No `frogy.config.json` / provider keys | Everything works **except** AI (`frogy run`, `frogy agent`) |
| No Docker on the host | Everything works except the `shell` tool and the `coder` role |
| Vault locked (after a reboot) | Tasks needing credentials **wait**, then run after `frogy-host unlock` |
| No `DATABASE_URL` | Controller cannot start |



## Using Frogy

| Step | Command | What happens |
| --- | --- | --- |
| 1 | `frogy do <action> key=value` | Runs a deterministic action through the host broker (add `--dry-run`, `--key` for idempotency) |
| 2 | `frogy recipe add` / `frogy schedule add` | Save step lists; run actions or agents on a cron |
| 3 | `frogy run "free text"` | Recipe → cache → **one** cheap AI call to map text to an action; always shows a dry run, then `frogy confirm <id>` |
| 4 | `frogy agent "goal" --role R` | Starts an agent (dry-run unless `--act`); `--plan`, `--verify`, `--max-steps`, `--budget` |
| 5 | `frogy agents <id>` / `frogy logs <id> -f` | Sub-agent tree, step-by-step trace, results |
| 6 | `frogy approvals` / `approve` / `deny` · `frogy answer` | Decide on tainted-agent actions; answer an agent's question |
| 7 | `frogy digest` / `frogy cost` | What happened and what it cost |
| 8 | `frogy stop <id>` / `frogy stop-all` | Stop one task tree, or kill everything and disable all schedules |

On the host: `frogy-host unlock | lock | status | approvals | approve <id> | allow <email|@domain> | revoke-google | verify-audit`.

**Things to try**

- `frogy do email.send ... --dry-run`, then send for real with `--key welcome-1` twice: the second run does not send again
- Email a new address: it waits for `frogy-host approve <id>`
- `frogy agent "compare A and B" --role orchestrator`, then `frogy agents <id>` to watch parallel sub-agents
- Run an agent once with `--act`, then `frogy recipe promote <id> my-recipe` and replay it with `frogy run my-recipe` for 0 tokens
- Lock the vault, queue a send, unlock: the task completes by itself

| Role | Default tier | Tools |
| --- | --- | --- |
| `orchestrator` | mid | spawn_agent, wait_for_agents, memory, ask_human, use_skill |
| `researcher` | cheap | web_fetch, memory, ask_human, use_skill |
| `operator` | cheap | act, memory_search, ask_human, use_skill |
| `coder` | mid | shell, memory, ask_human, use_skill |
| `general` | cheap | all of the above |

Details: [`docs/AGENTS.md`](docs/AGENTS.md) and [`docs/OPERATIONS.md`](docs/OPERATIONS.md).



## Configuration

Controller environment variables (full list in `.env.example`):

| Option | Default | Why |
| --- | --- | --- |
| `MAX_CONCURRENT` | 5 | Tasks running at once; the rest queue |
| `DAILY_TOKEN_BUDGET` | 500000 | Hard stop for AI spend per UTC day |
| `DAILY_USD_BUDGET` | off | Dollar cap; needs `prices` in `frogy.config.json` |
| `TAINT_POLICY` | `approve` | Tainted agents need your OK for real side effects (`flag` / `off` available) |
| `AGENT_MAX_STEPS` / `AGENT_TOKEN_BUDGET` | 15 / 100000 | Per-agent limits |
| `SUBAGENT_MAX_STEPS` / `SUBAGENT_TOKEN_BUDGET` | 12 / 40000 | Per-sub-agent limits |
| `APPROVAL_TIMEOUT_HOURS` | 12 | Unanswered approvals and questions expire |
| `DIGEST_HOUR_UTC` | off | Push a daily digest at this hour |
| `TELEGRAM_CONTROL` | false | Obey commands from your private chat |
| `FROGY_CONFIG` / `FROGY_MCP_CONFIG` | `./frogy.config.json` / `./frogy.mcp.json` | Model tiers and prices / MCP servers |

Host policy (`host-data/config.json`, created by `init`):

| Option | Default | Why |
| --- | --- | --- |
| `allowedRecipients` | empty | People/domains (`@corp.com`) that can be emailed without approval |
| `requireApprovalForNewRecipients` | on | Unknown recipients wait for `frogy-host approve` |
| `maxRecipientsPerMessage` | 5 | Limits blast radius |
| `dailyCaps` | email 50, scripts 200, sandbox 200 | Hard per-action daily limits |
| `enabled` | all risky actions `false` | `sandbox.exec`, Instagram, LinkedIn are opt-in |
| `sandbox` | debian slim, 512m, 1 cpu, 60 s, network `none` | Docker limits for the `shell` tool |
| `scripts` | empty | Allowlisted scripts for `script.run` |

Model tiers go in `frogy.config.json` (copy `frogy.config.example.json`, replace every `REPLACE_WITH_...` with a model ID from that provider's current docs). Invalid input is rejected with `400` before anything is queued.



## Services

| Service | Where | Purpose |
| --- | --- | --- |
| Controller API | Render, `$PORT` (default 8080) | CLI/Telegram endpoint, queue worker, scheduler, agents |
| `/healthz` | Controller, no auth | Returns `{"ok":true}` only; for pingers |
| Host API | `127.0.0.1:8787` (`HOST_BIND`) | Action executor, bearer token; reached via an outbound tunnel |
| Host admin | `127.0.0.1:8788` | Unlock, approve, OAuth; **loopback only** + key file; never tunnel it |
| OAuth callback | `127.0.0.1:8789` | Temporary, only during `auth-google` |
| Postgres | External (Neon/Supabase) | Tasks, events, schedules, recipes, memory, skills, approvals |
| Telegram / MCP / LLM APIs | External, optional | Alerts and control / tools / models |



## Hardware notes

No GPU is involved: models are called over their APIs. What matters:

- **Render free tier:** one free web service fits the 750 monthly instance hours, which is why API, worker, scheduler and agents are **one process**. It sleeps after 15 minutes without inbound traffic, so use two external pingers. Render may restart it at any time; Frogy resumes unfinished work. Render's free Postgres expires, hence the external database.
- **Host machine:** anything that can run Node 20 and stay on (a Raspberry Pi is enough). It cannot be Render: the credential vault and the Docker sandbox must live on a machine you control.
- **Docker (optional):** needed only for `shell` / the `coder` role.
- **Reachability:** Render cannot join a private network, so the host API is exposed through an outbound-only tunnel (`deploy/cloudflared-example.yml`) with a Cloudflare Access policy on top. No inbound firewall port is opened.



## Architecture

```mermaid
flowchart LR
    CLI[frogy CLI / Telegram] -->|HTTPS + token| CTL[Controller on Render<br/>API, queue, scheduler, agents]
    CTL -->|rows, queue| PG[(Postgres)]
    CTL -->|chat + tools| GW[LLM gateway<br/>tiers, failover]
    GW --> PROV[Anthropic / Gemini / OpenAI / xAI / OpenRouter]
    CTL -->|allowlisted tools| MCP[MCP servers]
    CTL -->|HTTPS tunnel + bearer token| HOST[Host: credential broker]
    HOST --> VAULT[(Encrypted vault)]
    HOST -->|OAuth token| GMAIL[Gmail API]
    HOST --> DOCKER[Docker sandbox]
    HOST -->|policy, approvals, audit| AUDIT[(Audit log)]
    CTL -.->|alerts| TG[Telegram]
```

```
You run: frogy do email.send ...            (or: frogy agent "goal" --act)
        ↓
Controller validates input (zod), queues a task in Postgres
        ↓
Worker claims it (FOR UPDATE SKIP LOCKED), up to MAX_CONCURRENT at a time
        ↓
Known action  ->  call the host broker with an idempotency key (no AI)
Free text     ->  recipe -> cache -> one cheap intent call -> dry-run preview -> you confirm
Agent         ->  loop: LLM picks a tool -> tool runs (host policy applies) -> result back to the LLM
        ↓
Host broker: check policy (allowlist, approval, caps) -> use the vault token -> Gmail API -> audit log
        ↓
Vault locked? approval pending? -> the task WAITS and retries; nothing is lost
        ↓
Result and events stored in Postgres; alerts, digest and Telegram report the outcome
```



## Design decisions

- **AI is the last resort.** Known work is an action or recipe (0 tokens). Agents handle what is left, on the cheap tier by default, with hard step/token/USD budgets.
- **The agent never holds credentials.** Tokens live in the host's encrypted vault; agents ask the broker to act and get back "sent" or "denied". Render only stores your LLM keys.
- **Policy lives on the host, not in the model.** Allowlist, new-recipient approval, caps and idempotency are enforced where the credentials are, so a manipulated agent is still bounded.
- **Waiting is not failing.** A locked vault, a pending approval or an unanswered question defers the task (no attempt is burned) instead of erroring.
- **Idempotency everywhere.** Every action carries a key (`<task>:<step>` or your `--key`), so retries after a crash or restart never double-send.
- **Free tier by construction.** One process, Postgres as the queue, state saved after every agent step, tolerant of restarts.
- **Untrusted by default.** Web pages, MCP output and memory are labelled data; reading them taints the run, and a tainted run needs your approval before real side effects. The injection heuristic only raises flags; the taint rule is the boundary.
- **Single-tenant.** Two bearer tokens (run / admin). Real auth would replace `roleOf` in `src/controller/routes.ts`.
- **Kill switches.** `stop <id>` cascades to sub-agents; `stop-all` (admin) stops everything and disables schedules.



## Project layout

| Path | Role |
| --- | --- |
| `src/controller/` | Fastify API (`routes.ts`), worker, scheduler, agent tools, triage, digest, Telegram, DB migration |
| `src/host/` | Credential broker: `vault.ts`, `actions.ts` (policy), `google.ts`, `sandbox.ts`, `scripts.ts`, `audit.ts`, admin/API servers |
| `src/agent/` | Agent loop, roles, taint heuristic, tier routing, MCP client, SSRF-safe web fetch |
| `src/gateway/` | Provider adapters (OpenAI-compatible, Anthropic, Gemini), router, circuit breaker |
| `src/actions/` | Action registry (zod schemas) and the host client |
| `src/cli/` | `frogy` command |
| `src/shared/` | Redaction, alerts, helpers |
| `test/` | Unit/integration tests, fake Gmail/LLM/Telegram/MCP servers, `e2e.sh` |
| `deploy/` | systemd unit for the host, Cloudflare Tunnel example |
| `docs/` | `SETUP`, `SECURITY`, `AGENTS`, `OPERATIONS`, `KEEP_AWAKE`, `BROWSER_ACTIONS` |
| `render.yaml` | One free Render web service |
| `frogy.config.example.json` / `frogy.mcp.example.json` | Model tiers, prices / MCP servers |



## Testing

```bash
npm ci --include=dev
npm test
```

57 tests cover redaction, the vault (wrong passphrase, tampering), mail header injection, policy/approvals/caps/idempotency against a fake Gmail, the audit chain, provider message formats for tool calling, the agent loop (resume, stuck detection, compaction, limits, verify), SSRF blocking, the Docker argument builder, taint/approval gating, tier routing, Telegram commands, digest formatting and the MCP client against a fake server.

A real-process end-to-end script starts fake Google, LLM, Telegram and MCP servers plus the host, the controller and the CLI, and checks idempotency, approvals, lock/unlock, recipes, agents, sub-agents, SSRF, promotion, schedules, taint approval/denial, kill switch, audit integrity and a secret-leak scan:

```bash
docker run -d -p 5432:5432 -e POSTGRES_USER=frogy -e POSTGRES_PASSWORD=frogy -e POSTGRES_DB=frogy postgres:16
bash test/e2e.sh
```

There is no CI workflow in this repo yet.



## Local development

```bash
npm ci --include=dev && npm run build

# Host (terminal 1)
export HOST_DATA_DIR=./host-data
node dist/host/main.js init && node dist/host/main.js serve
node dist/host/main.js unlock                     # terminal 2

# Controller (terminal 3): needs Postgres, tokens and the host token from `init`
DATABASE_URL=postgres://frogy:frogy@127.0.0.1:5432/frogy API_TOKEN=run-123 ADMIN_TOKEN=admin-456 \
HOST_URL=http://127.0.0.1:8787 HOST_TOKEN=frogy_xxx npm run dev:controller

# CLI
FROGY_URL=http://127.0.0.1:8080 FROGY_TOKEN=admin-456 node dist/cli/main.js status
```

`npm run typecheck` runs the compiler without emitting.



## Extending

- **New action** — add a zod schema and hint in `src/actions/registry.ts`, a handler in `src/host/actions.ts` (policy, caps, audit), and a default cap in `src/host/state.ts`.
- **New agent role** — add it to `ROLES` in `src/agent/roles.ts`.
- **New agent tool** — add it in `src/controller/agent-tools.ts`; set `taints: true` if it returns untrusted content, and call `ctx.approve()` before any side effect.
- **New model / provider** — add tiers in `frogy.config.json`; new API shapes go in `src/gateway/adapters.ts`.
- **MCP server** — add it to `frogy.mcp.json` with an explicit tool allowlist and roles.
- **Playbook** — `frogy skill add`.
- **Browser automation** — read `docs/BROWSER_ACTIONS.md` first, then use the guards in `src/host/browser-guard.ts`.
- **Real multi-user auth** — replace `roleOf` in `src/controller/routes.ts`.



## Troubleshooting

| Problem | Fix |
| --- | --- |
| Controller exits at start | `API_TOKEN` / `ADMIN_TOKEN` missing or identical, or `DATABASE_URL` unset |
| Tasks show "waiting for vault unlock" | Run `frogy-host unlock` on the host |
| "waiting for owner approval" on an email | New recipient: `frogy-host approvals` then `frogy-host approve <id>` (or `frogy-host allow @domain`) |
| Agent waiting for approval | It read untrusted content first: `frogy approvals`, then `frogy approve <id>` |
| `400 llm_not_configured` | Create `frogy.config.json` and set provider keys |
| "No usable models" | Entries still contain `REPLACE_WITH...` or the provider key env var is not set |
| `403 admin_required` | `--act`, schedules, recipes, skills and `stop-all` need `ADMIN_TOKEN` |
| First request is slow, or service seems down | Free instance was asleep; add the pingers in `docs/KEEP_AWAKE.md` |
| `Host unreachable` | Check `HOST_URL`, the tunnel, and that `HOST_TOKEN` matches the one from `init` |
| Google `token_invalid` | Re-run `frogy-host auth-google`; publish your OAuth consent screen to production so refresh tokens do not expire |
| `--draft` is denied by Google | Authorise with `frogy-host auth-google --drafts` |
| `daily_cap` / `daily_token_budget_exceeded` | Raise the cap in host config / `DAILY_TOKEN_BUDGET`, or wait for the next UTC day |
| `shell` says the sandbox is disabled | Install Docker on the host and set `"enabled": {"sandbox.exec": true}` |
| Telegram commands ignored | `TELEGRAM_CONTROL=true`, and `TELEGRAM_CHAT_ID` must be your private chat id |



## Known limitations

- **Not verified against live services.** Tested against fakes and mocks: Google OAuth and Gmail, every LLM provider's tool-calling format, a real Docker daemon, real MCP servers, Telegram, and an actual Render/Neon deployment. Expect small fixes on first real contact.
- **Instagram / LinkedIn:** actions are registered but disabled, with no page automation. They have no official API for this and automation risks account restrictions.
- **MCP:** Streamable HTTP only (no stdio, no OAuth, no server-initiated requests).
- **Memory** is keyword search, not embeddings. No streaming output.
- **Injection detection is a heuristic** and will miss clever attacks and flag some innocent text; the taint-and-approve rule and host policy are what protect you. Read the approval summary before approving.
- **A model can still be steered into something your policy allows**, such as emailing an allowlisted address. Keep the allowlist tight and leave `--act` off unless needed.
- **`script.run` is process-level isolation** (allowlist, scrubbed env, timeout). Run the host in a container or VM for more.
- **`recipe promote` replays exact inputs** (same recipient and body); edit the recipe for variation.
- **Costs are tokens**, plus dollars only for models whose prices you enter; unpriced models count as $0.
- **Free tier is best effort:** Render may restart or sleep the service; pingers reduce but do not eliminate that.
- Single-user, no multi-tenancy, no autoscaling, Telegram is not end-to-end encrypted.
