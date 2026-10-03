import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { contentChain, searchContent } from "@aihot/backend/admin/content";

const T = tag();
const source = `admin-policy-${T}`;
const id = `admin-policy-item-${T}`;
after(async () => {
  await sql`DELETE FROM articles WHERE id=${id}`;
  await sql`DELETE FROM sources WHERE id=${source}`;
  await closeDb();
});

test("admin reads published strategy metadata and keeps analysis score separate", async () => {
  await sql`INSERT INTO sources (id, name, kind, tier) VALUES (${source}, '策略测试来源', 'rss', 'T1')`;
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at,
    processing_state, processing_error, processing_retry_at)
    VALUES (${id}, ${source}, ${id}, ${`https://example.test/${id}`}, '事实审阅', now(), now(),
      'failed', '等待分类复核', now() + interval '5 minutes')`;
  const [analysis] = await sql<{ id: number }[]>`INSERT INTO analyses
    (article_id, input_revision, origin, relevance, category, score, selected)
    VALUES (${id}, 1, 'rule', 'pass', 'policy', 91, true) RETURNING id`;
  await sql`INSERT INTO publications (article_id, source_id, title, channel, url, discovered_at, timeline_at, sort_at,
    analysis_id, input_revision, policy_tier, policy_id, eligible, selected, score)
    VALUES (${id}, ${source}, '事实审阅', 'news', ${`https://example.test/${id}`}, now(), now(), now(),
      ${analysis!.id}, 1, 'T1', 'classification-pending', false, false, null)`;

  const [pending] = await searchContent(id);
  assert.equal(pending?.score, null, "the analysis score is not a non-AI public importance score");
  assert.equal(pending?.policy_id, "classification-pending");
  assert.equal(pending?.processing_error, "等待分类复核");
  assert.ok(pending?.processing_retry_at);

  await sql`UPDATE publications SET policy_id='dailynews-non-ai-fact', score=76,
    score_kind='legacy_curation_total', importance_tier='important', fact_status='developing' WHERE article_id=${id}`;
  const [published] = await searchContent(id);
  assert.deepEqual([published?.score, published?.score_kind, published?.importance_tier, published?.fact_status],
    [76, "legacy_curation_total", "important", "developing"]);
  const chain = await contentChain(id);
  assert.equal(chain?.publication?.score_kind, "legacy_curation_total");
  assert.equal(chain?.article.processing_error, "等待分类复核");
  assert.ok(chain?.article.processing_retry_at);
});
