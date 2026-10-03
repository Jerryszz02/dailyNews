import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { after, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { extractArticleBody } from "@aihot/backend/content/extract";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { AI_POLICY_VERSION, CLASSIFICATION_CONFIG_VERSION, currentAnalysisSignature } from "@aihot/backend/editorial/policy";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { itemAvailability } from "@aihot/backend/publication/availability";
import { loadItemDetail, exportMarkdown } from "@aihot/backend/publication/detail";
import { loadItemShare } from "@aihot/backend/publication/og";
import { publishArticle } from "@aihot/backend/publication/publish";
import { sitemapSnapshot } from "@aihot/backend/publication/sitemap";
import { selectedChanges, selectedSnapshot } from "@aihot/backend/publication/v1";

const T = tag();
const SOURCE = `revision-scope-${T}`;
const OLD_BODY = "旧版全文，供正文阅读和导出验证。".repeat(25);
const NEW_BODY = "新版正文，包含经来源核实的新信息。".repeat(25);
let page: http.Server | null = null;
let pageUrl = "";

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, site_fulltext, syndicate_fulltext, next_fetch_at)
    VALUES (${SOURCE}, '修订范围测试来源', 'rss', 'T1', 'editorial', true, true, '2100-01-01')`;
  page = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<html><body><article><h1>新版正文</h1><p>${NEW_BODY}</p></article></body></html>`);
  });
  await new Promise<void>((resolve) => page!.listen(0, "127.0.0.1", resolve));
  pageUrl = `http://127.0.0.1:${(page.address() as { port: number }).port}/article/${T}`;
  config.allowPrivateNetworkFetch = true;
});

after(async () => {
  await new Promise<void>((resolve) => page?.close(() => resolve()) ?? resolve());
  await stopBoss();
  await closeDb();
});

