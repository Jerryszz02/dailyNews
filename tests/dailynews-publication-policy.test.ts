import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { currentAnalysisSignature } from "@aihot/backend/editorial/policy";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { publishArticle } from "@aihot/backend/publication/publish";
import { reconcileEditorialPolicies } from "@aihot/backend/publication/editorial";
import { selectedCondition } from "@aihot/backend/publication/scope";
import { tag } from "./setup.ts";

process.env.DAILYNEWS_ALLOW_LEGACY_FIXTURES = "1";
const T = tag();
const SOURCE_A = `p2-xinhua-${T}`;
const SOURCE_B = `p2-ap-${T}`;
const articleIds: string[] = [];
const factIds: number[] = [];
const storyIds: number[] = [];

before(async () => {
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

test("withdrawal replaces one representative and writes remove/upsert in the same projection", async () => {
  const title = "全国重大政策监管新规正式生效";
  const first = await fixture("policy", title);
  const second = await fixture("policy", title, SOURCE_B);
  const id = await fact([first, second], ["primary", "report"]);
  await publishArticle(first);
  await publishArticle(second);
  const [before] = await sql<{ representative_article_id: string | null }[]>`SELECT representative_article_id FROM fact_editorial_state WHERE fact_id=${id}`;
  assert.equal(before?.representative_article_id, second, "higher credibility report initially represents the fact");
  await sql`INSERT INTO editorial_overrides (article_id, fields, visibility, reason)
    VALUES (${second}, '{}', 'withdrawn', 'fixture withdrawal')`;
  await publishArticle(second);
  const [state] = await sql<{ representative_article_id: string | null }[]>`SELECT representative_article_id FROM fact_editorial_state WHERE fact_id=${id}`;
  assert.equal(state?.representative_article_id, first);
  const pubs = await sql<{ article_id: string; selected: boolean }[]>`SELECT article_id, selected FROM publications WHERE article_id IN (${first},${second}) ORDER BY article_id`;
  assert.equal(pubs.filter((p) => p.selected).length, 1);
  const ledger = await sql<{ article_id: string; op: string }[]>`SELECT article_id, op FROM selected_ledger WHERE article_id IN (${first},${second}) ORDER BY seq`;
  assert.ok(ledger.some((row) => row.article_id === second && row.op === "remove"));
  assert.ok(ledger.some((row) => row.article_id === first && row.op === "upsert"));
  const beforeReplay = (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM editorial_decisions WHERE scope='fact' AND subject_id=${String(id)}`)[0]!.n;
  await reconcileEditorialPolicies(new Date());
  assert.equal((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM editorial_decisions WHERE scope='fact' AND subject_id=${String(id)}`)[0]!.n, beforeReplay,
    "unchanged selected projection must not create a new decision");
});

test("global top-ten and important-thirty quotas displace the former selected article", async () => {
  const old: string[] = [];
  for (let i = 0; i < 40; i++) {
    const id = await fixture("policy", `全国重大政策监管新规第${i}项正式生效`);
    old.push(id);
    await fact([id]);
    await publishArticle(id);
  }
  assert.equal((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM publications WHERE article_id=ANY(${old}::text[]) AND selected`)[0]?.n, 40);
  const fresher = await fixture("policy", "全国重大政策监管新规第十一项正式生效", SOURCE_B, new Date(Date.now() - 15 * 60_000));
  await fact([fresher]);
  await publishArticle(fresher);
  const selected = await sql<{ article_id: string }[]>`SELECT article_id FROM publications WHERE article_id=ANY(${[...old, fresher]}::text[]) AND selected`;
  assert.equal(selected.length, 40);
  assert.ok(selected.some((row) => row.article_id === fresher));
  const displaced = old.find((id) => !selected.some((row) => row.article_id === id));
  assert.ok(displaced);
  assert.ok((await sql`SELECT 1 FROM selected_ledger WHERE article_id=${displaced} AND op='remove' LIMIT 1`).length);
  const [displacedState] = await sql<{ fact_id: number; representative_article_id: string | null; decision_id: number }[]>`
    SELECT fes.fact_id, fes.representative_article_id, fes.decision_id
    FROM fact_editorial_state fes JOIN fact_articles fa ON fa.fact_id=fes.fact_id WHERE fa.article_id=${displaced}`;
  assert.equal(displacedState?.representative_article_id, displaced);
  const [displacedDecision] = await sql<{ representative_article_id: string | null; selected: boolean }[]>`
    SELECT representative_article_id, selected FROM editorial_decisions WHERE id=${displacedState!.decision_id}`;
  assert.equal(displacedDecision?.representative_article_id, displaced);
  assert.equal(displacedDecision?.selected, false);
  assert.equal((await sql<{ selected: boolean }[]>`SELECT selected FROM publications WHERE article_id=${displaced}`)[0]?.selected, false);
});

test("mention-only fact has no representative and manual category flip invalidates old policy", async () => {
  const mention = await fixture("policy", "全国重大政策监管新规正式生效");
  const mentionFact = await fact([mention], ["mention"]);
  await publishArticle(mention);
  assert.equal((await sql<{ representative_article_id: string | null }[]>`SELECT representative_article_id FROM fact_editorial_state WHERE fact_id=${mentionFact}`)[0]?.representative_article_id, null);
  assert.equal((await sql<{ representative_article_id: string | null }[]>`
    SELECT d.representative_article_id FROM editorial_decisions d JOIN fact_editorial_state fes ON fes.decision_id=d.id WHERE fes.fact_id=${mentionFact}`)[0]?.representative_article_id, null);
  const id = await fixture("policy", "全国重大政策监管新规正式生效");
  const idFact = await fact([id]);
  await publishArticle(id);
  assert.equal((await sql<{ selected: boolean }[]>`SELECT selected FROM publications WHERE article_id=${id}`)[0]?.selected, true);
  await sql`INSERT INTO editorial_overrides (article_id, fields, reason)
    VALUES (${id}, ${sql.json({ category: "ai" })}, 'manual category correction')`;
  await publishArticle(id, { queueStaleAnalysis: false });
  const [p] = await sql<{ eligible: boolean; selected: boolean }[]>`SELECT eligible, selected FROM publications WHERE article_id=${id}`;
  assert.equal(p?.eligible, false);
  assert.equal(p?.selected, false);
  assert.equal((await sql<{ primary_category: string | null }[]>`SELECT primary_category FROM fact_editorial_state WHERE fact_id=${idFact}`)[0]?.primary_category, "ai");
  assert.ok((await sql`SELECT 1 FROM selected_ledger WHERE article_id=${id} AND op='remove' LIMIT 1`).length);
});

test("mentions and composite associations cannot outvote a fact's reports or manual category", async () => {
  const primary = await fixture("policy", "全国重大政策监管新规正式生效");
  const mentions = await Promise.all(Array.from({ length: 5 }, (_, i) => fixture("ai", `人工智能模型第${i}项发布`)));
  const composite = await fixture("ai", "人工智能行业综合观察");
  await sql`UPDATE analyses SET output=${sql.json({ scope: "composite", classification: { originalCategory: "ai", effectiveCategory: "ai" } })}
    WHERE article_id=${composite}`;
  await sql`INSERT INTO editorial_overrides (article_id, fields, reason)
    VALUES (${mentions[0]!}, ${sql.json({ category: "ai" })}, 'mention category'),
      (${composite}, ${sql.json({ category: "ai" })}, 'composite category')`;
  const id = await fact([primary, ...mentions, composite], ["primary", ...mentions.map(() => "mention" as const), "report"]);
  await publishArticle(primary, { queueStaleAnalysis: false });
  const [state] = await sql<{ primary_category: string | null; representative_article_id: string | null }[]>`
    SELECT primary_category, representative_article_id FROM fact_editorial_state WHERE fact_id=${id}`;
  assert.equal(state?.primary_category, "policy");
  assert.equal(state?.representative_article_id, primary);
});

test("a mention in an unclassified fact cannot revoke an AI article's primary selection", async () => {
  const id = await fixture("ai", "人工智能模型正式发布");
  await fact([id], ["primary"]);
  await publishArticle(id);
  await fact([id], ["mention"]);
  await reconcileEditorialPolicies();
  const [p] = await sql<{ selected: boolean; eligible: boolean; category: string | null }[]>`
    SELECT selected, eligible, category FROM publications WHERE article_id=${id}`;
  assert.deepEqual({ ...p }, { selected: true, eligible: true, category: "ai" });
  assert.equal((await sql`SELECT 1 FROM selected_ledger WHERE article_id=${id} AND op='remove'`).length, 0);
});

test("read scope hides a stale model decision before republish, then removes its selection", async () => {
  const id = await fixture("ai", "人工智能模型正式发布", SOURCE_A, new Date(), "model");
  await publishArticle(id);
  assert.equal((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM publications p WHERE p.article_id=${id} AND ${selectedCondition(new Date(Date.now() + 10_000))}`)[0]?.n, 0,
    "release gate remains active");
  await sql`UPDATE articles SET revision=revision+1 WHERE id=${id}`;
  assert.equal((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM publications p WHERE p.article_id=${id} AND ${selectedCondition(new Date(Date.now() + 10 * 60_000))}`)[0]?.n, 0);
  await publishArticle(id, { queueStaleAnalysis: false });
  const [p] = await sql<{ eligible: boolean; selected: boolean }[]>`SELECT eligible, selected FROM publications WHERE article_id=${id}`;
  assert.equal(p?.eligible, false);
  assert.equal(p?.selected, false);
  assert.ok((await sql`SELECT 1 FROM selected_ledger WHERE article_id=${id} AND op='remove' LIMIT 1`).length);
  await reconcileEditorialPolicies();
});

test("category requeue cap leaves excess members for the next bounded reconciliation", async () => {
  const ids: string[] = [];
  for (let i = 0; i < 101; i++) ids.push(await fixture("ai", `人工智能产品第${i}项发布`));
  await fact(ids);
  await sql`INSERT INTO editorial_overrides (article_id, fields, reason)
    VALUES (${ids[0]!}, ${sql.json({ category: "finance" })}, 'manual fact category')`;
  await publishArticle(ids[0]!, { queueStaleAnalysis: false });
  assert.equal((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM articles WHERE id=ANY(${ids}::text[]) AND editorial_category='finance'`)[0]?.n, 100);
  await reconcileEditorialPolicies();
  assert.equal((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM articles WHERE id=ANY(${ids}::text[]) AND editorial_category='finance'`)[0]?.n, 101);
  assert.equal((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM articles WHERE id=ANY(${ids}::text[]) AND processing_attempt_tag LIKE 'policy:%'`)[0]?.n, 101);
});

test("AI BLOCK fallback wins the original AI vote; a manual fact category survives a stale model signature", async () => {
  const fallback = await fixture("finance", "央行金融政策正式生效", SOURCE_A, new Date(), "model");
  await sql`UPDATE analyses SET output=${sql.json({ classification: { originalCategory: "ai", effectiveCategory: "finance", fallback: { category: "finance" } } })}
    WHERE article_id=${fallback}`;
  const fallbackFact = await fact([fallback]);
  await publishArticle(fallback);
  assert.equal((await sql<{ primary_category: string | null }[]>`SELECT primary_category FROM fact_editorial_state WHERE fact_id=${fallbackFact}`)[0]?.primary_category, "finance");

  const manual = await fixture("ai", "人工智能模型正式发布", SOURCE_B, new Date(), "model");
  const manualFact = await fact([manual]);
  await publishArticle(manual);
  await sql`INSERT INTO editorial_overrides (article_id, fields, reason)
    VALUES (${manual}, ${sql.json({ category: "finance" })}, 'manual fact category')`;
  await publishArticle(manual, { queueStaleAnalysis: false });
  assert.equal((await sql<{ primary_category: string | null }[]>`SELECT primary_category FROM fact_editorial_state WHERE fact_id=${manualFact}`)[0]?.primary_category, "finance");
  assert.equal((await sql<{ eligible: boolean; selected: boolean }[]>`SELECT eligible, selected FROM publications WHERE article_id=${manual}`)[0]?.eligible, false);
});
