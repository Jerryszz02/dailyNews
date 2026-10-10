import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { updateSource } from "@aihot/backend/admin/sources";
import { currentAnalysisSignature } from "@aihot/backend/editorial/policy";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { publishArticle } from "@aihot/backend/publication/publish";
import { reconcileEditorialPolicies, reconcileDueEditorialPolicies } from "@aihot/backend/publication/editorial";
import { reconcileEditorialBatch, markEditorialDirtyTx, recoverEditorialBatch } from "@aihot/backend/publication/batching";

import { tag } from "./setup.ts";

process.env.DAILYNEWS_ALLOW_LEGACY_FIXTURES = "1";
const T = tag();
const SOURCE_A = `batch-xinhua-${T}`;
const SOURCE_B = `batch-ap-${T}`;
const articleIds: string[] = [];
const factIds: number[] = [];
const storyIds: number[] = [];

before(async () => {
  // Earlier test files can leave durable wake-ups; finish them before this controlled window.
  await reconcileEditorialBatch();
  for (const [id, name, legacySourceId, credibility] of [
    [SOURCE_A, "新华网", "xinhua", 88], [SOURCE_B, "美联社", "ap", 91],
  ] as const) {
    await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, config, next_fetch_at)
      VALUES (${id}, ${name}, 'rss', 'T1', 'editorial',
        ${sql.json({ dailyNews: { legacySourceId, sectionId: `${legacySourceId}-fixture-${T}`, publisherKey: legacySourceId,
          sourceCredibility: credibility, mediaType: "wire", signalRole: "reporting", mayHavePaywall: false } })},
        '2100-01-01')`;
  }
});
afterEach(async () => {
  await reconcileEditorialBatch();
  if (factIds.length) await sql`DELETE FROM facts WHERE id=ANY(${factIds.splice(0)}::bigint[])`;
  if (storyIds.length) await sql`DELETE FROM stories WHERE id=ANY(${storyIds.splice(0)}::bigint[])`;
  const ids = articleIds.splice(0);
  if (ids.length) {
    await sql`DELETE FROM selected_ledger WHERE article_id=ANY(${ids}::text[])`;
    await sql`DELETE FROM selected_state WHERE article_id=ANY(${ids}::text[])`;
    await sql`DELETE FROM articles WHERE id=ANY(${ids}::text[])`;
  }
});
after(async () => { await stopBoss(); await closeDb(); });

async function fixture(category: string, title: string, sourceId = SOURCE_A, publishedAt = new Date(Date.now() - 3 * 3_600_000), origin: "rule" | "model" = "rule") {
  const { articleId } = await upsertMaterial({ sourceId, url: `https://example.com/${T}-${randomUUID()}`,
    title, bodyText: `${title}。有关机构披露适用范围、阶段安排、事实背景及后续影响。`, bodyStatus: "ok", via: "ingest", publishedAt });
  articleIds.push(articleId);
  const signature = origin === "model" ? await currentAnalysisSignature(articleId) : null;
  await sql`INSERT INTO analyses (article_id, input_revision, origin, input_signature, relevance, category,
    title_zh, summary_zh, reason_zh, score, selected, output)
    VALUES (${articleId}, 1, ${origin}, ${signature}, 'pass', ${category}, ${title},
      ${`${title}。有关机构披露适用范围、阶段安排、事实背景及后续影响。`}, '测试理由', 90, true,
      ${sql.json({ classification: { originalCategory: category, effectiveCategory: category } })})`;
  return articleId;
}

async function fact(articleIdsForFact: string[], roles: Array<"primary" | "report" | "mention"> = articleIdsForFact.map(() => "report")) {
  const [story] = await sql<{ id: number }[]>`
    INSERT INTO stories (public_id, title, first_report_at, latest_at)
    VALUES (${randomUUID()}, '测试新闻事件', now(), now()) RETURNING id`;
  storyIds.push(story!.id);
  const [row] = await sql<{ id: number }[]>`
    INSERT INTO facts (public_id, story_id, title)
    VALUES (${`f${randomUUID().replaceAll("-", "").slice(0, 12)}`}, ${story!.id}, '测试新闻事实') RETURNING id`;
  factIds.push(row!.id);
  for (let i = 0; i < articleIdsForFact.length; i++) {
    await sql`INSERT INTO fact_articles (fact_id, article_id, role)
      VALUES (${row!.id}, ${articleIdsForFact[i]!}, ${roles[i]!})`;
  }
  return row!.id;
}

