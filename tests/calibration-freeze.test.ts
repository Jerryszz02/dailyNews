import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadAnalyzeInput } from '@aihot/backend/editorial/input';
import { analysisSignature, type AnalysisModels } from '@aihot/backend/editorial/policy';
import type { Db } from '@aihot/backend/db';
import { trainCalibration } from '@aihot/backend/editorial/calibration';

const policy = trainCalibration(Array.from({ length: 3 }, (_, i) => ({ id: String(i), title: 'football', body: '', category: 'ai', selected: true, goldCategory: 'sports', goldSelected: false })), 'frozen');
const article = { id: 'article', revision: 1, title: 'football', url: 'https://example.com/news', author: null, published_at: null, discovered_at: new Date(), body_text: 'the '.repeat(20), excerpt: null, body_status: 'ok', x_post: null, x_article: null, media: [], source_name: 'test', source_kind: 'rss', tier: 'T1', first_party: true, source_tags: [], owner_entity_id: null, config: {}, translation_zh: null, override_fields: null, override_version: 0, editorial_category: null, classification_fallback_count: 0, classification_fallback_revision: 1, classification_fallback_category: null, classification_fallback_config_version: null, classification_retry_count: 0, classification_retry_revision: 1 };
function dbWith(prior: unknown[], active = policy, material: unknown = article) {
  const queries: string[] = [];
  const db = (async (strings: TemplateStringsArray) => {
    const query = strings.join('?');
    queries.push(query);
    if (query.includes('FROM articles a')) return [material];
    if (query.includes('FROM analyses')) return prior;
    if (query.includes('review_calibration_state')) return [{ policy: active, report: { passed: true } }];
    throw new Error(query);
  }) as unknown as Db;
  return { db, queries };
}

test('new revision reads active policy while an old analysis freezes null without active queries', async () => {
  const fresh = dbWith([]);
  const input = await loadAnalyzeInput('article', fresh.db);
  assert.equal(input?.calibrationPolicy?.id, 'frozen');
  assert(fresh.queries.some(query => query.includes('review_calibration_state')));
  const old = dbWith([{ output: {} }]);
  const historical = await loadAnalyzeInput('article', old.db);
  assert.equal(historical?.calibrationPolicy, null);
  assert(!old.queries.some(query => query.includes('review_calibration_state')));
  const models = {} as AnalysisModels;
  assert.equal(analysisSignature(historical!, models), analysisSignature({ ...historical!, calibrationPolicy: undefined }, models));
  assert.notEqual(analysisSignature(input!, models), analysisSignature(historical!, models));
});

test('later activation or deactivation does not alter a revision already analyzed with a snapshot', async () => {
  const frozen = dbWith([{ output: { calibration: { policy } } }], { ...policy, id: 'different-active' });
  const input = await loadAnalyzeInput('article', frozen.db);
  assert.deepEqual(input?.calibrationPolicy, policy);
  assert(!frozen.queries.some(query => query.includes('review_calibration_state')));
});

test('fresh out of scope revisions never load active calibration; existing snapshots stay frozen', async () => {
  for (const material of [
    { ...article, body_text: 'short' },
    { ...article, x_post: { text: 'long X post' } },
    { ...article, source_kind: 'x_search' },
    { ...article, body_text: '', excerpt: 'the '.repeat(20) },
  ]) {
    const fresh = dbWith([], policy, material);
    assert.equal((await loadAnalyzeInput('article', fresh.db))?.calibrationPolicy, null);
    assert(!fresh.queries.some(query => query.includes('review_calibration_state')));
    const frozen = dbWith([{ output: { calibration: { policy } } }], policy, material);
    assert.deepEqual((await loadAnalyzeInput('article', frozen.db))?.calibrationPolicy, policy);
  }
  const excerpt = dbWith([], policy, { ...article, body_text: null, excerpt: 'the '.repeat(20) });
  assert.equal((await loadAnalyzeInput('article', excerpt.db))?.calibrationPolicy?.id, 'frozen');
});
