# Security model

## Where each secret lives
| Secret | Location | Form |
|---|---|---|
| Google refresh token, OAuth client secret | **Host only**, `host-data/vault.enc` | AES-256-GCM, key from your passphrase (scrypt N=2^16). Key exists only in memory while unlocked. |
| Vault passphrase | You (your head / password manager) | Never stored by default |
| Host API token | Hash on host (`config.json`), plaintext in Render env var `HOST_TOKEN` | 256-bit random |
| LLM API keys | Render env vars (controller only) | Never sent to host or sandboxes |
| CLI token | `FROGY_TOKEN` env var or `~/.config/frogy/config.json` (0600) | Prefer your OS keychain / password manager |
| Audit log | `host-data/audit.jsonl` (+ per-task events in Postgres) | Hash-chained, redacted |

**Render never holds Google/Instagram/LinkedIn credentials.** If Render is compromised the attacker can queue tasks (bounded by host policy) but cannot read the token.

## Layers (all must fail for a leak)
1. Encrypted vault + passphrase unlock; locked after every restart (unless you opt into auto-unlock).
2. Broker pattern: the agent/LLM only ever receives results ("sent"), never credentials.
3. Policy enforced **on the host**, not in the controller: recipient allowlist, per-message recipient cap, daily caps, owner approval for new recipients, idempotency.
4. Admin API (unlock, approve, OAuth) is loopback-only **and** needs a key file; unlock is rate-limited.
5. Host API needs a bearer token (constant-time compare, delayed on failure).
6. Send-only OAuth scope by default; `gmail.compose` only if you pass `--drafts`.
7. Redaction on every log, audit entry and alert; hash-chained audit (`frogy-host verify-audit`).
8. Header-injection protection in outgoing mail; strict zod validation of every input.
9. Risky actions (Instagram/LinkedIn) disabled by default, admin-token only.

## Agent-specific protections
- Agents have **no credentials**; they call the same host broker, so host policy (allowlist, approvals, caps, idempotency) bounds everything they do.
- Default is dry-run. `--act` requires the admin token and is granted per task tree. Destructive actions are never exposed to agents.
- `web_fetch` is SSRF-hardened (private/metadata IPs blocked, redirects re-validated, DNS pinned). All fetched content is labelled untrusted.
- Tool results are redacted and truncated before reaching the model; secrets never enter prompts, memory, or logs.
- Runaway control: step cap, per-agent and daily token budgets, stuck detection, depth/fan-out limits, `stop` cascades to sub-agents, global `stop-all`.
- `shell` runs in a no-network, cap-dropped, read-only-root Docker container with no host mounts; disabled unless you enable it.
- Residual risk: a model can still be manipulated by hostile text into doing something *allowed by policy* (e.g. emailing an allowlisted address). Keep allowlists tight and keep `--act` off unless needed.

## Taint tracking, MCP and skills
- Runs that read untrusted content (web, MCP, suspicious text, tainted sub-agents) cannot perform real side effects without your explicit approval (`TAINT_POLICY=approve`, default).
- MCP: allowlisted servers/tools only, secrets via env vars, descriptions treated as untrusted (tool-poisoning mitigation), write tools need `--act` and approval when tainted, outputs labelled untrusted.
- Skills are owner-written and trusted; do not paste third-party text into a skill without reading it.
- Residual risk: the injection heuristic is not a security boundary; the taint + approval rule and host policy are. Approvals show a one-line summary, so read it before approving.

## Telegram control
Obeys only the configured private chat; read/stop/answer only (no command starts work, sends mail, approves recipients, or changes policy); kill switch needs `/stopall confirm`. Anyone who gains access to your Telegram account could stop your tasks or answer an agent's question, so use 2-step verification there.

## Honest limits
- Root on the host while the vault is unlocked can use the token. Layers make this hard and visible, not impossible.
- Auto-unlock (`FROGY_HOST_PASSPHRASE`) stores the passphrase on the machine: convenient, weaker.
- `script.run` is process-level isolation only (scrubbed env, timeout, allowlist). Run the host in a container/VM for stronger isolation.
- The host API must be reachable from Render. Use an outbound tunnel (see `deploy/cloudflared-example.yml`) + Access policy; do not expose the admin port.
- LLM-parsed requests can be steered by hostile text. That is why `frogy run` always dry-runs first and you must `frogy confirm`, and why host policy (not the model) decides what is allowed.
- Revoke any time: `frogy-host revoke-google`, or Google Account → Security → Third-party access.
