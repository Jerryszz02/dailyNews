import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as cheerio from 'cheerio';
import { fromHtml, allowed, parseLooseDate } from '../packages/backend/src/sources/web-list.ts';
import { localSourceCandidate } from '../scripts/local-source-config.ts';
import { assertSupportedConfig } from '../packages/backend/src/sources/config-keys.ts';
import type { SourceRow } from '../packages/backend/src/sources/types.ts';
type Fixture = { legacy:string;source:SourceRow;configOverrides:SourceRow['config'];html:string;expected:Array<{url:string;title:string;publishedAt:string|null}>;dateHtml:string;readerPublishedAt:string|null };
const fixtures=JSON.parse(readFileSync(new URL('./fixtures/source-restoration-world.json',import.meta.url),'utf8')) as Fixture[];
for(const f of fixtures) test(`${f.legacy}: observed news cards exclude navigation and foreign hosts and retain dates`,()=>{
  const source: SourceRow=localSourceCandidate(f.source, {id:f.source.id,configOverrides:f.configOverrides}, '2026-10-10');
  assert.equal(source.config.dailyNews.migrationStatus, 'verified');
  for(const key of ['itemSelector','linkSelector','titleSelector'])assert.equal(typeof source.config[key], 'string');
  assert.doesNotThrow(()=>assertSupportedConfig(source.kind,source.config));
  const rows=fromHtml(f.html,source.config.url,source);
  assert.deepEqual(rows.map(a=>({url:a.url,title:a.title,publishedAt:a.publishedAt?.toISOString()??null})),f.expected);
  assert.ok(rows.length>0);
  assert.deepEqual(source.config.dailyNews.allowedHosts,f.source.config.dailyNews.allowedHosts);
  assert.deepEqual(source.config.dailyNews.allowedPathPrefixes,f.source.config.dailyNews.allowedPathPrefixes);
  assert.equal(allowed('https://example.com/foreign-story',source),false);
  for(const a of rows)assert.ok(allowed(a.url,source));
  const detail=source.config.detail;
  if(f.dateHtml){
    const $=cheerio.load(f.dateHtml);
    const raw=detail.publishedAtRegex ? new RegExp(detail.publishedAtRegex).exec(f.dateHtml)?.[1] :
      detail.publishedAtSelector ? $(detail.publishedAtSelector).first().text() : $('meta[property="article:published_time"]').attr('content');
    assert.equal(parseLooseDate(raw,detail.publishedAtUtcOffset)?.toISOString(),f.readerPublishedAt);
  }
});
