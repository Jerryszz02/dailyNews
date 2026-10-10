import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { dailyRetention } from "@aihot/backend/operations/retention";

after(closeDb);

test("原始采集只清理一天前完整完成的批次，保留恢复尾部与运行统计", async () => {
  const sourceId = `retention-${tag()}`;
  const now = new Date();
  const old = new Date(now.getTime() - 25 * 3600_000);
  const recent = new Date(now.getTime() - 23 * 3600_000);
  await sql`INSERT INTO sources(id,name,kind,config,tier,participation_mode)
    VALUES(${sourceId},'采集保留测试','rss','{}','T1','editorial')`;
  const article = await upsertMaterial({
    sourceId,
    url: `https://example.org/${sourceId}`,
    title: "保留新闻",
    via: "fetch",
  });
  const [receipt] =
    await sql`INSERT INTO receipts(logical_key,service,purpose,status)
    VALUES(${sourceId},'retention-test','collection','completed') RETURNING id`;
  async function intake(finished: Date | null, completed: boolean) {
    const [run] =
      await sql`INSERT INTO fetch_runs(source_id,status,detail) VALUES(${sourceId},'ok',${sql.json({ stages: { saved: 1 } })}) RETURNING id`;
    await sql`INSERT INTO collection_intakes(run_id,source_id,cursor,receipt_ids,finished_at)
      VALUES(${run!.id},${sourceId},'{}',${sql.json([Number(receipt!.id)])},${finished})`;
    const [batch] =
      await sql`INSERT INTO collection_batches(run_id) VALUES(${run!.id}) RETURNING id`;
    const [item] =
      await sql`INSERT INTO collection_items(batch_id,candidate,completed_at)
      VALUES(${batch!.id},${sql.json({ url: `https://example.org/${sourceId}`, title: "原始内容" })},${completed ? now : null}) RETURNING id`;
    return {
      runId: Number(run!.id),
      batchId: Number(batch!.id),
      itemId: Number(item!.id),
    };
  }
  const completedOld = await intake(old, true);
  const completedNew = await intake(recent, true);
  const unfinished = await intake(null, false);
  const inconsistent = await intake(old, false);
  const result = await dailyRetention(now);
  assert.ok(result.deletedCollectionIntakes >= 1);
  const remaining =
    await sql`SELECT run_id FROM collection_intakes WHERE source_id=${sourceId} ORDER BY run_id`;
  assert.deepEqual(
    remaining.map((row) => Number(row.run_id)),
    [completedNew.runId, unfinished.runId, inconsistent.runId],
  );
  assert.equal(
    (
      await sql`SELECT count(*)::int n FROM collection_batches WHERE id=${completedOld.batchId}`
    )[0]!.n,
    0,
  );
  assert.equal(
    (
      await sql`SELECT count(*)::int n FROM collection_items WHERE id=${completedOld.itemId}`
    )[0]!.n,
    0,
  );
  assert.equal(
    (
      await sql`SELECT count(*)::int n FROM fetch_runs WHERE source_id=${sourceId}`
    )[0]!.n,
    4,
  );
  assert.deepEqual(
    (
      await sql`SELECT detail FROM fetch_runs WHERE id=${completedOld.runId}`
    )[0]!.detail,
    { stages: { saved: 1 } },
  );
  assert.equal(
    (
      await sql`SELECT count(*)::int n FROM articles WHERE id=${article.articleId}`
    )[0]!.n,
    1,
  );
  assert.equal(
    (
      await sql`SELECT count(*)::int n FROM receipts WHERE id=${receipt!.id}`
    )[0]!.n,
    1,
  );
});
