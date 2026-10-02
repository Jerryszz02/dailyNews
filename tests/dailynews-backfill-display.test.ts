import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { loadItemDetail } from "@aihot/backend/publication/detail";
import { loadPool } from "@aihot/backend/publication/pool";
import { publishArticle } from "@aihot/backend/publication/publish";
import { loadStoryDetail } from "@aihot/backend/publication/stories";
import { loadTimeline } from "@aihot/backend/publication/timeline";
import { beijingDate, beijingMidnight } from "@aihot/contracts/time";
import { tag } from "./setup.ts";

const T = tag();
const SOURCE = `backfill-display-${T}`;
const TAG = `backfill-display:${T}`;
const ids: string[] = [];
const factIds: number[] = [];
const storyIds: number[] = [];

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at)
    VALUES (${SOURCE}, '历史展示测试来源', 'rss', 'T1', 'editorial', '2100-01-01')`;
});

after(async () => {
  if (factIds.length) await sql`DELETE FROM facts WHERE id=ANY(${factIds}::bigint[])`;
  if (storyIds.length) await sql`DELETE FROM stories WHERE id=ANY(${storyIds}::bigint[])`;
  if (ids.length) {
    await sql`DELETE FROM selected_ledger WHERE article_id=ANY(${ids}::text[])`;
    await sql`DELETE FROM selected_state WHERE article_id=ANY(${ids}::text[])`;
    await sql`DELETE FROM articles WHERE id=ANY(${ids}::text[])`;
  }
  await sql`DELETE FROM sources WHERE id=${SOURCE}`;
  await stopBoss();
  await closeDb();
});

async function published(label: string, now: Date, backfill: boolean, publishedAt: Date | null) {
  const { articleId } = await upsertMaterial({
    sourceId: SOURCE, url: `https://example.com/${T}/${label}`, title: `${label}新闻标题`,
    bodyText: `${label}的事实内容已由来源公开。`, bodyStatus: "ok", via: "fetch",
    discoveredAt: now, publishedAt, backfill: backfill ? "first-import" : null,
  });
  ids.push(articleId);
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, reason_zh, score, selected, tags, output)
    VALUES (${articleId}, 1, 'rule', 'pass', 'ai', ${`${label}中文标题`}, ${`${label}中文摘要`}, '推荐理由', 90, true, ${[TAG]},
      ${sql.json({ classification: { originalCategory: "ai", effectiveCategory: "ai" } })})`;
  await publishArticle(articleId, { releasedAt: new Date(now.getTime() - 60_000), now });
  return articleId;
}

test("first-import selection stays public by source date but never increases today's normal count", async () => {
  const now = new Date();
  const midnight = beijingMidnight(beijingDate(now));
  const sourceTime = new Date(Math.max(midnight.getTime(), now.getTime() - 60_000));
  const historical = await published("有原文时间的回灌", now, true, sourceTime);
  const unknownTime = await published("没有原文时间的回灌", now, true, null);
  const normal = await published("正常新增", now, false, sourceTime);

  const pool = await loadPool({ channel: "all", category: null, tag: TAG, now: new Date(now.getTime() + 1000) });
  assert.equal(pool.todayCount, 1, "today count measures normal additions, including when backfill has today's date");
  assert.equal(pool.total, 3, "history remains in the all-items archive");
  const byId = new Map(pool.items.map((item) => [item.id, item]));
  assert.deepEqual([byId.get(historical)?.backfill, byId.get(unknownTime)?.backfill, byId.get(normal)?.backfill], [true, true, false]);
  assert.deepEqual([byId.get(historical)?.selected, byId.get(unknownTime)?.selected, byId.get(normal)?.selected], [true, true, true]);
  assert.equal(byId.get(historical)?.timelineAt, sourceTime.toISOString(), "a history item keeps its source date");
  assert.equal(byId.get(unknownTime)?.publishedAt, null);

  const detail = await loadItemDetail(historical, new Date(now.getTime() + 1000));
  assert.equal(detail.kind, "found");
  if (detail.kind === "found") assert.equal(detail.detail.backfill, true);
  const timeline = await loadTimeline({ channel: "all", category: null, tag: TAG, now: new Date(now.getTime() + 1000) });
  assert.ok(timeline.cards.some((card) => card.item.id === historical && card.item.backfill && card.item.selected),
    "historical selection remains a selected card");

  const [story] = await sql<{ id: number }[]>`
    INSERT INTO stories (public_id, title, first_report_at, latest_at)
    VALUES (${randomUUID()}, '历史精选测试事件', ${sourceTime}, ${sourceTime}) RETURNING id`;
  storyIds.push(story!.id);
  const [fact] = await sql<{ id: number }[]>`
    INSERT INTO facts (public_id, story_id, title)
    VALUES (${`backfill-${T}`}, ${story!.id}, '历史精选测试事实') RETURNING id`;
  factIds.push(fact!.id);
  await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${fact!.id}, ${historical}, 'primary')`;
  const storyView = await loadStoryDetail(story!.id, new Date(now.getTime() + 1000));
  assert.ok(storyView?.timeline.some((report) => report.id === historical && report.backfill && report.selected),
    "a selected story report exposes its history marker too");
});
