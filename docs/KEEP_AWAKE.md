# Keeping the Render free instance awake

Render spins a free web service down after 15 minutes without inbound traffic. Two limits matter:

- **750 free instance hours/month per workspace.** One always-on service uses ~720-744 h, so you can run **exactly one** free service (that is why API + worker + scheduler are one process).
- Render may restart a free service at any time. Frogy recovers: running tasks are re-queued, schedules resume, idempotency keys prevent double-sends.

## Setup (5 minutes)
1. Deploy, then copy your URL, e.g. `https://frogy-controller.onrender.com`.
2. Create TWO independent monitors against `GET /healthz` (returns `{"ok":true}`, reveals nothing):
   - UptimeRobot (free): HTTP(s) monitor, every 5 minutes.
   - cron-job.org (free): GET every 5 minutes.
3. Add alerting on the monitor so you hear when the service is down.
4. Check Render's Billing page after a few days to confirm you stay under 750 hours.

The controller also self-pings via `RENDER_EXTERNAL_URL` every 10 minutes as a supplement. Do not rely on it alone.

## Database
Render's free Postgres expires after 30 days. Use an external free Postgres (Neon or Supabase; check current limits) for `DATABASE_URL`.

## Honest limits
Free plans are not meant for production. If you need guaranteed uptime, Render's paid Starter instance removes spin-down.
