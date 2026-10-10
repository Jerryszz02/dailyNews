import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { currentAnalysisSignature } from "@aihot/backend/editorial/policy";
import { publishArticle } from "@aihot/backend/publication/publish";
import { buildApp } from "../apps/api/src/app.ts";
import { overrideFields } from "@aihot/backend/admin/content";
import { stopBoss } from "@aihot/backend/jobs/queue";

const SOURCE = `copy-gate-${tag()}`;
const ids: string[] = [];
const app = await buildApp();
before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at)
    VALUES (${SOURCE}, '中文出口回归', 'rss', 'T1', 'editorial', '2100-01-01')`;
});
after(async () => {
  if (ids.length) {
    await sql`DELETE FROM selected_ledger WHERE article_id=ANY(${ids}::text[])`;
    await sql`DELETE FROM selected_state WHERE article_id=ANY(${ids}::text[])`;
    await sql`DELETE FROM articles WHERE id=ANY(${ids}::text[])`;
  }
  await sql`DELETE FROM sources WHERE id=${SOURCE}`;
  await app.close();
  await stopBoss();
  await closeDb();
});

async function fixture() {
  const { articleId } = await upsertMaterial({ sourceId: SOURCE, url: `https://example.com/${randomUUID()}`,
    title: 'Central bank announces monetary policy', language: 'en', bodyText: 'The bank announced its new monetary policy.',
    bodyStatus: 'ok', via: 'ingest', publishedAt: new Date() });
  ids.push(articleId);
  return articleId;
}
async function analysis(id: string, ready: boolean) {
  const signature = await currentAnalysisSignature(id);
  await sql`INSERT INTO analyses (article_id, input_revision, origin, input_signature, relevance, category,
    title_zh, summary_zh, selected, score) VALUES (${id}, 1, 'model', ${signature}, ${ready ? 'pass' : 'unknown'},
    'finance', ${ready ? '央行公布货币政策' : null}, ${ready ? '央行公布新的货币政策及实施安排。' : null}, false, null)`;
  await sql`UPDATE articles SET processing_state='analyzed', processing_error=${ready ? null : 'Chinese copy pending'} WHERE id=${id}`;
}
async function projection(id: string) {
  return (await sql<{ visibility: string; eligible: boolean; title: string; summary: string | null; public_ready_at: Date | null }[]>`
    SELECT visibility, eligible, title, summary, public_ready_at FROM publications WHERE article_id=${id}`)[0]!;
}

test('missing Chinese copy is withheld, can be retried, and a successful copy restores publication', async () => {
  const id = await fixture();
  await analysis(id, false);
  await publishArticle(id);
  const pending = await projection(id);
  assert.equal(pending.visibility, 'public', 'internal projection visibility does not grant public eligibility');
  assert.equal(pending.eligible, false);
  assert.equal(pending.public_ready_at, null);
  assert.equal((await app.inject({ method: 'GET', url: `/api/site/items/${id}` })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: `/items/${id}` })).statusCode, 404);
  const feed = await app.inject({ method: 'GET', url: '/api/v1/items?mode=all' });
  assert.equal(feed.statusCode, 200);
  assert.ok(!feed.json().items.some((item: { id: string }) => item.id === id));
  assert.equal((await sql`SELECT processing_error FROM articles WHERE id=${id}`)[0]!.processing_error, 'Chinese copy pending');
  assert.equal((await sql`SELECT count(*)::int AS n FROM editorial_overrides WHERE article_id=${id}`)[0]!.n, 0,
    'automatic copy gate does not write a persistent manual withdrawal');
  await analysis(id, true);
  await publishArticle(id);
  const ready = await projection(id);
  assert.equal(ready.visibility, 'public');
  assert.equal(ready.eligible, true);
  assert.equal(ready.title, '央行公布货币政策');
  assert.ok(ready.public_ready_at);
  const detail = await app.inject({ method: 'GET', url: `/api/site/items/${id}` });
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().title, '央行公布货币政策');
});

test('a later incomplete copy removes an earlier public projection and successful reanalysis preserves human corrections', async () => {
  const id = await fixture();
  await analysis(id, true);
  await publishArticle(id);
  await overrideFields(id, { fields: { title: '人工核实的央行政策标题', summary: '人工核实的政策摘要。' }, reason: '核实原文', version: 0 }, 'test');
  await analysis(id, false);
  await publishArticle(id);
  assert.equal((await projection(id)).eligible, false);
  assert.equal((await app.inject({ method: 'GET', url: `/api/site/items/${id}` })).statusCode, 404);
  await analysis(id, true);
  await publishArticle(id);
  const ready = await projection(id);
  assert.equal(ready.visibility, 'public');
  assert.equal(ready.title, '人工核实的央行政策标题');
  assert.equal(ready.summary, '人工核实的政策摘要。');
  assert.equal((await sql`SELECT version FROM editorial_overrides WHERE article_id=${id}`)[0]!.version, 1);
});
