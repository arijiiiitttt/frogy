#!/usr/bin/env bash
# End-to-end test with REAL processes: fake Google + host + controller + CLI.
# Needs a Postgres reachable at $E2E_DATABASE_URL (default: postgres://frogy:frogy@127.0.0.1:5432/frogy).
#   docker run -d -p 5432:5432 -e POSTGRES_USER=frogy -e POSTGRES_PASSWORD=frogy -e POSTGRES_DB=frogy postgres:16
set -u
cd "$(dirname "$0")/.."
npm run build >/dev/null || exit 1
W=$(mktemp -d); PIDS=()
cleanup() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done; rm -rf "$W"; }
trap cleanup EXIT
DB=${E2E_DATABASE_URL:-postgres://frogy:frogy@127.0.0.1:5432/frogy}
PASS=e2e-test-passphrase-123
# Start from a clean database so leftovers from earlier runs cannot interfere.
DATABASE_URL=$DB node --input-type=module -e "import pg from 'pg'; const c=new pg.Client({connectionString:process.env.DATABASE_URL}); await c.connect(); await c.query('DROP TABLE IF EXISTS tasks,events,schedules,llm_calls,recipes,cache,settings,memory CASCADE'); await c.end();" || exit 1
npx tsx test/e2e-prepare-host.ts "$W/host" || exit 1
node test/e2e-fake-google.mjs > "$W/fake.log" 2>&1 & PIDS+=($!)
node test/e2e-fake-llm.mjs > "$W/llm.log" 2>&1 & PIDS+=($!)
node test/e2e-fake-telegram.mjs > "$W/tg.log" 2>&1 & PIDS+=($!)
node test/e2e-fake-mcp.mjs > "$W/mcp.log" 2>&1 & PIDS+=($!)
cat > "$W/frogy.mcp.json" <<CFG
{ "servers": { "docs": { "url": "http://127.0.0.1:9914/mcp", "headersEnv": { "Authorization": "MCP_DOCS_AUTH" }, "roles": ["general"],
  "tools": { "search": { "access": "read" }, "create_ticket": { "access": "write" } } } } }
CFG
printf 'House style: always answer in exactly three bullet points. Sign off with "-- Frogy".\n' > "$W/skill.md"
cat > "$W/frogy.config.json" <<CFG
{ "providers": { "fake": { "type": "openai-compat", "baseUrl": "http://127.0.0.1:9912/v1", "keyEnv": "FAKE_KEY" } },
  "tiers": { "cheap": ["fake/m-cheap"], "mid": ["fake/m-mid"], "strong": ["fake/m-strong"] },
  "prices": { "fake/m-cheap": { "in": 1.0, "out": 5.0 }, "fake/m-mid": { "in": 3.0, "out": 15.0 } } }
CFG
HOST_DATA_DIR="$W/host" HOST_PORT=8787 HOST_ADMIN_PORT=8788 FROGY_HOST_PASSPHRASE=$PASS \
  GMAIL_API_BASE=http://127.0.0.1:9911 GOOGLE_TOKEN_URL=http://127.0.0.1:9911/token \
  node dist/host/main.js serve > "$W/host.log" 2>&1 & PIDS+=($!)
DATABASE_URL=$DB API_TOKEN=run-token-123 ADMIN_TOKEN=admin-token-456 HOST_URL=http://127.0.0.1:8787 \
  HOST_TOKEN=frogy_e2e_host_token FROGY_CONFIG="$W/frogy.config.json" FAKE_KEY=x FROGY_MCP_CONFIG="$W/frogy.mcp.json" MCP_DOCS_AUTH="Bearer mcp-secret" SCHEDULER_TICK_SECONDS=2 TELEGRAM_BOT_TOKEN=123456789:AAA-fake-token-value-for-e2e-0000000 TELEGRAM_CHAT_ID=42 TELEGRAM_CONTROL=true TELEGRAM_API_BASE=http://127.0.0.1:9913 PORT=8080 MAX_CONCURRENT=3 LOCKED_POLL_SECONDS=3 APPROVAL_POLL_SECONDS=3 \
  node dist/controller/main.js > "$W/ctl.log" 2>&1 & PIDS+=($!)
for i in $(seq 1 30); do curl -sf localhost:8080/healthz >/dev/null && break; sleep 0.5; done
export FROGY_URL=http://127.0.0.1:8080 FROGY_TOKEN=admin-token-456
F="node dist/cli/main.js"
AK=$(cat "$W/host/admin.key")
adm() { curl -sf -X POST -H "x-admin-key: $AK" ${2:+-H 'content-type: application/json' -d "$2"} "http://127.0.0.1:8788$1" || { echo "ADMIN CALL FAILED: $1"; return 1; }; }
step() { echo; echo "=== $* ==="; }
sql() { DATABASE_URL=$DB node --input-type=module -e "import pg from 'pg'; const c=new pg.Client({connectionString:process.env.DATABASE_URL}); await c.connect(); const r=await c.query(process.argv[1]); console.log(JSON.stringify(r.rows)); await c.end();" "$1"; }
wait_status() { for i in $(seq 1 ${3:-30}); do S=$($F list --limit 40 | grep "^${1:0:8}" | awk '{print $2}'); [ "$S" = "$2" ] && break; sleep 1; done; echo "status: $S"; }

step "1. dry run (zero AI, nothing sent)";            $F do email.send to=a@corp.io subject="Dry run" body=hello --dry-run
step "2. real send to allowlisted domain";            $F do email.send to=a@corp.io subject="Real send" body=hello --key e2e-1
step "3. same idempotency key again (must NOT send)"; $F do email.send to=a@corp.io subject="Real send" body=hello --key e2e-1
step "4. new recipient -> needs approval"
ID=$($F do email.send to=stranger@x.com subject="Needs approval" body=hi --no-wait | awk '/^task/{print $2}')
sleep 5; $F logs "$ID" | grep -E "deferred|queued" | head -3
AP=$(curl -s -H "x-admin-key: $AK" http://127.0.0.1:8788/admin/status | node -pe 'JSON.parse(require("fs").readFileSync(0)).pendingApprovals[0]?.id')
echo "pending approval id: $AP"; adm "/admin/approvals/$AP/approve" >/dev/null; echo "(approved on host)"
for i in $(seq 1 20); do S=$($F list --limit 5 | grep "^${ID:0:8}" | awk '{print $2}'); [ "$S" = succeeded ] && break; sleep 1; done; echo "task status after approval: $S"
step "5. vault locked -> task waits, then runs after unlock"
adm /admin/lock >/dev/null; echo "(vault locked)"
ID=$($F do email.send to=b@corp.io subject="After unlock" body=hi --no-wait | awk '/^task/{print $2}')
sleep 5; $F logs "$ID" | grep -E "deferred" | head -2
adm /admin/unlock "{\"passphrase\":\"$PASS\"}" >/dev/null; echo "(vault unlocked)"
for i in $(seq 1 20); do S=$($F list --limit 5 | grep "^${ID:0:8}" | awk '{print $2}'); [ "$S" = succeeded ] && break; sleep 1; done; echo "task status after unlock: $S"
step "6. recipe (zero tokens): saved steps run by name"
$F recipe add welcome '[{"action":"email.send","input":{"to":"c@corp.io","subject":"Welcome","body":"hi"}}]'
$F run welcome
step "7. free text with no matching action fails clearly (one cheap call, no execution)"; $F run "email my boss" 2>&1 | head -5

step "A. agent (researcher): tool call -> memory_save -> finish"
$F agent "research the pricing of widgets" --role researcher | grep -E "SUCCEEDED|result|steps|error"
step "B. orchestrator spawns 2 parallel researcher sub-agents, waits, combines"
OID=$($F agent "compare topic A and topic B" --role orchestrator --no-wait | awk '/^agent/{print $2}')
for i in $(seq 1 60); do S=$($F list --limit 20 | grep "^${OID:0:8}" | awk '{print $2}'); [ "$S" = succeeded ] || [ "$S" = failed ] && break; sleep 1; done
$F agents "$OID"
step "C. prompt-injection / SSRF: agent tries to fetch an internal address"
$F agent "fetch-local please" --role researcher | grep -E "SUCCEEDED|result|error"
SENT0=$(grep -c "FAKE-GMAIL" "$W/fake.log")
step "D. operator WITHOUT --act: must be a dry run, nothing sent"
$F agent "email bob@corp.io about lunch" --role operator | grep -E "SUCCEEDED|result|error"
echo "emails sent during D: $(( $(grep -c FAKE-GMAIL "$W/fake.log") - SENT0 ))"
step "E. operator WITH --act (admin) to an allowlisted recipient: really sends"
EID=$($F agent "email carol@corp.io about lunch" --role operator --act --no-wait | awk '/^agent/{print $2}')
wait_status "$EID" succeeded
echo "emails sent during E: $(( $(grep -c FAKE-GMAIL "$W/fake.log") - SENT0 ))"
step "J. promote that agent run into a zero-token recipe, then replay it with NO AI"
$F recipe promote "$EID" carol-lunch
echo "before replay: $($F cost | head -1)"
$F run carol-lunch | grep -E "SUCCEEDED|route"
echo "after replay : $($F cost | head -1)   <- token count must be unchanged"
echo "emails sent since D: $(( $(grep -c FAKE-GMAIL "$W/fake.log") - SENT0 ))   <- carol twice"
step "F. operator --act to a NEW recipient: waits for owner approval, then sends"
AID=$($F agent "email dave@new.com about lunch" --role operator --act --no-wait | awk '/^agent/{print $2}')
sleep 6; $F agents "$AID" | head -3
AP=$(curl -s -H "x-admin-key: $AK" http://127.0.0.1:8788/admin/status | node -pe 'JSON.parse(require("fs").readFileSync(0)).pendingApprovals[0]?.id')
echo "pending approval id: $AP"; adm "/admin/approvals/$AP/approve" >/dev/null; echo "(approved on host)"
for i in $(seq 1 30); do S=$($F list --limit 30 | grep "^${AID:0:8}" | awk '{print $2}'); [ "$S" = succeeded ] && break; sleep 1; done; echo "agent status after approval: $S"
step "G. run-role token cannot start an acting agent"
FROGY_TOKEN=run-token-123 $F agent "email x@corp.io hi" --role operator --act --no-wait 2>&1 | head -2
step "H. agent asks the human, owner answers, agent continues"
HID=$($F agent "ask-me something" --no-wait | awk '/^agent/{print $2}')
sleep 5; $F agents "$HID" | head -3
$F answer "$HID" blue
for i in $(seq 1 30); do S=$($F list --limit 30 | grep "^${HID:0:8}" | awk '{print $2}'); [ "$S" = succeeded ] && break; sleep 1; done
$F agents "$HID" | head -3
step "I. token usage is tracked (budget enforced per day)"; $F cost | head -12

step "K. scheduled AGENT fires from cron and runs (cron slot forced due)"
$F schedule add "0 3 * * *" --agent --goal "scheduled research topic Z" --role researcher | grep -oE "id: '[0-9a-f-]+'"
SID=$(curl -s -H "authorization: Bearer admin-token-456" localhost:8080/schedules | node -pe 'JSON.parse(require("fs").readFileSync(0))[0].id')
sql "UPDATE schedules SET next_run_at = now() - interval '5 seconds' WHERE id='$SID'" >/dev/null
for i in $(seq 1 25); do L=$($F list --limit 40 | grep "scheduled research"); echo "$L" | grep -q succeeded && break; sleep 1; done; echo "$L" | cut -c1-90
step "L. --verify: reviewer rejects once, agent corrects, then accepted (exactly one review)"
VID=$($F agent "verify-fail-once report" --verify --no-wait | awk '/^agent/{print $2}')
wait_status "$VID" succeeded
$F logs "$VID" | grep -E "reviewed" | cut -c1-150
step "M. digest"; $F digest
step "N. Telegram control: owner chat is obeyed, a foreign chat is ignored, no command starts work"
PUSH() { curl -s -X POST localhost:9913/_push -H 'content-type: application/json' -d "$1" >/dev/null; }
PUSH '{"update_id":1,"message":{"text":"/status","chat":{"id":42,"type":"private"}}}'
PUSH '{"update_id":2,"message":{"text":"/stopall confirm","chat":{"id":99,"type":"private"}}}'
PUSH '{"update_id":3,"message":{"text":"/do email.send to=x@y.com","chat":{"id":42,"type":"private"}}}'
sleep 4
curl -s localhost:9913/_sent | node -e 'const m=JSON.parse(require("fs").readFileSync(0)); const t=m.map(x=>x.text); console.log("owner /status reply:", t.some(x=>x.startsWith("Tasks:"))); console.log("foreign chat obeyed (KILL SWITCH seen):", t.some(x=>x.includes("KILL SWITCH"))); console.log("/do refused (help shown):", t.some(x=>x.startsWith("Commands:")));'
echo "schedules still enabled: $(sql "SELECT count(*) AS n FROM schedules WHERE enabled")"

step "O. MCP + taint: an agent reads untrusted MCP output, then wants to email -> it must wait for YOUR approval"
S0=$(grep -c FAKE-GMAIL "$W/fake.log")
OID2=$($F agent "mcp-demo please" --role general --act --no-wait | awk '/^agent/{print $2}')
sleep 7; $F agents "$OID2" | head -3 | cut -c1-170
echo "emails sent while waiting: $(( $(grep -c FAKE-GMAIL "$W/fake.log") - S0 ))   <- must be 0"
$F approvals | head -2 | cut -c1-170
APID=$($F approvals | awk 'NR==1{print $1}')
$F approve "$APID" >/dev/null; wait_status "$OID2" succeeded
echo "emails sent after approval: $(( $(grep -c FAKE-GMAIL "$W/fake.log") - S0 ))   <- must be 1"
$F logs "$OID2" | grep -E "tainted|injection_suspected|approval_" | awk '{print $2, $3, $4, $5}' | cut -c1-120
step "R. same flow but the owner DENIES: the email is never sent and the agent is told why"
S1=$(grep -c FAKE-GMAIL "$W/fake.log")
DID=$($F agent "mcp-demo again" --role general --act --no-wait | awk '/^agent/{print $2}')
sleep 7; APID=$($F approvals | awk 'NR==1{print $1}'); $F deny "$APID" >/dev/null; wait_status "$DID" succeeded
$F agents "$DID" | grep "=" | cut -c1-150
echo "emails sent: $(( $(grep -c FAKE-GMAIL "$W/fake.log") - S1 ))   <- must be 0"
step "P. MCP write tool without --act is a dry run (the server is never asked), and non-allowlisted tools are invisible"
$F agent "mcp-write please" --role general | grep -E "result" | cut -c1-170
echo "server saw: $(curl -s localhost:9914/_calls)   <- create_ticket and delete_everything must be absent"
step "Q. skills: loaded on demand, only when the agent asks"
$F skill add house-style --desc "How to format every answer" --file "$W/skill.md"
$F skill list
$F agent "skill-demo" --role general | grep -E "result" | cut -c1-170
step "8. run-role token cannot run destructive actions or admin endpoints"
FROGY_TOKEN=run-token-123 $F do instagram.unfollow username=someone --no-wait 2>&1 | head -2
FROGY_TOKEN=run-token-123 $F stop-all 2>&1 | head -2
step "9. instagram.unfollow is disabled on the host by default"; $F do instagram.unfollow username=someone 2>&1 | head -4
step "10. kill switch"; $F stop-all
step "11. wrong token rejected"; FROGY_TOKEN=wrong $F status 2>&1 | head -2
step "emails the fake Gmail actually received"; cat "$W/fake.log"
step "host audit log verifies"; HOST_DATA_DIR="$W/host" node dist/host/main.js verify-audit
step "no secrets in logs"; if grep -rqE "e2e-fake-refresh|ya29\.fake|AAA-fake-token|$PASS" "$W"/host.log "$W"/ctl.log "$W"/host/audit.jsonl; then echo "LEAK FOUND"; else echo "none found"; fi
