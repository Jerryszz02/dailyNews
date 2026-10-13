import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { ensureQueue, getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { hourlyRetention } from "@aihot/backend/operations/retention";

after(async () => { await stopBoss(); await closeDb(); });

test("已有队列保留失败七天，小时清理仅收缩一天前成功历史并保护重试", async () => {
  const boss = await getBoss();
  const name = `retention.${tag()}`;
  await boss.createQueue(name, { deleteAfterSeconds: 14 * 86400 });
  await ensureQueue(name);
  assert.equal((await boss.getQueue(name))!.deleteAfterSeconds, 7 * 86400);
  const now = new Date();
  async function job(state: string, ageDays: number) {
    const id = await boss.send(name, { retained: state });
    assert.ok(id);
    const at = new Date(now.getTime() - ageDays * 86400_000);
    assert.equal((await sql`SELECT deletion_seconds FROM pgboss.job WHERE name=${name} AND id=${id}`)[0]!.deletion_seconds, 7 * 86400);
    // Let the application sweep own fixture boundaries; pg-boss maintenance uses wall time.
    const terminal = ["completed", "failed", "cancelled"].includes(state);
    await sql`UPDATE pgboss.job SET state=${state}::pgboss.job_state,created_on=${at},
      completed_on=${terminal ? at : null},deletion_seconds=${14 * 86400} WHERE name=${name} AND id=${id}`;
    return id;
  }
  const oldSuccess = await job("completed", 2);
  const boundary = await job("completed", 1);
  const fresh = await job("completed", 0.5);
  const failed = await job("failed", 2);
  const failedBoundary = await job("failed", 7);
  const oldFailed = await job("failed", 8);
  const created = await job("created", 8);
  const retry = await job("retry", 8);
  const active = await job("active", 8);
  await hourlyRetention(now);
  const rows = await sql`SELECT id FROM pgboss.job WHERE name=${name}`;
  const ids = new Set(rows.map(row => row.id));
  assert.equal(ids.has(oldSuccess), false);
  assert.equal(ids.has(oldFailed), false);
  for (const id of [boundary, fresh, failed, failedBoundary, created, retry, active]) assert.ok(ids.has(id));
  await hourlyRetention(now);
  assert.deepEqual(new Set((await sql`SELECT id FROM pgboss.job WHERE name=${name}`).map(row => row.id)), ids);
  await boss.deleteQueue(name);
});
