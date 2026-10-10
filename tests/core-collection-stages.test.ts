import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import {
  collectSource,
  scheduleDueSources,
} from "@aihot/backend/sources/collect";
import { guardedFetch } from "../packages/backend/src/lib/http-fetch.ts";
import { withRequestDeadline } from "../packages/backend/src/lib/request-scope.ts";
import {
  enrichCollectionItem,
  recoverCollections,
  storeCollectionBatch,
  receiveCollection,
} from "../packages/backend/src/sources/intake.ts";
const T = tag();
let failSlow = false;
let retrySlow = false;
let releaseSlow: () => void = () => {};
let startedSlow: () => void = () => {};
const rssRequests: number[] = [];
const server = http.createServer(async (req, res) => {
  if (req.url?.startsWith("/rss/")) {
    const status = req.headers["if-none-match"] === '"v1"' ? 304 : 200;
    rssRequests.push(status);
    res.writeHead(status, {
      "content-type": "application/rss+xml",
      etag: '"v1"',
    });
    res.end(
      status === 304
        ? ""
        : `<rss version="2.0"><channel><title>尾部</title>${Array.from({ length: 61 }, (_, i) => `<item><title>独立尾部 ${i}</title><link>${base}/rss-item/${req.url!.split("/").at(-1)}/${i}</link><pubDate>${new Date().toUTCString()}</pubDate><description>摘要 ${i}</description></item>`).join("")}</channel></rss>`,
    );
    return;
  }
  if (req.url?.startsWith("/list")) {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(
        ["slow", "fast"].map((name) => ({
          url: base + "/" + name + "/" + req.url!.split("/").at(-1),
          title: "阅读全文",
        })),
      ),
    );
    return;
  }
  if (req.url?.startsWith("/slow")) {
    if (retrySlow) {
      res.writeHead(429, { "retry-after": "120" });
      res.end();
      return;
    }
    if (failSlow) {
      res.writeHead(503);
      res.end();
      return;
    }
    startedSlow();
    await new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
  }
  res.setHeader("content-type", "text/html");
  res.end(
    `<html><body><h1>独立处理 ${req.url}</h1><time datetime="${new Date().toISOString()}"></time></body></html>`,
  );
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
config.allowPrivateNetworkFetch = true;
after(async () => {
  releaseSlow();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await stopBoss();
  await closeDb();
});
async function source(name: string) {
  const id = `stages-${T}-${name}`;
  await sql`INSERT INTO sources(id,name,kind,config,tier,participation_mode,cursor,next_fetch_at)
    VALUES(${id},'分阶段测试','json_list',${sql.json({ url: base + "/list/" + id, titlePaths: ["title"], urlTemplate: "{raw:url}", detail: { titleSelector: "h1", publishedAtSelector: "time", publishedAtAuthoritative: true, maxFetches: 10 } })},'T1','editorial',${sql.json({ initializedAt: new Date().toISOString() })},'2100-01-01')`;
  return id;
}
async function pending(id: string) {
  return sql`SELECT i.id,i.candidate,b.id AS batch_id FROM collection_items i JOIN collection_batches b ON b.id=i.batch_id JOIN collection_intakes r ON r.run_id=b.run_id WHERE r.source_id=${id} ORDER BY i.id`;
}

test("同来源快详情先入库，未保存尾部阻止游标推进与重复抓取", async () => {
  const id = await source("slow");
  const before = (await sql`SELECT cursor FROM sources WHERE id=${id}`)[0]!
    .cursor;
  const received = await collectSource(id, { deferred: true });
  assert.equal(received.pending, true);
  assert.equal(
    (await sql`SELECT count(*)::int n FROM articles WHERE source_id=${id}`)[0]!
      .n,
    0,
  );
  const items = await pending(id);
  await storeCollectionBatch(Number(items[0]!.batch_id));
  const started = new Promise<void>((resolve) => {
    startedSlow = resolve;
  });
  const slow = enrichCollectionItem(Number(items[0]!.id));
  await started;
  await enrichCollectionItem(Number(items[1]!.id));
  assert.equal(
    (await sql`SELECT count(*)::int n FROM articles WHERE source_id=${id}`)[0]!
      .n,
    1,
  );
  assert.deepEqual(
    (await sql`SELECT cursor FROM sources WHERE id=${id}`)[0]!.cursor,
    before,
  );
  assert.equal(
    (await collectSource(id, { deferred: true })).error,
    "collection pending",
  );
  releaseSlow();
  await slow;
  const [run] =
    await sql`SELECT f.status,f.detail FROM fetch_runs f JOIN collection_intakes r ON r.run_id=f.id WHERE r.source_id=${id}`;
  assert.equal(run!.status, "ok");
  assert.equal(run!.detail.stages.saved, 2);
  const priorJobs = (
    await sql`SELECT count(*)::int n FROM pgboss.job WHERE name='content.extract-body'`
  )[0]!.n;
  await storeCollectionBatch(Number(items[0]!.batch_id));
  await enrichCollectionItem(Number(items[1]!.id));
  assert.equal(
    (await sql`SELECT count(*)::int n FROM articles WHERE source_id=${id}`)[0]!
      .n,
    2,
  );
  assert.equal(
    (
      await sql`SELECT count(*)::int n FROM pgboss.job WHERE name='content.extract-body'`
    )[0]!.n,
    priorJobs,
  );
  const repeat = await collectSource(id, { deferred: true });
  assert.equal(repeat.pending, true);
  const all = await pending(id);
  await storeCollectionBatch(Number(all.at(-1)!.batch_id));
  assert.equal(
    (
      await sql`SELECT sum(revision)::int n FROM articles WHERE source_id=${id}`
    )[0]!.n,
    2,
  );
});

test("详情失败有界重试，原始批次恢复后保存未确认材料不丢尾部", async () => {
  failSlow = true;
  const id = await source("retry");
  await collectSource(id, { deferred: true });
  const items = await pending(id);
  await storeCollectionBatch(Number(items[0]!.batch_id));
  assert.ok((await recoverCollections()).enqueued >= 1);
  assert.equal(
    (await enrichCollectionItem(Number(items[0]!.id))).state,
    "retrying",
  );
  await sql`UPDATE collection_items SET detail_retry_at=now() WHERE id=${items[0]!.id}`;
  assert.equal(
    (await enrichCollectionItem(Number(items[0]!.id))).state,
    "retrying",
  );
  await sql`UPDATE collection_items SET detail_retry_at=now() WHERE id=${items[0]!.id}`;
  await enrichCollectionItem(Number(items[0]!.id));
  await enrichCollectionItem(Number(items[1]!.id));
  const [row] =
    await sql`SELECT detail_attempts,completed_at FROM collection_items WHERE id=${items[0]!.id}`;
  assert.equal(row!.detail_attempts, 3);
  assert.ok(row!.completed_at);
  assert.equal(
    (
      await sql`SELECT f.status FROM fetch_runs f JOIN collection_intakes r ON r.run_id=f.id WHERE r.source_id=${id}`
    )[0]!.status,
    "ok",
  );
  failSlow = false;
});

test("来源总截止取消正在读取的请求", async () => {
  const started = new Promise<void>((resolve) => {
    startedSlow = resolve;
  });
  const request = withRequestDeadline(100, new AbortController().signal, () =>
    guardedFetch(base + "/slow/deadline", { timeoutMs: 20_000 }),
  );
  const rejection = assert.rejects(request);
  await started;
  await rejection;
  releaseSlow();
});

test("存储积压保留待抓取来源，恢复后按域名轮转派发", async () => {
  const ids = Array.from({ length: 6 }, (_, i) => `stages-${T}-fair-${i}`);
  for (let i = 0; i < ids.length; i++)
    await sql`INSERT INTO sources(id,name,kind,config,tier,participation_mode,next_fetch_at)
    VALUES(${ids[i]!},'公平调度','json_list',${sql.json({ url: `https://${i < 4 ? "many.example" : i === 4 ? "second.example" : "third.example"}/list`, titlePaths: ["title"], urlTemplate: "{raw:url}" })},'T1','editorial','1900-01-01')`;
  process.env.COLLECT_KINDS = "json_list";
  process.env.COLLECTION_BACKLOG_HIGH = "1";
  process.env.COLLECTION_BACKLOG_LOW = "0";
  const blocked = await scheduleDueSources(4);
  assert.equal(blocked.enqueued, 0);
  assert.equal(
    (
      await sql`SELECT count(*)::int n FROM sources WHERE id=ANY(${ids}) AND next_fetch_at<now()`
    )[0]!.n,
    6,
  );
  process.env.COLLECTION_BACKLOG_HIGH = "100001";
  process.env.COLLECTION_BACKLOG_LOW = "100000";
  const result = await scheduleDueSources(4);
  assert.equal(result.enqueued, 4);
  const queued =
    await sql`SELECT id FROM sources WHERE id=ANY(${ids}) AND next_fetch_at>now()`;
  assert.ok(queued.some((r) => r.id === ids[4]));
  assert.ok(queued.some((r) => r.id === ids[5]));
  assert.ok(queued.filter((r) => ids.slice(0, 4).includes(r.id)).length <= 2);
  await sql`UPDATE sources SET next_fetch_at='2100-01-01' WHERE id=ANY(${ids})`;
  delete process.env.COLLECT_KINDS;
  delete process.env.COLLECTION_BACKLOG_HIGH;
  delete process.env.COLLECTION_BACKLOG_LOW;
});

test("429 的 Retry-After 阻止过早详情重调，恢复不跳过原始批次", async () => {
  retrySlow = true;
  const id = await source("429");
  await collectSource(id, { deferred: true });
  const items = await pending(id);
  await storeCollectionBatch(Number(items[0]!.batch_id));
  const result = await enrichCollectionItem(Number(items[0]!.id));
  assert.equal(result.state, "retrying");
  const [wait] =
    await sql`SELECT detail_retry_at,detail_attempts FROM collection_items WHERE id=${items[0]!.id}`;
  assert.ok(new Date(wait!.detail_retry_at).getTime() - Date.now() > 119_000);
  assert.equal(
    (await enrichCollectionItem(Number(items[0]!.id))).state,
    "waiting",
  );
  assert.equal(
    (
      await sql`SELECT detail_attempts FROM collection_items WHERE id=${items[0]!.id}`
    )[0]!.detail_attempts,
    1,
  );
  retrySlow = false;
  await sql`UPDATE collection_items SET detail_retry_at=now() WHERE id=${items[0]!.id}`;
  // Fast item completes while the scheduled retry remains durable.
  await enrichCollectionItem(Number(items[1]!.id));
  const started = new Promise<void>((resolve) => {
    startedSlow = resolve;
  });
  const slow = enrichCollectionItem(Number(items[0]!.id));
  await started;
  releaseSlow();
  await slow;
});

test("持久批次第61条完成后才接受RSS304，旧运行不能覆写材料", async () => {
  const id = `stages-${T}-rss`;
  await sql`INSERT INTO sources(id,name,kind,config,tier,participation_mode,cursor,next_fetch_at)
    VALUES(${id},'持久尾部','rss',${sql.json({ feedUrl: base + "/rss/" + id })},'T1','editorial',${sql.json({ initializedAt: new Date().toISOString() })},'2100-01-01')`;
  await collectSource(id, { deferred: true });
  const batches =
    await sql`SELECT b.id,b.run_id FROM collection_batches b JOIN collection_intakes r ON r.run_id=b.run_id WHERE r.source_id=${id} ORDER BY b.id`;
  assert.equal(batches.length, 2);
  // A superseded process fails before even the first material write.
  await sql`UPDATE sources SET collection_run_id=collection_run_id+100000 WHERE id=${id}`;
  await assert.rejects(
    storeCollectionBatch(Number(batches[0]!.id)),
    /superseded/,
  );
  assert.equal(
    (await sql`SELECT count(*)::int n FROM articles WHERE source_id=${id}`)[0]!
      .n,
    0,
  );
  await sql`UPDATE sources SET collection_run_id=${batches[0]!.run_id} WHERE id=${id}`;
  await storeCollectionBatch(Number(batches[0]!.id));
  assert.equal(
    (await sql`SELECT cursor FROM sources WHERE id=${id}`)[0]!.cursor.rss,
    undefined,
  );
  assert.equal(
    (await collectSource(id, { deferred: true })).error,
    "collection pending",
  );
  await storeCollectionBatch(Number(batches[1]!.id));
  assert.equal(
    (await sql`SELECT count(*)::int n FROM articles WHERE source_id=${id}`)[0]!
      .n,
    61,
  );
  assert.equal((await collectSource(id, { deferred: true })).pending, false);
  assert.deepEqual(rssRequests, [200, 304]);
});

test("管理员全局锁与来源修订并发遵守锁顺序", async () => {
  const id = await source("concurrent");
  async function intake(title: string) {
    const [run] =
      await sql`INSERT INTO fetch_runs(source_id) VALUES(${id}) RETURNING id`;
    await sql`UPDATE sources SET collection_run_id=${run!.id} WHERE id=${id}`;
    await receiveCollection(
      Number(run!.id),
      id,
      [
        {
          candidate: {
            url: base + "/concurrent/" + id,
            identityKey: "concurrency:" + id,
            title,
            bodyText: "正文",
            bodyStatus: "ok",
            publishedAt: new Date(),
          },
          need: null,
        },
      ],
      {
        trialId: null,
        backfill: null,
        cursor: { initializedAt: new Date().toISOString() },
        receiptIds: [],
        detail: {},
      },
    );
    return Number(
      (await sql`SELECT id FROM collection_batches WHERE run_id=${run!.id}`)[0]!
        .id,
    );
  }
  await storeCollectionBatch(await intake("原始新闻标题"));
  const revised = await intake("更新后的新闻标题");
  let unlockGlobal: () => void = () => {};
  const locked = new Promise<void>((resolve) => {
    unlockGlobal = resolve;
  });
  let collectorStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    collectorStarted = resolve;
  });
  const admin = sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('dailynews-editorial-projection'))`;
    unlockGlobal();
    await started;
    await tx`SELECT pg_sleep(0.025)`;
    await tx`SELECT id FROM sources WHERE id=${id} FOR UPDATE`;
  });
  await locked;
  const collecting = storeCollectionBatch(revised);
  collectorStarted();
  await Promise.all([admin, collecting]);
  assert.equal(
    (await sql`SELECT revision FROM articles WHERE source_id=${id}`)[0]!
      .revision,
    2,
  );
});
