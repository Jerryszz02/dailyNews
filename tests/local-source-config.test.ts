import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SourceRow } from '@aihot/backend/sources/types';
import { localSourceCandidate, verifiedReaderEvidence } from '../scripts/local-source-config.ts';

function source(): SourceRow {
  return { id: 'original', name: '原信源', kind: 'web_list', tier: 'T2', participation_mode: 'editorial',
    first_party: false, interval_minutes: 60, enabled: false, cursor: { initializedAt: '2026-10-10T00:00:00Z' }, fail_count: 0,
    config: { url: 'https://example.com/news/', itemSelector: 'article', linkSelector: 'a', titleSelector: 'h2',
      _aihot: { initialBackfillLimit: 10, initialBackfillMonths: 1 }, denyUrlPrefixes: ['https://example.com/news/private'],
      dailyNews: { legacySourceId: 'original', sectionId: 'news', publisherKey: 'publisher:original', legacyEnabled: true,
        allowedHosts: ['example.com'], allowedPathPrefixes: ['example.com/news'], adapter: 'web_list', migrationStatus: 'needs_selector' } } };
}
test('public transport replacement drops incompatible parsing keys while retaining the source and admission boundary', () => {
  const original = source();
  const candidate = localSourceCandidate(original, { id: original.id, kind: 'json_list', configOverrides: {
    url: 'https://example.com/api/news', itemsPath: 'items', titlePaths: ['title'], urlTemplate: '{raw:url}',
    dailyNews: { adapter: 'json_list', allowedHosts: ['other.example'], legacyEnabled: false, publisherKey: 'publisher:other' },
    _aihot: { initialBackfillLimit: 1000 },
  } }, '2026-10-10T12:00:00Z');
  assert.equal(candidate.kind, 'json_list');
  assert.equal(candidate.config.itemSelector, undefined);
  assert.equal(candidate.config.url, 'https://example.com/api/news');
  assert.deepEqual(candidate.config._aihot, original.config._aihot);
  assert.deepEqual(candidate.config.denyUrlPrefixes, original.config.denyUrlPrefixes);
  for (const key of ['allowedHosts', 'allowedPathPrefixes', 'legacyEnabled', 'legacySourceId', 'sectionId', 'publisherKey'])
    assert.deepEqual(candidate.config.dailyNews[key], original.config.dailyNews[key]);
  assert.equal(candidate.config.dailyNews.adapter, 'json_list');
  assert.equal(original.config.dailyNews.migrationStatus, 'needs_selector', 'verification does not mutate the live source object');
});
test('RSS adaptation requires its own endpoint and cannot turn credential sources into public sources', () => {
  const s = source();
  const rss = localSourceCandidate(s, { id:s.id, kind:'rss', configOverrides:{feedUrl:'https://example.com/feed'} }, '2026-10-10');
  assert.equal(rss.config.url, undefined);
  assert.equal(rss.config.dailyNews.adapter, 'rss');
  assert.throws(() => localSourceCandidate({...s,kind:'x_search'}, {id:s.id,kind:'rss',configOverrides:{}}, '2026-10-10'), /public source/);
  assert.throws(() => localSourceCandidate(s, {id:'wrong',configOverrides:{}}, '2026-10-10'), /identity mismatch/);
  assert.throws(() => localSourceCandidate(s, {id:s.id,configOverrides:{madeUpSelector:'*'}}, '2026-10-10'), /不支持/);
});
test('reader evidence distinguishes source summaries from extracted bodies and retains source dates', () => {
  const publishedAt = new Date('2026-10-10T10:30:00Z');
  const summary = '经来源原文核实的简短消息内容。'.repeat(5);
  const evidence = verifiedReaderEvidence({publishedAt}, {body:null,summary,publishedAt:null});
  assert.equal(evidence.usable,true);
  assert.equal(evidence.materialScope,'source_summary');
  assert.equal(evidence.bodyChars,0);
  assert.equal(evidence.publishedAt,publishedAt.toISOString());
  assert.equal(verifiedReaderEvidence({}, {body:null,summary:'新闻导航',publishedAt:null}).usable,false);
  assert.equal(verifiedReaderEvidence({}, {body:{text:'article body'},summary:null,publishedAt}).materialScope,'extracted_body');
});

test('source verification requires the same trustworthy date evidence as collection', () => {
  const body = { text: 'Published article material. '.repeat(20) };
  const publishedAt = new Date('2026-10-10T10:30:00Z');
  assert.equal(verifiedReaderEvidence({}, {body,summary:null,publishedAt:null}).usable,false);
  assert.equal(verifiedReaderEvidence({}, {body,summary:null,publishedAt:new Date('invalid')}).usable,false);
  const authoritative = verifiedReaderEvidence({publishedAt}, {body,summary:null,publishedAt:null}, {authoritativeDate:true});
  assert.equal(authoritative.usable,false);
  assert.equal(authoritative.publishedAt,null,'authoritative detail dates cannot borrow the listing timestamp');
  assert.equal(verifiedReaderEvidence({publishedAt}, {body,summary:null,publishedAt:null}).usable,true);
  assert.equal(verifiedReaderEvidence({}, {body,summary:null,publishedAt}, {authoritativeDate:true}).usable,true);
});
