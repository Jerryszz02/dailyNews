import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fromHtml, allowed, parseLooseDate } from '../packages/backend/src/sources/web-list.ts';
import type { SourceRow } from '../packages/backend/src/sources/types.ts';
const seeds=JSON.parse(readFileSync(new URL('../industry/sources.json',import.meta.url),'utf8')).sources as SourceRow[];
const overrides=JSON.parse(readFileSync(new URL('../reference/local/source-adapter-overrides.json',import.meta.url),'utf8')).sources as Array<{id:string;configOverrides:SourceRow['config']}>;
function source(legacy:string): SourceRow {const seed=seeds.find(s=>s.config.dailyNews.legacySourceId===legacy)!;const patch=overrides.find(s=>s.id===seed.id)!.configOverrides;return {...seed,config:{...seed.config,...patch,dailyNews:{...seed.config.dailyNews,...patch.dailyNews}}};}
// Minimal shapes observed on the public pages, 2026-10-10. Navigation and off-host bait must be excluded.
const fixtures={
  anthropic:'<a class="PublicationList-module__listItem" href="/news/test"><time>Oct 8, 2026</time><span class="module__title">Policy announcement</span></a><a href="/about">About us</a><a class="PublicationList-module__listItem" href="https://example.com/news/other"><span class="module__title">Other publisher</span></a>',
  qwen:'<main><article class="post-entry"><header class="entry-header"><h2>Official release</h2></header><footer class="entry-footer"><span title="2025-09-23 04:00:00 +0800 +0800">September 23, 2025</span></footer><a class="entry-link" href="/blog/test/"></a></article></main><a href="https://qwen.ai/research">New site</a>',
  'gov-cn':'<a href="https://www.gov.cn/zhengce/content/202610/content_123.htm">国务院政策发布</a><a href="https://www.gov.cn/zhengce/">政策首页</a><a href="https://www.gov.cn/yaowen/liebiao/202610/content_234.htm">新闻导航不属于政策列表</a>',
  cas:'<a href="//www.cas.cn/../../syky/202610/t20261010_123.shtml">新的科研成果</a><a href="//www.cas.cn/../../syky/">科研栏目</a><a href="//www.cas.cn/djcx/202610/t20261010_234.shtml">党建导航</a>',
};
for(const [legacy,html] of Object.entries(fixtures))test(`${legacy}: specific list selector preserves original host boundary`,()=>{const s=source(legacy);const rows=fromHtml(html,s.config.url,s);assert.equal(rows.length,1);assert.ok(rows[0]!.title.length>4);assert.ok(allowed(rows[0]!.url,s));assert.deepEqual(s.config.dailyNews.allowedHosts,seeds.find(seed=>seed.id===s.id)!.config.dailyNews.allowedHosts);assert.equal(allowed('https://example.com/news/test',s),false);});
test('official timestamps use the published field and Chinese source offset',()=>{
 const gov=source('gov-cn').config.detail;
 const date=new RegExp(gov.publishedAtRegex).exec('<div style="display:none">2026-10-08 17:00</div>')?.[1];
 assert.equal(parseLooseDate(date,gov.publishedAtUtcOffset)?.toISOString(),'2026-10-08T09:00:00.000Z');
 const cas=source('cas').config.detail;
 const casDate=new RegExp(cas.publishedAtRegex).exec('<meta name="PubDate" content="2026-10-10 21:46">')?.[1];
 assert.equal(parseLooseDate(casDate,cas.publishedAtUtcOffset)?.toISOString(),'2026-10-10T13:46:00.000Z');
});
