import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as cheerio from 'cheerio';
import { fromHtml, allowed, parseLooseDate, jsonLdPublished } from '../packages/backend/src/sources/web-list.ts';
import { assertSupportedConfig } from '../packages/backend/src/sources/config-keys.ts';
import { localSourceCandidate } from '../scripts/local-source-config.ts';
import type { SourceRow } from '../packages/backend/src/sources/types.ts';
interface Fixture {id:string;baseUrl:string;config:SourceRow['config'];legacyConfig:SourceRow['config'];listingHtml:string;expectedUrls:string[];date:{html:string;expected:string;readerUrl:string};summary?:{html:string;expected:string;readerUrl:string}}
const seeds=JSON.parse(readFileSync(new URL('../industry/sources.json',import.meta.url),'utf8')).sources as SourceRow[];
const fixtures=JSON.parse(readFileSync(new URL('./fixtures/source-restoration-china.json',import.meta.url),'utf8')).fixtures as Fixture[];
function source(f:Fixture):SourceRow {return localSourceCandidate({...seeds.find(seed=>seed.id===f.id)!,config:f.legacyConfig},{id:f.id,configOverrides:f.config},'2026-10-10T00:00:00.000Z');}
for(const f of fixtures){
 test(`${f.id}: observed list structure passes production admission and excludes non-news links`,()=>{
  const s=source(f);assert.doesNotThrow(()=>assertSupportedConfig(s.kind,s.config));
  const rows=fromHtml(f.listingHtml,f.baseUrl,s);assert.deepEqual(rows.map(r=>r.url),f.expectedUrls);assert.ok(rows.length>0);assert.ok(rows.every(r=>r.title.length>=4&&allowed(r.url,s)));
  assert.deepEqual(s.config.dailyNews.allowedHosts,f.legacyConfig.dailyNews.allowedHosts);assert.deepEqual(s.config.dailyNews.allowedPathPrefixes,f.legacyConfig.dailyNews.allowedPathPrefixes);
  const $=cheerio.load(f.listingHtml);$('a[href]').attr('href',f.baseUrl);assert.equal(fromHtml($.html(),f.baseUrl,s).length,0,'list/home navigation is not a story');
  $('a[href]').attr('href','https://example.org/news/unrelated');assert.equal(fromHtml($.html(),f.baseUrl,s).length,0,'off-host lookalike list cards are refused');assert.equal(allowed('https://example.org/news/unrelated',s),false);
 });
 if(f.summary)test(`${f.id}: explicit own-article summary scope excludes surrounding navigation`,()=>{const $=cheerio.load(f.summary!.html);const text=$(f.config.detail.summarySelector).first().text().replace(/\s+/g,' ').trim();assert.equal(text,f.summary!.expected);assert.ok(text.length>=50);assert.ok(!text.includes('直播 登录 热点推荐'));});
 test(`${f.id}: source publication evidence is parsed without borrowing a recommendation timestamp`,()=>{
  const d=f.config.detail??{};const $=cheerio.load(f.date.html);let date:Date|null=null;
  if(d.publishedAtSelector){const el=$(d.publishedAtSelector).first();date=parseLooseDate(el.attr('datetime')??el.attr('title')??el.text(),d.publishedAtUtcOffset);}
  if(!date&&d.publishedAtRegex){const text=new RegExp(d.publishedAtRegex).exec(f.date.html)?.[1];date=parseLooseDate(text,d.publishedAtUtcOffset,d.publishedAtUnit);}
  if(!date&&!d.publishedAtAuthoritative){date=parseLooseDate($('meta[property="article:published_time"]').attr('content'))??parseLooseDate(jsonLdPublished($,f.date.html));}
  assert.equal(date?.toISOString(),f.date.expected);
 });
}
test('historical Chinanews page-sidebar publication comments are not accepted as this article publication',()=>{
 const f=fixtures.find(f=>f.id.startsWith('dn-chinanews-'))!;
 const regex=new RegExp(f.config.detail.publishedAtRegex);
 assert.equal(regex.test('<!--[4,574,2] published at 2026-10-11 02:22:25 from #10 by system -->'),false);
});