test("100 normal publications reconcile once and match synchronous global selection", async () => {
  const ids: string[] = [];
  for (let i = 0; i < 100; i++) {
    const id = await fixture("policy", `全国重大政策监管新规正式生效 ${i}`);
    await fact([id]);
    ids.push(id);
  }
  let reconciliations = 0;
  const old = sql.options.debug;
  sql.options.debug = (_id, query) => {
    if (query.includes("FROM facts f") && query.includes("LEFT JOIN fact_articles")) reconciliations++;
  };
  try {
    for (const id of ids) await publishArticle(id, { batchEditorial: true });
    const [pending] = await sql`SELECT pending_events FROM editorial_batch_state`;
    assert.equal(pending?.pending_events, 100);
    assert.equal(reconciliations, 0);
    assert.equal((await sql`SELECT count(*)::int AS count FROM publications
      WHERE article_id=ANY(${ids}) AND eligible AND visibility='public'`)[0]?.count, 100);
    const result = await reconcileEditorialBatch();
    assert.equal(result.events, 100);
    assert.equal(reconciliations, 1);
    const selectedBefore = await sql`SELECT article_id FROM publications WHERE article_id=ANY(${ids}) AND selected ORDER BY article_id`;
    await reconcileEditorialPolicies();
    assert.deepEqual(await sql`SELECT article_id FROM publications WHERE article_id=ANY(${ids}) AND selected ORDER BY article_id`, selectedBefore);
    assert.equal((await reconcileEditorialBatch()).events, 0, "duplicate wake does not repeat selection");
  } finally {
    sql.options.debug = old;
  }
});

