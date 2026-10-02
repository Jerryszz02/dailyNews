// Different URLs require a confident identity judgement before their reports share a fact or story.
// The same URL remains deterministic even when no model is available.
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { groupArticle } from "@aihot/backend/events/group";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { publishArticle } from "@aihot/backend/publication/publish";
import { lexicalSimilarity, reportText, type Relation } from "@aihot/backend/events/relate";

const T = tag();
const SOURCE = `group-confidence-${T}`;
const SECOND_SOURCE = `${SOURCE}-second`;
let batchRelation: Relation = "SAME_OCCURRENCE";
let batchConfidence = 0.95;
let reviewRelation: Relation = "SAME_OCCURRENCE";
let reviewConfidence = 0.95;
const provider = await stub((_hit, req) => {
  const body = JSON.parse(req.body) as { messages: Array<{ content: string }> };
  const user = body.messages[1]!.content;
  const answer = user.includes("报道 A")
    ? { a: "报道", b: "报道", relation: reviewRelation, confidence: reviewConfidence, difference: "" }
    : { query: "报道", decisions: [{ id: "C1", relation: batchRelation, confidence: batchConfidence, note: "" }] };
  return { id: "local-group-confidence-stub", choices: [{ message: { content: JSON.stringify(answer) } }], usage: { prompt_tokens: 8, completion_tokens: 8, total_tokens: 16 } };
});
process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
process.env.DEEPSEEK_API_KEY = "test-key";
process.env.GROUP_MODEL = "deepseek-flash";
process.env.GROUP_REVIEW_MODEL = "deepseek-flash";

async function article(title: string, url: string, sourceId = SOURCE, identityKey?: string) {
  const { articleId } = await upsertMaterial({
    sourceId, url, title, identityKey, bodyText: title, bodyStatus: "ok", via: "fetch", publishedAt: new Date(),
  });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected, output)
            VALUES (${articleId}, 1, 'rule', 'pass', 'ai-models', ${title}, ${title}, 80, false, ${sql.json({ fact: { title } })})`;
  await publishArticle(articleId);
  return articleId;
}

async function existingFact(suffix: string, title: string, url = `https://example.com/${SOURCE}/${suffix}`) {
  const report = await article(title, url);
  const [story] = await sql<{ id: number }[]>`INSERT INTO stories (public_id, title, first_report_at, latest_at) VALUES (${randomUUID()}, ${title}, now(), now()) RETURNING id`;
  const [fact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title) VALUES (${`f-${T}-${suffix}`}, ${story!.id}, ${title}) RETURNING id`;
  await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${fact!.id}, ${report}, 'report')`;
  return { factId: Number(fact!.id), storyId: Number(story!.id), url };
}

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at)
            VALUES (${SOURCE}, 'Group confidence', 'rss', 'T1', 'editorial', '2100-01-01'),
                   (${SECOND_SOURCE}, 'Group confidence second', 'rss', 'T1', 'editorial', '2100-01-01')`;
});
after(async () => {
  await provider.close();
  await stopBoss();
  await closeDb();
});

test("low-confidence SAME_OCCURRENCE cannot merge different URLs even with exact text", async () => {
  const title = `低置信度同次事件${tag()}甲`;
  const target = await existingFact("low-occurrence", title);
  batchRelation = "SAME_OCCURRENCE";
  batchConfidence = 0.3;
  const hits = provider.hits();
  const result = await groupArticle(await article(title, `https://example.com/${SOURCE}/low-occurrence-query`));
  assert.equal(result.verdict, "new-story");
  assert.notEqual(result.factId, target.factId);
  assert.notEqual(result.storyId, target.storyId);
  assert.equal(provider.hits() - hits, 1, "high similarity must not bypass the first confidence gate");
});

test("a review with SAME_OCCURRENCE but low confidence cannot merge different URLs", async () => {
  const marker = tag();
  const baseTitle = `北辰公司${marker}今天发布蓝色无人机`;
  const queryTitle = `北辰公司${marker}今日公布红色无人机`;
  const similarity = lexicalSimilarity(reportText(baseTitle, baseTitle), reportText(queryTitle, queryTitle));
  assert.ok(similarity >= 0.6 && similarity < 0.85, `review path fixture similarity: ${similarity}`);
  const target = await existingFact("low-review", baseTitle);
  batchRelation = "SAME_OCCURRENCE";
  batchConfidence = 0.95;
  reviewRelation = "SAME_OCCURRENCE";
  reviewConfidence = 0.4;
  const id = await article(queryTitle, `https://example.com/${SOURCE}/low-review-query`);
  const result = await groupArticle(id);
  assert.equal(result.verdict, "new-story");
  assert.notEqual(result.factId, target.factId);
  assert.notEqual(result.storyId, target.storyId, "a rejected review must not rejoin the target through consolidation");
  const reviews = await sql<{ purpose: string }[]>`SELECT purpose FROM receipts WHERE purpose = 'group_review' AND subject = ${`article:${id}:fact:${target.factId}`}`;
  assert.equal(reviews.length, 1, "the distinct-URL candidate must receive its second review");
});

test("two SAME_OCCURRENCE decisions at the confidence boundary can merge different URLs", async () => {
  const marker = tag();
  const baseTitle = `明远公司${marker}今天发布蓝色无人机`;
  const queryTitle = `明远公司${marker}今日公布红色无人机`;
  const similarity = lexicalSimilarity(reportText(baseTitle, baseTitle), reportText(queryTitle, queryTitle));
  assert.ok(similarity >= 0.6 && similarity < 0.85, `review path fixture similarity: ${similarity}`);
  const target = await existingFact("boundary-review", baseTitle);
  batchRelation = "SAME_OCCURRENCE";
  batchConfidence = 0.8;
  reviewRelation = "SAME_OCCURRENCE";
  reviewConfidence = 0.8;
  const result = await groupArticle(await article(queryTitle, `https://example.com/${SOURCE}/boundary-review-query`));
  assert.equal(result.verdict, "same-fact");
  assert.equal(result.factId, target.factId);
});

test("low-confidence SAME_STORY cannot attach a different URL as a development", async () => {
  const title = `低置信度后续报道${tag()}甲`;
  const target = await existingFact("low-story", title);
  batchRelation = "SAME_STORY";
  batchConfidence = 0.45;
  const result = await groupArticle(await article(title, `https://example.com/${SOURCE}/low-story-query`));
  assert.equal(result.verdict, "new-story");
  assert.notEqual(result.storyId, target.storyId);
});

test("same URL keeps its deterministic fact without a model call", async () => {
  const title = `同URL报道${tag()}`;
  const target = await existingFact("same-url", title);
  batchRelation = "UNRELATED";
  batchConfidence = 0;
  const hits = provider.hits();
  const result = await groupArticle(await article(title, target.url, SECOND_SOURCE, `test:${SECOND_SOURCE}:same-url`));
  assert.equal(result.verdict, "same-url");
  assert.equal(result.factId, target.factId);
  assert.equal(result.storyId, target.storyId);
  assert.equal(provider.hits(), hits);
});
