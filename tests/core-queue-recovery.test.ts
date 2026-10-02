import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { getBoss, enqueue, QUEUES, stopBoss } from "@aihot/backend/jobs/queue";

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
