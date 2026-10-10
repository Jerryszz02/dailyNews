import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as cheerio from 'cheerio';
import { fromHtml, allowed, parseLooseDate, jsonLdPublished } from '../packages/backend/src/sources/web-list.ts';
import { assertSupportedConfig } from '../packages/backend/src/sources/config-keys.ts';
import { localSourceCandidate } from '../scripts/local-source-config.ts';
import type { SourceRow } from '../packages/backend/src/sources/types.ts';
interface Fixture { id: string; config: SourceRow['config']; listingHtml: string; expected: Array<{url:string;title:string}>; offHostHtml: string; dateHtml: string; readerPublishedAt: string; readerUrl: string; bodyChars: number }
const fixtures=JSON.parse(readFileSync(new URL('./fixtures/source-restoration-institutions.json',import.meta.url),'utf8')).fixtures as Fixture[];
for(const fixture of fixtures) {
  const source=localSourceCandidate({id:fixture.id,kind:'web_list',config:fixture.config} as SourceRow,undefined,'2026-10-10');
  test(`${fixture.id}: real news markup excludes navigation and preserves its original boundary`,()=>{
    assert.equal(source.config.dailyNews.migrationStatus,'verified');
    assert.doesNotThrow(()=>assertSupportedConfig(source.kind,source.config));
    const rows=fromHtml(fixture.listingHtml,source.config.url,source);
    assert.ok(rows.length>0);
    assert.deepEqual(rows.map(({url,title})=>({url,title})),fixture.expected);
    assert.ok(rows.every(row=>allowed(row.url,source)));
    assert.ok(allowed(fixture.readerUrl,source));
    assert.equal(fromHtml(fixture.offHostHtml,source.config.url,source).length,0);
    assert.equal(allowed('https://outside.example/news/20261010',source),false);
    assert.equal(allowed(fixture.readerUrl.replace('https:','http:'),source),false);
    assert.ok(rows.every(row=>!row.title.includes('var imgSrc')),'image script text is not a news title');
    assert.ok(fixture.bodyChars>=200,'at least one original-boundary article body was verified');
  });
  test(`${fixture.id}: stored original publish metadata yields the verified reader date`,()=>{
    const $=cheerio.load(fixture.dateHtml),d=source.config.detail;
    let date: Date|null=null;
    if(d.publishedAtSelector){const el=$(d.publishedAtSelector).first();date=parseLooseDate(el.attr('datetime')??el.attr('title')??el.text(),d.publishedAtUtcOffset);}
    else if(d.publishedAtRegex)date=parseLooseDate(new RegExp(d.publishedAtRegex).exec(fixture.dateHtml)?.[1],d.publishedAtUtcOffset);
    else date=parseLooseDate($('meta[property="article:published_time"],meta[name="pubdate"],meta[itemprop="datePublished"]').attr('content'))??parseLooseDate(jsonLdPublished($,fixture.dateHtml));
    assert.equal(date?.toISOString(),fixture.readerPublishedAt);
    if(d.publishedAtAuthoritative)assert.equal(d.publishedAtUtcOffset,fixture.id.includes('world-athletics')?'+00:00':'+08:00');
  });
}
