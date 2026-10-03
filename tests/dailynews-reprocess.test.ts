import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { currentAnalysisSignature, AI_POLICY_VERSION, CLASSIFICATION_VERSION } from "@aihot/backend/editorial/policy";
import { publishArticle } from "@aihot/backend/publication/publish";
import { reprocessActiveAnalyses } from "@aihot/backend/publication/reprocess";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { sweepUnprocessed } from "@aihot/backend/jobs/content";

const T = tag();
const SOURCE = `reprocess-${T}`;
before(async () => {
  await sql`INSERT INTO sources(id, name, kind, tier, participation_mode, next_fetch_at)
    VALUES(${SOURCE}, '重评测试来源', 'rss', 'T1', 'editorial', '2100-01-01')`;
});
after(async () => { await stopBoss(); await closeDb(); });

async function ready(label: string, at: Date) {
  const { articleId } = await upsertMaterial({ sourceId: SOURCE, url: `https://example.com/${T}/${label}`,
    title: `模型发布 ${label}`, bodyText: '模型增加了新的能力。'.repeat(20), bodyStatus: 'ok',
    via: 'fetch', discoveredAt: at, publishedAt: at });
  const signature = await currentAnalysisSignature(articleId);
  await sql`INSERT INTO analyses(article_id, input_revision, origin, relevance, category, title_zh, summary_zh,
    score, selected, policy_id, policy_version, classification_version, input_signature)
    VALUES(${articleId}, 1, 'model', 'pass', 'ai', ${`模型发布 ${label}`}, '有据可查的模型功能变化。',
    85, true, 'aihot-ai-article', ${AI_POLICY_VERSION}, ${CLASSIFICATION_VERSION}, ${signature})`;
  await sql`UPDATE articles SET processing_state = 'analyzed' WHERE id = ${articleId}`;
  await publishArticle(articleId, { releasedAt: at });
  return articleId;
}

test('a source policy change invalidates only the active window and queues each signature once', async () => {
  const now = new Date();
  const active = await ready('active', now);
  const old = await ready('archive', new Date(now.getTime() - 4 * 86_400_000));
  await sql`UPDATE sources SET tier = 'T2' WHERE id = ${SOURCE}`;
  assert.equal((await reprocessActiveAnalyses({ sourceId: SOURCE, now, reason: 'test tier change' })).invalidated, 1);
  const [activeState] = await sql`SELECT p.eligible, p.selected, a.processing_state, a.processing_attempt_tag
    FROM publications p JOIN articles a ON a.id=p.article_id WHERE a.id=${active}`;
  assert.equal(activeState!.eligible, false);
  assert.equal(activeState!.selected, false);
  assert.equal(activeState!.processing_state, 'new');
  assert.match(String(activeState!.processing_attempt_tag), /^policy:[a-f0-9]{64}$/);
  const [archiveState] = await sql`SELECT processing_state, processing_attempt_tag FROM articles WHERE id=${old}`;
  assert.equal(archiveState!.processing_state, 'analyzed');
  assert.equal(archiveState!.processing_attempt_tag, null);
  assert.equal((await reprocessActiveAnalyses({ sourceId: SOURCE, now, reason: 'repeat sweep' })).invalidated, 0);
  assert.equal((await reprocessActiveAnalyses({ articleIds: [old], now, reason: 'explicit historical correction' })).invalidated, 1);
  const removed = await sql`SELECT 1 FROM selected_ledger WHERE article_id=${active} AND op='remove'`;
  assert.equal(removed.length, 1);
});

test('exhausted null classification stays pending until a new material revision or explicit re-evaluation', async () => {
  const id = await ready('pending', new Date());
  await sql`UPDATE articles SET classification_retry_revision=revision, classification_retry_count=2,
    processing_state='new', processing_queued_at=NULL, created_at=now()-interval '10 minutes'
    WHERE id=${id}`;
  await sweepUnprocessed();
  const [state] = await sql`SELECT classification_retry_count, processing_queued_at FROM articles WHERE id=${id}`;
  assert.equal(state!.classification_retry_count, 2);
  assert.equal(state!.processing_queued_at, null);
  await upsertMaterial({ sourceId: SOURCE, url: `https://example.com/${T}/pending`, title: '新增证据后的模型发布',
    bodyText: '新增了不同的实质信息。'.repeat(20), bodyStatus: 'ok', via: 'fetch', publishedAt: new Date() });
  await sweepUnprocessed();
  const [revised] = await sql`SELECT revision, processing_queued_at FROM articles WHERE id=${id}`;
  assert.equal(revised!.revision, 2);
  assert.ok(revised!.processing_queued_at, 'the new material receives a fresh classification budget');
});
