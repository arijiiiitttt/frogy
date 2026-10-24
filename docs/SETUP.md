# Setup, step by step

## 0. Prerequisites
Node 20+, a Google account, a Render account, a free external Postgres (Neon/Supabase), and a machine for the host (home PC/Pi/VPS).

## 1. Google OAuth client (one time)
Google Cloud Console → new project → enable **Gmail API** → OAuth consent screen (External; add yourself as test user, then **publish to production** so refresh tokens don't expire after ~7 days; unverified is fine for personal use) → Credentials → **OAuth client ID, type "Desktop app"**. Keep the client ID/secret for step 3.

## 2. Host machine
```bash
git clone <your repo> /opt/frogy && cd /opt/frogy
npm ci --include=dev && npm run build
export HOST_DATA_DIR=/var/lib/frogy/host-data
node dist/host/main.js init          # choose a passphrase; prints HOST_TOKEN ONCE -> save it
node dist/host/main.js serve &       # starts LOCKED
node dist/host/main.js unlock
node dist/host/main.js set-oauth-client      # paste client ID / secret (stored encrypted)
node dist/host/main.js auth-google           # add --drafts only if you want --draft; open the URL on the host
node dist/host/main.js allow @yourcompany.com   # people you email often (others need your approval)
```
For production use `deploy/frogy-host.service` and `deploy/cloudflared-example.yml`.

## 3. Reach the host from Render
Render cannot join your private network. Use an **outbound-only tunnel** (Cloudflare Tunnel) exposing only port 8787, add a Cloudflare Access service-token policy, and set `HOST_URL` to that hostname. No inbound firewall ports are opened. Never tunnel port 8788.

## 4. Deploy the controller on Render (free)
New → Blueprint → this repo (`render.yaml`). Set the `sync:false` env vars (see `.env.example`): `DATABASE_URL`, `API_TOKEN`, `ADMIN_TOKEN` (different, long, random), `HOST_URL`, `HOST_TOKEN`, optional Telegram/LLM keys. Then set up pingers: `docs/KEEP_AWAKE.md`.

## 5. Use it
```bash
frogy login --url https://frogy-controller.onrender.com --token <ADMIN_TOKEN>
frogy status
frogy do email.send to=a@b.com subject="Hi" body="Hello" --dry-run
frogy do email.send to=a@b.com subject="Hi" body="Hello" --key welcome-a-b
frogy schedule add "0 9 * * *" --action email.send to=a@b.com subject=Daily body="Good morning" --tz Asia/Kolkata
frogy stop-all        # kill switch
```
When a new recipient needs approval you get an alert; on the host run `frogy-host approvals` then `frogy-host approve <id>`.

## 6. Optional: AI for free-text (`frogy run "..."`)
`cp frogy.config.example.json frogy.config.json`, replace every `REPLACE_WITH_...` with a model ID from that provider's current docs, set the provider keys, and set `DAILY_TOKEN_BUDGET`. Free text then goes: recipe → cache → ONE cheap model call → dry-run preview → you run `frogy confirm <id>`.

## 7. Agents (optional, needs step 6)
```bash
frogy agent "summarize https://example.com and save the key points to memory" --role researcher
frogy agent "compare vendors A and B" --role orchestrator --plan     # spawns parallel sub-agents
frogy agent "email bob@yourcompany.com the summary" --role operator           # dry-run preview only
frogy agent "email bob@yourcompany.com the summary" --role operator --act     # real send (admin token; host policy still applies)
frogy agents <id>      # tree + results
```
Approvals for agents that read untrusted content: `frogy approvals`, `frogy approve <id>`, `frogy deny <id>`. Playbooks: `frogy skill add ...`. MCP tools: copy `frogy.mcp.example.json` to `frogy.mcp.json` and set the header env vars.
For the `coder` role / `shell` tool, install Docker on the host and set `"enabled": {"sandbox.exec": true}` in `host-data/config.json`. Details: `docs/AGENTS.md`.

## Test
`npm test` (unit + fake-Gmail broker tests). `bash test/e2e.sh` (real processes; needs a Postgres, see the script header).