test("dirty generation rolls back with producer and later changes survive a prior drain", async () => {
  const [initial] = await sql`SELECT generation FROM editorial_batch_state`;
  await assert.rejects(sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('dailynews-editorial-projection'))`;
    await markEditorialDirtyTx(tx, new Date());
    throw new Error("producer crash");
  }), /producer crash/);
  assert.equal((await sql`SELECT generation FROM editorial_batch_state`)[0]?.generation, initial?.generation);
  const id = await fixture("policy", "全国重大政策监管新规正式生效");
  await fact([id]);
  await publishArticle(id, { batchEditorial: true });
  const first = await reconcileEditorialBatch();
  await publishArticle(id, { batchEditorial: true });
  assert.equal(await recoverEditorialBatch(new Date(Date.now() + 5_000)), true, "overdue pending recovered");
  const second = await reconcileEditorialBatch();
  assert.equal(second.events, 1);
  assert.ok(second.generation > first.generation);
});

test("feature cache reuses identical input and rebuilds on due time and changed evidence", async () => {
  const now = new Date();
  const id = await fixture("policy", "全国重大政策监管新规正式生效", SOURCE_A, new Date(now.getTime() - 3 * 3_600_000));
  const factId = await fact([id]);
  await publishArticle(id, { now });
  const [first] = await sql`SELECT * FROM fact_feature_cache WHERE fact_id=${factId}`;
  assert.ok(first);
  await reconcileEditorialPolicies(new Date(now.getTime() + 10_000));
  assert.equal((await sql`SELECT evaluated_at FROM fact_feature_cache WHERE fact_id=${factId}`)[0]?.evaluated_at.toISOString(), first.evaluated_at.toISOString());
  const due = new Date(first.next_reevaluation_at.getTime() + 1);
  await reconcileEditorialPolicies(due);
  assert.equal((await sql`SELECT evaluated_at FROM fact_feature_cache WHERE fact_id=${factId}`)[0]?.evaluated_at.toISOString(), due.toISOString());
  await sql`UPDATE publications SET summary='国家监管机构公布重大新规，影响全国主要行业与公共服务。' WHERE article_id=${id}`;
  await reconcileEditorialPolicies(due);
  assert.notEqual((await sql`SELECT input_signature FROM fact_feature_cache WHERE fact_id=${factId}`)[0]?.input_signature, first.input_signature);
});

test("withdrawal uses urgent synchronous representative replacement even when batching requested", async () => {
  const a = await fixture("policy", "全国重大政策监管新规正式生效");
  const b = await fixture("policy", "全国重大政策监管新规正式生效", SOURCE_B);
  const f = await fact([a, b]);
  await publishArticle(a, { batchEditorial: true });
  await publishArticle(b, { batchEditorial: true });
  await reconcileEditorialBatch();
  await sql`INSERT INTO editorial_overrides (article_id, fields, visibility, reason) VALUES (${b}, '{}', 'withdrawn', 'fixture')`;
  await publishArticle(b, { batchEditorial: true });
  assert.equal((await sql`SELECT representative_article_id FROM fact_editorial_state WHERE fact_id=${f}`)[0]?.representative_article_id, a);
  assert.equal((await sql`SELECT selected FROM publications WHERE article_id=${b}`)[0]?.selected, false);
});

test("time-only scheduler skips fresh facts and rebuilds at an existing due boundary", async () => {
  const now = new Date();
  const id = await fixture("policy", "全国重大政策监管新规正式生效", SOURCE_A, new Date(now.getTime() - 3 * 3_600_000));
  const factId = await fact([id]);
  await publishArticle(id, { now });
  await sql`UPDATE sources SET updated_at=clock_timestamp() WHERE id=${SOURCE_A}`;
  assert.equal((await reconcileDueEditorialPolicies(new Date(now.getTime() + 1_000))).facts, 0,
    "collector status timestamps do not invalidate editorial features");
  const [state] = await sql`SELECT next_reevaluation_at FROM fact_editorial_state WHERE fact_id=${factId}`;
  assert.ok((await reconcileDueEditorialPolicies(new Date(state!.next_reevaluation_at.getTime() + 1))).facts > 0);
});

test("overlapping publications and drains retain every committed generation", async () => {
  const ids: string[] = [];
  for (let i = 0; i < 12; i++) {
    const id = await fixture("policy", `全国重大政策监管新规正式生效 ${i}`);
    await fact([id]);
    ids.push(id);
  }
  await Promise.all([...ids.map(id => publishArticle(id, { batchEditorial: true })), reconcileEditorialBatch()]);
  await reconcileEditorialBatch();
  const [state] = await sql`SELECT * FROM editorial_batch_state`;
  assert.equal(state!.generation, state!.applied_generation);
  assert.equal(state!.pending_events, 0);
  assert.equal((await sql`SELECT count(*)::int AS count FROM publications WHERE article_id=ANY(${ids}) AND eligible`)[0]!.count, ids.length);
});


test("admin source feature edits reconcile immediately and policy-version changes wake the no-due scheduler", async () => {
  const id = await fixture("policy", "全国重大政策监管新规正式生效");
  const factId = await fact([id]);
  await publishArticle(id);
  const [before] = await sql`SELECT input_signature FROM fact_feature_cache WHERE fact_id=${factId}`;
  const [source] = await sql`SELECT config, updated_at FROM sources WHERE id=${SOURCE_A}`;
  await updateSource(SOURCE_A, { version: source!.updated_at.toISOString(), patch: { config: {
    ...source!.config, dailyNews: { ...source!.config.dailyNews, sourceCredibility: 50,
      adapter: "rss", allowedHosts: ["example.com"], publisherKey: "publisher:xinhua" },
  } }, reason: "offline source feature regression" }, "test");
  assert.notEqual((await sql`SELECT input_signature FROM fact_feature_cache WHERE fact_id=${factId}`)[0]!.input_signature, before!.input_signature);
  await sql`UPDATE fact_feature_cache SET policy_version='previous-policy' WHERE fact_id=${factId}`;
  assert.ok((await reconcileDueEditorialPolicies()).facts > 0);
  assert.notEqual((await sql`SELECT policy_version FROM fact_feature_cache WHERE fact_id=${factId}`)[0]!.policy_version, "previous-policy");
});