async function published(label: string, url: string, bodyStatus: "ok" | "unconfirmed" = "ok") {
  const material = { sourceId: SOURCE, url, title: `${label}旧标题`, bodyText: OLD_BODY,
    bodyHtml: `<p>${OLD_BODY}</p>`, bodyStatus, via: "fetch" as const, publishedAt: new Date() };
  const { articleId } = await upsertMaterial(material);
  const signature = await currentAnalysisSignature(articleId);
  assert.ok(signature);
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh,
    reason_zh, score, selected, output, policy_id, policy_version, classification_version, input_signature)
    VALUES (${articleId}, 1, 'model', 'pass', 'ai', ${`${label}旧标题`}, '这是已核实的中文摘要。', '值得关注',
      88, true, ${sql.json({ classification: { originalCategory: "ai", effectiveCategory: "ai" } })},
      'aihot-ai-article', ${AI_POLICY_VERSION}, ${CLASSIFICATION_CONFIG_VERSION}, ${signature})`;
  await publishArticle(articleId, { releasedAt: new Date(Date.now() - 60_000) });
  assert.equal((await loadItemDetail(articleId)).kind, "found");
  return { articleId, material };
}

async function releasedReadTime() {
  const [gates] = await sql<{ ledger_at: Date | null; publication_at: Date | null }[]>`
    SELECT (SELECT max(visible_at) FROM selected_ledger) AS ledger_at,
      (SELECT max(visible_after) FROM publications WHERE selected) AS publication_at`;
  return new Date(Math.max(Date.now(), gates?.ledger_at?.getTime() ?? 0,
    gates?.publication_at?.getTime() ?? 0) + 1000);
}

async function selectedIds(now: Date) {
  const ids = new Set<string>();
  let page: string | null = null;
  let cursor = "";
  do {
    const snapshot = await selectedSnapshot({ limit: 100, page }, now);
    cursor ||= snapshot.cursor;
    for (const item of snapshot.items) ids.add(item.id);
    page = snapshot.nextPage;
  } while (page);
  return { ids, cursor };
}

async function changesSince(cursor: string, now: Date) {
  const changes: Awaited<ReturnType<typeof selectedChanges>>["changes"] = [];
  let next = cursor;
  do {
    const batch = await selectedChanges({ cursor: next, limit: 100 }, now);
    changes.push(...batch.changes);
    if (!batch.hasMore) break;
    next = batch.cursor;
  } while (true);
  return changes;
}

async function assertRevoked(articleId: string, cursor: string, now: Date) {
  const [state] = await sql<{ revision: number; analysis_id: number | null; eligible: boolean; selected: boolean; in_set: boolean }[]>`
    SELECT a.revision, p.analysis_id, p.eligible, p.selected, st.in_set FROM articles a
    JOIN publications p ON p.article_id = a.id JOIN selected_state st ON st.article_id = a.id WHERE a.id = ${articleId}`;
  assert.deepEqual({ revision: state!.revision, analysisId: state!.analysis_id,
    eligible: state!.eligible, selected: state!.selected, inSet: state!.in_set },
  { revision: 2, analysisId: null, eligible: false, selected: false, inSet: false });
  assert.equal((await loadItemDetail(articleId)).kind, "not_found");
  assert.equal(await exportMarkdown(articleId), null);
  assert.equal(await loadItemShare(articleId), null);
  assert.equal((await itemAvailability([articleId]))[articleId], "unavailable");
  assert.ok(!(await sitemapSnapshot()).xml.includes(`/items/${articleId}`), "cached sitemap must not retain a revised item");
  assert.ok(!(await selectedIds(now)).ids.has(articleId));
  const changes = await changesSince(cursor, now);
  assert.ok(changes.some((change) => change.op === "remove" && change.id === articleId), "old cursor receives a removal");
}

test("material revision atomically revokes public exits and selected sync before re-analysis", async () => {
  const { articleId, material } = await published("采集", `https://example.com/${T}/material`);
  const storyId = randomUUID();
  const [story] = await sql<{ id: number }[]>`
    INSERT INTO stories (public_id, title, first_report_at, latest_at)
    VALUES (${storyId}, '修订范围测试事件', now(), now()) RETURNING id`;
  const [fact] = await sql<{ id: number }[]>`
    INSERT INTO facts (public_id, story_id, title)
    VALUES (${`revision-fact-${T}`}, ${story!.id}, '修订证据事实') RETURNING id`;
  await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${fact!.id}, ${articleId}, 'primary')`;
  await publishArticle(articleId, { releasedAt: new Date(Date.now() - 60_000) });
  const [factBefore] = await sql<{ evidence_version: string }[]>`
    SELECT evidence_version FROM fact_editorial_state WHERE fact_id = ${fact!.id}`;
  assert.ok(factBefore);
  const now = await releasedReadTime();
  const before = await selectedIds(now);
  assert.ok(before.ids.has(articleId));
  const sitemapBefore = (await sitemapSnapshot()).xml;
  assert.ok(sitemapBefore.includes(`/items/${articleId}`));
  assert.ok(sitemapBefore.includes(`/story/${storyId}`));
  const revised = await upsertMaterial({ ...material, title: "采集新版标题", bodyText: NEW_BODY, bodyHtml: `<p>${NEW_BODY}</p>` });
  assert.equal(revised.revised, true);
  await assertRevoked(articleId, before.cursor, now);
  assert.ok(!(await sitemapSnapshot()).xml.includes(`/story/${storyId}`), "cached sitemap must not retain an unsupported story");
  const [factAfter] = await sql<{ evidence_version: string }[]>`
    SELECT evidence_version FROM fact_editorial_state WHERE fact_id = ${fact!.id}`;
  assert.notEqual(factAfter!.evidence_version, factBefore!.evidence_version,
    "a linked fact loses its former evidence in the same material transaction");

  // An analysis row for the new revision is not a publication without the current policy signature.
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh,
    score, selected, policy_id, policy_version, classification_version)
    VALUES (${articleId}, 2, 'model', 'pass', 'ai', '无签名标题', '无签名摘要', 90, true,
      'aihot-ai-article', ${AI_POLICY_VERSION}, ${CLASSIFICATION_CONFIG_VERSION})`;
  await publishArticle(articleId);
  assert.equal((await loadItemDetail(articleId)).kind, "not_found");
  assert.ok(!(await selectedIds(now)).ids.has(articleId));
});

test("extracted new body also removes the old selected revision in its write transaction", async () => {
  const { articleId } = await published("提取", pageUrl, "unconfirmed");
  const now = await releasedReadTime();
  const before = await selectedIds(now);
  assert.ok(before.ids.has(articleId));
  assert.equal(await extractArticleBody(articleId, false), "ok");
  await assertRevoked(articleId, before.cursor, now);
  const [article] = await sql<{ body_text: string }[]>`SELECT body_text FROM articles WHERE id = ${articleId}`;
  assert.ok(article!.body_text.includes("新版正文"), "new material remains stored for the next analysis");
});
