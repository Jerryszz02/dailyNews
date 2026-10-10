import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { getBoss, enqueue, QUEUES, stopBoss, work, queueMetrics } from "@aihot/backend/jobs/queue";
import { setTimeout as delay } from "node:timers/promises";

after(async () => { await stopBoss(); await closeDb(); });

test("a failed first database connection does not poison all later queue requests", async () => {
  const original = config.databaseUrl;
  const missing = new URL(original);
  missing.pathname = "/aihot_missing_queue_recovery_test";
  config.databaseUrl = missing.toString();
  try {
    await assert.rejects(getBoss(), /does not exist/);
  } finally {
    config.databaseUrl = original;
  }
  const boss = await getBoss();
  const articleId = `recovered-${tag()}`;
  const id = await enqueue(QUEUES.analyze, { articleId }, { singletonKey: articleId });
  assert.ok(id);
  assert.equal((await boss.getJobById<{ articleId: string }>(QUEUES.analyze, id))?.data.articleId, articleId);
});

test("queue timings separate intentional delay from eligible waiting and survive persistence", async () => {
  const createdOn = new Date("2026-10-10T10:00:00Z");
  const startAfter = new Date("2026-10-10T10:01:00Z");
  const startedOn = new Date("2026-10-10T10:01:02Z");
  assert.deepEqual(queueMetrics({ id: "timed", createdOn, startAfter, startedOn, retryCount: 1 }, 12.4),
    { jobId: "timed", attempt: 2, elapsedMs: 12, queueWaitMs: 2000, ageMs: 62000 });
  const boss = await getBoss();
  await work(boss, QUEUES.prepareMedia, { localConcurrency: 1, pollingIntervalSeconds: 0.5 }, async () => ({ processed: 1 }));
  const id = await enqueue(QUEUES.prepareMedia, { articleId: `metrics-${tag()}` });
  assert.ok(id);
  let finished;
  const deadline = Date.now() + 10_000;
  do {
    finished = await boss.getJobById(QUEUES.prepareMedia, id);
    if (finished?.state === "completed") break;
    await delay(25);
  } while (Date.now() < deadline);
  assert.equal(finished?.state, "completed");
  const output = finished!.output as { processed: number; metrics: ReturnType<typeof queueMetrics> };
  assert.equal(output.processed, 1);
  assert.equal(output.metrics.jobId, id);
  assert.equal(output.metrics.attempt, 1);
  assert.ok(output.metrics.elapsedMs >= 0 && output.metrics.queueWaitMs >= 0);
});
