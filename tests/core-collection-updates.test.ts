import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { collectSource } from "@aihot/backend/sources/collect";
import { enrichCollectionItem, storeCollectionBatch } from "@aihot/backend/sources/intake";

const fixtures = new Map<string, { updated: Date; title: string; body: string; hits: number; etag?: string; feedStatuses: number[] }>();
const published = new Date();
const server = http.createServer((req, res) => {
  const [kind, id] = (req.url ?? "").slice(1).split("/");
  const fixture = fixtures.get(id!);
  if (!fixture) { res.writeHead(404); res.end(); return; }
  if (kind === "feed") {
    if (fixture.etag) {
      res.setHeader("etag", fixture.etag);
      if (req.headers["if-none-match"] === fixture.etag) {
        fixture.feedStatuses.push(304); res.writeHead(304); res.end(); return;
      }
    }
    fixture.feedStatuses.push(200);
    res.setHeader("content-type", "application/atom+xml");
    res.end(`<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>${id}</id><title>Listing headline</title><link href="${base}/article/${id}"/><published>${published.toISOString()}</published><updated>${fixture.updated.toISOString()}</updated><summary>Listing summary</summary></entry></feed>`);
  } else {
    fixture.hits++;
    res.setHeader("content-type", "text/html");
    res.end(`<html><head><title>${fixture.title}</title></head><body><article><h1>${fixture.title}</h1><p>${fixture.body.repeat(40)}</p></article></body></html>`);
  }
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
config.allowPrivateNetworkFetch = true;
after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await stopBoss(); await closeDb(); });

async function createSource(authoritativeTitle: boolean) {
  const id = `updates-${tag()}`;
  fixtures.set(id, { updated: new Date(), title: "确认的初始标题", body: "初始报道介绍了行业市场与最新研究成果。", hits: 0, feedStatuses: [] });
  await sql`INSERT INTO sources(id,name,kind,config,tier,participation_mode,cursor,next_fetch_at)
    VALUES (${id},'更新测试','rss',${sql.json({ feedUrl: `${base}/feed/${id}`, detail: { maxFetches: 10, ...(authoritativeTitle ? { titleSelector: "h1", titleAuthoritative: true } : {}) } })},
    'T1','editorial',${sql.json({ initializedAt: new Date().toISOString() })},'2100-01-01')`;
  return id;
}
async function refresh(id: string) {
  const received = await collectSource(id, { deferred: true });
  assert.equal(received.status, "ok", received.error ?? "collection must succeed");
  const items = await sql`SELECT i.id,i.need,b.id batch_id FROM collection_items i JOIN collection_batches b ON b.id=i.batch_id
    JOIN collection_intakes r ON r.run_id=b.run_id WHERE r.source_id=${id} AND i.completed_at IS NULL ORDER BY i.id`;
  for (const batch of new Set(items.map(i => Number(i.batch_id)))) await storeCollectionBatch(batch);
  for (const item of items) if (item.need) await enrichCollectionItem(Number(item.id));
  return (await sql`SELECT id,revision,title,body_text,source_updated_at,source_detail_checked_at FROM articles WHERE source_id=${id}`)[0]!;
}

test("known URL update signal rechecks authoritative title/body once, identical content checkpoints without revision", async () => {
  const id = await createSource(true);
  const fixture = fixtures.get(id)!;
  const initial = await refresh(id);
  assert.equal(initial.revision, 1);
  assert.equal(initial.title, fixture.title);
  assert.ok(initial.body_text.includes(fixture.body));
  assert.equal(fixture.hits, 1);
  await refresh(id);
  assert.equal(fixture.hits, 1, "unchanged listing does not buy another detail read");
  fixture.updated = new Date(fixture.updated.getTime() + 1000);
  const timestampOnly = await refresh(id);
  assert.equal(timestampOnly.revision, 1, "updated timestamp alone is not a content revision");
  assert.equal(timestampOnly.source_updated_at.toISOString(), fixture.updated.toISOString());
  assert.equal(fixture.hits, 2);
  await refresh(id);
  assert.equal(fixture.hits, 2, "checkpoint consumes the update signal even when content did not change");
  fixture.updated = new Date(fixture.updated.getTime() + 1000);
  fixture.title = "修订后的权威标题";
  fixture.body = "修订报道新增了行业变化与实验数据，改变原先结论。";
  const revised = await refresh(id);
  assert.equal(revised.revision, 2);
  assert.equal(revised.title, fixture.title);
  assert.ok(revised.body_text.includes(fixture.body));
  await refresh(id);
  assert.equal(fixture.hits, 3);
});

test("recent article body-only recheck is bounded to six hours even with unchanged listing", async () => {
  const id = await createSource(false);
  const fixture = fixtures.get(id)!;
  const initial = await refresh(id);
  assert.ok(initial.body_text.includes(fixture.body), "body-only detail need fetches the page");
  await refresh(id);
  assert.equal(fixture.hits, 1);
  fixture.body = "详情页悄悄更正了原文中的行业数据与报告结论。";
  await sql`UPDATE articles SET source_detail_checked_at=now()-interval '7 hours' WHERE id=${initial.id}`;
  const revised = await refresh(id);
  assert.equal(revised.revision, 2);
  assert.ok(revised.body_text.includes(fixture.body));
  await refresh(id);
  assert.equal(fixture.hits, 2, "successful periodic check closes its window");
});


test("stable RSS ETag permits cached refreshes but six-hour full listing read discovers independent body edits", async () => {
  const id = await createSource(false);
  const fixture = fixtures.get(id)!;
  fixture.etag = '"fixed-feed-etag"';
  const initial = await refresh(id);
  await refresh(id);
  assert.deepEqual(fixture.feedStatuses, [200, 304]);
  assert.equal(fixture.hits, 1, "ordinary 304 performs no detail request");
  fixture.body = "网站只修改了详情页正文，Feed字节和更新时间全部保持原样。";
  const expired = new Date(Date.now() - 7 * 3600_000).toISOString();
  await sql`UPDATE sources SET cursor=jsonb_set(cursor,'{rssFullReadAt}',${sql.json(expired)}) WHERE id=${id}`;
  await sql`UPDATE articles SET source_detail_checked_at=now()-interval '7 hours' WHERE id=${initial.id}`;
  const revised = await refresh(id);
  assert.deepEqual(fixture.feedStatuses, [200, 304, 200], "expired clock bypasses conditional feed cache");
  assert.equal(revised.revision, 2);
  assert.ok(revised.body_text.includes(fixture.body));
  assert.equal(fixture.hits, 2);
  await refresh(id);
  assert.deepEqual(fixture.feedStatuses, [200, 304, 200, 304]);
  assert.equal(fixture.hits, 2, "persisted full-read/check clocks prevent repeated forced work");
});

test("RSS without a detail budget retains conditional cache even when a full-read clock is old", async () => {
  const id = await createSource(false);
  const fixture = fixtures.get(id)!;
  fixture.etag = '"fixed-no-detail"';
  await sql`UPDATE sources SET config=config-'detail' WHERE id=${id}`;
  await refresh(id);
  const expired = new Date(Date.now() - 7 * 3600_000).toISOString();
  await sql`UPDATE sources SET cursor=jsonb_set(cursor,'{rssFullReadAt}',${sql.json(expired)}) WHERE id=${id}`;
  await refresh(id);
  assert.deepEqual(fixture.feedStatuses, [200, 304]);
  assert.equal(fixture.hits, 0);
});
