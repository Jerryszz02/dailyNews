// Worker process: queues and schedules for collection, processing, events, reports, monitors and ops.
import { assertProductionSecrets } from "@aihot/backend/config";
import { FEATURES } from "@aihot/industry/features";
import { closeDb, sql } from "@aihot/backend/db";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { registerContentJobs, registerExtractionJobs } from "@aihot/backend/jobs/content";
import { assertTrialRuntime } from "@aihot/backend/dailynews/trial";
import { registerSourceJobs } from "@aihot/backend/jobs/sources";
import { registerEventJobs } from "@aihot/backend/jobs/events";
import { registerNotifyJobs } from "@aihot/backend/jobs/notify";
import { registerPublicationJobs } from "@aihot/backend/jobs/publication";
import { registerSchedules } from "./schedules.ts";
import { ensureContentTargets } from "@aihot/backend/notify/deliver";
import { startHeartbeat } from "@aihot/backend/operations/heartbeat";
import { reprocessActiveAnalyses } from "@aihot/backend/publication/reprocess";
import { recoverEditorialBatch } from "@aihot/backend/publication/batching";

assertProductionSecrets([["auth", "IMG_PROXY_SIGN_SECRET"]]);

// A bounded trial starts only with a persisted cohort, exact settings and an explicit budget.
// Check before pg-boss can pick up any jobs left from an earlier worker process.
const trial = await assertTrialRuntime();
if (!trial) await ensureContentTargets();
const boss = await getBoss();
await registerContentJobs(boss, trial ? 2 : Number(process.env.ANALYZE_CONCURRENCY || 2));
if (trial) await registerExtractionJobs(boss);
else if (process.env.COLLECT_ENABLED === "true") await registerSourceJobs(boss);
await registerEventJobs(boss);
if (!trial) {
  await registerNotifyJobs(boss);
  await registerPublicationJobs(boss);
}
await registerSchedules(boss);
if (!trial) await reprocessActiveAnalyses({ reason: "worker startup policy signature" });
// A new site has no leaderboard until the first scheduled round: compute one now.
if (!trial && FEATURES.leaderboard) {
  const [published] = await sql`SELECT 1 FROM lb_runs WHERE status = 'published' LIMIT 1`;
  if (!published) await boss.send("cron.leaderboard.round", {}, { singletonKey: "first-round" });
}
const heartbeat = startHeartbeat("worker");
// Durable dirty state survives a dropped/duplicate queue wake-up. Never overlap recovery polls.
let recoveringBatch = false;
const batchRecovery = trial ? null : setInterval(() => {
  if (recoveringBatch || stopping) return;
  recoveringBatch = true;
  void recoverEditorialBatch().catch(() => console.error("editorial batch recovery failed"))
    .finally(() => { recoveringBatch = false; });
}, 2_000);
batchRecovery?.unref();
console.log(JSON.stringify({ level: "info", msg: "worker started", pid: process.pid }));

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ level: "info", msg: "worker stopping" }));
  clearInterval(heartbeat);
  if (batchRecovery) clearInterval(batchRecovery);
  await stopBoss();
  await closeDb();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
