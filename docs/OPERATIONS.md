# Operating Frogy day to day

## Morning digest
`frogy digest` prints the last 24h: done / failed / stopped, AI tokens (and dollars for models you priced), what is **waiting on you** (approvals, agent questions, locked vault) and failures.
Set `DIGEST_HOUR_UTC` (0-23) on the controller to push it once a day to Telegram / your webhook. (Asia/Kolkata is UTC+5:30, so 02 UTC is about 07:30 IST.)

## Dollar costs
Add prices you copy from each provider's pricing page (USD per 1M tokens) to `frogy.config.json`:
```json
"prices": { "anthropic/claude-haiku-5-5": { "in": 0.0, "out": 0.0 } }
```
(replace with real numbers). `frogy cost` then shows dollars per model. Models without a price show "(no price set)" and count as $0. `DAILY_USD_BUDGET=2` pauses all AI steps for the day once spend reaches it; `DAILY_TOKEN_BUDGET` is the token equivalent and needs no prices.

## Control from your phone (Telegram)
1. Create a bot with @BotFather, put its token in `TELEGRAM_BOT_TOKEN`, send it a message, and set `TELEGRAM_CHAT_ID` to your private chat id.
2. Set `TELEGRAM_CONTROL=true`. Alerts already arrive without it; this turns on commands.
3. Commands: `/status`, `/digest`, `/tasks`, `/answer <id> <text>`, `/stop <id>`, `/stopall confirm`.

Safety: only your private chat is obeyed (everything else is silently ignored), and there is deliberately **no command that starts work, sends mail, approves a recipient, or changes policy**. Approvals stay on the host (`frogy-host approve <id>`). Telegram is not end-to-end encrypted: alerts are redacted, but do not put secrets in answers.

## Overnight checklist
- Host unlocked (`frogy-host status`), Google connected, pingers green (docs/KEEP_AWAKE.md)
- `DAILY_TOKEN_BUDGET` (and ideally `DAILY_USD_BUDGET`) set; Telegram alerts working
- Agents scheduled **without** `--act` unless you really want them acting; recipients allowlisted tightly
- `frogy stop-all` / `/stopall confirm` reachable from your phone
