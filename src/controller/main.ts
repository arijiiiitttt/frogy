import { alert } from "../shared/alerts.js";
import { env, intEnv } from "../shared/util.js";
import { migrate, q } from "./db.js";
import { buildApp } from "./routes.js";
import { digestTick, schedulerTick } from "./scheduler.js";
import { startTelegramControl } from "./telegram.js";
import { Worker } from "./worker.js";

async function main() {
  if (!env("API_TOKEN") || !env("ADMIN_TOKEN")) throw new Error("API_TOKEN and ADMIN_TOKEN must be set");
  if (env("API_TOKEN") === env("ADMIN_TOKEN")) throw new Error("API_TOKEN and ADMIN_TOKEN must differ");
  await migrate();

  const app = buildApp();
  const worker = new Worker();
  await worker.start(); // also recovers tasks orphaned by a restart
  const sched = setInterval(() => void schedulerTick().then(() => digestTick()).catch((e) => console.error("scheduler:", e.message)), intEnv("SCHEDULER_TICK_SECONDS", 30) * 1000);
  const telegram = startTelegramControl();

  // Supplementary keep-alive. The REAL keep-alive is an external pinger (UptimeRobot / cron-job.org) hitting /healthz.
  const self = env("RENDER_EXTERNAL_URL");
  const ping = self && env("SELF_PING") !== "false" ? setInterval(() => void fetch(`${self}/healthz`).catch(() => undefined), 10 * 60_000) : undefined;

  const port = intEnv("PORT", 8080);
  await app.listen({ host: "0.0.0.0", port });
  console.log(`frogy controller listening on :${port}`);
  await alert("boot", "Controller started", 5 * 60_000);

  let down = false;
  const shutdown = async () => {
    if (down) return;
    down = true;
    clearInterval(sched);
    telegram?.stop();
    if (ping) clearInterval(ping);
    await worker.stop(); // hand running tasks back to the queue; idempotency keys prevent double-sends
    await app.close();
    await q("SELECT 1").catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

main().catch((e) => {
  console.error("fatal:", e.message);
  process.exit(1);
});
