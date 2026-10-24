# Instagram / LinkedIn actions

`instagram.unfollow` and `linkedin.remove_connection` are **registered but disabled**, and page automation is **not included** in this scaffold.

Why: neither platform offers an official API for these actions for ordinary accounts (verify in their current docs), automating them breaks their terms, and accounts get restricted. If you accept that risk:

1. Enable explicitly in `host-data/config.json`: `"enabled": {"instagram.unfollow": true}`.
2. Implement the Playwright logic in `src/host/browser/` and call it from `handleAction` in `src/host/actions.ts`.
3. You MUST use the helpers in `src/host/browser-guard.ts`: random `jitter()` between actions, `looksLikeChallenge()` to STOP on captcha/login challenge/"action blocked", and the existing per-day caps. On a challenge: alert, halt, never retry or bypass.
4. Keep one persistent browser profile per account; store its cookies in the vault, not on disk in plain text.
5. Run it from a stable residential IP (e.g. a home machine) at low volume. Do not use AI to imitate human behavior.

The safer alternative is to use each platform's own settings/data export to find accounts, then clean up manually.
