import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { readable, videoTranscript } from "@aihot/backend/content/extract";
import { trimTrailingChrome } from "@aihot/backend/content/sanitize";
import { copyEvidenceIssues } from "@aihot/backend/editorial/evidence";

const url = "https://edition.cnn.com/2026/10/03/world/video/main-clip";
const sidebar = "Other case: the interviewee says nobody responded quickly. ".repeat(20);
const page = (metadata: unknown) => `<html><head><script type="application/ld+json">${JSON.stringify(metadata)}</script></head><body><h1>Own video title</h1><p>Own introduction.</p><aside>${sidebar}</aside><main><h2>Recommended videos</h2><p>${sidebar}</p></main></body></html>`;

test("a video without its own transcript cannot promote recommendations to a full body", () => {
  const html = page({ "@type": "VideoObject", url, description: "Own introduction." });
  assert.equal(readable(html, url), null);
  assert.equal(videoTranscript(html, url).video, true);
  assert.equal(readable(page({ "@type": "VideoObject", url: "https://edition.cnn.com/video/other", transcript: sidebar }), url), null);
});

test("only the page's identified transcript is extracted, never the related clip", () => {
  const transcript = "This interview discusses the main video's own reporting and evidence. ".repeat(8);
  const html = page([{ "@type": "VideoObject", url: "https://edition.cnn.com/video/other", transcript: sidebar }, { "@type": "VideoObject", mainEntityOfPage: { "@id": url }, transcript }]);
  const body = readable(html, url)!;
  assert.equal(body.text, transcript.trim());
  assert.ok(!body.text.includes("Other case"));
});

test("ordinary articles still extract substantive text and discard sidebar material", () => {
  const text = "The main article reports its own verified development and supporting evidence. ".repeat(12);
  const body = readable(`<html><head><title>Main report</title></head><body><article><h1>Main report</h1><p>${text}</p></article><aside><p>${sidebar}</p></aside></body></html>`, "https://example.com/report");
  assert.ok(body?.text.includes("verified development"));
  assert.ok(!body?.text.includes("Other case"));
});

const cases = [
  [{ title: "Travel volume is expected to exceed 300 million trips", text: "" }, "出行量突破3亿人次", "prediction-qualifier", "预计出行量突破3亿人次"],
  [{ title: "A proposed management arrangement", text: "" }, "公司确定管理安排", "proposal-qualifier", "据报道，公司拟调整管理安排"],
  [{ title: "Interviewee felt a lack of urgency", text: "" }, "案件处理迟缓", "subjective-attribution", "受访者称，他感到处理缺乏紧迫感"],
  [{ title: "Investigation reopened", text: "" }, "案件重新开庭", "investigation-not-hearing", "案件调查重新启动"],
  [{ title: "AWS post", text: "The post is more than 3,000 words." }, "文章有3000多字", "word-not-character-unit", "文章有3000多词"],
  [{ title: "Mountain bike World Series", text: "A World Cup champion was interviewed." }, "车手参加世界杯", "competition-proper-name", "车手参加世界系列赛"],
  [{ title: "Employee removed from training and given another role", text: "" }, "员工被航空公司开除", "reassignment-not-dismissal", "员工被调任至另一岗位"],
  [{ title: "29,000 jobs", text: "" }, "新增29000个非农岗位", "unsupported-employment-qualifier", "CNN报道新增29000个岗位"],
] as const;
for (const [source, bad, issue, good] of cases) test(`known quality regression: ${issue}`, () => {
  assert.ok(copyEvidenceIssues(source, bad).includes(issue));
  assert.deepEqual(copyEvidenceIssues(source, good), []);
});

test("an unrelated forecast does not require every output to say expected", () => {
  const source = { title: "Company launched a product", text: "Revenue is expected to reach 300 million. The product costs 99 dollars." };
  assert.deepEqual(copyEvidenceIssues(source, "公司推出产品，售价99美元。"), []);
  assert.deepEqual(copyEvidenceIssues({ title: "Expected revenue reaches 300 million by 2026", text: "" }, "公司在2026年发布产品"), []);
  assert.deepEqual(copyEvidenceIssues({ title: "Investigators reopened an investigation", text: "A separate court hearing was also reopened." }, "另一起案件的庭审重启"), []);
});


test("an ordinary news article with an embedded video still extracts its own article text", () => {
  const articleUrl = "https://example.com/news/report";
  const text = "The written article reports its own substantive evidence rather than a video transcript. ".repeat(10);
  const html = `<html><head><title>Written article</title><script type="application/ld+json">${JSON.stringify([{ "@type": "NewsArticle", url: articleUrl }, { "@type": "VideoObject", url: articleUrl }])}</script></head><body><article><p>${text}</p></article></body></html>`;
  assert.equal(videoTranscript(html, articleUrl).video, false);
  assert.ok(readable(html, articleUrl)?.text.includes("written article"));
});


test("recommendation trimming preserves real prose, ordinary citation lists and substantive lists", () => {
  for (const html of [
    '<p>The article discusses Related Stories as an editorial technique.</p>',
    '<p>References</p><ul><li><a href="https://example.org/ref">Source paper</a></li></ul>',
    '<p>Related Stories</p><ul><li>This item explains why <a href="https://example.org/ref">the cited paper</a> is relevant.</li></ul>',
    '<p>Related Stories</p><p>This is a substantive section, not a navigation list.</p>',
  ]) assert.equal(trimTrailingChrome(html), html);
});

test('article layout classes mentioning a sidebar retain the main text but remove real sidebars', () => {
  const text = 'The original article reports new research and explains the results in detail. '.repeat(8);
  for (const bodyClass of ['no-sidebar', 'no-sidebars', '']) {
    const html = `<html><head><title>Research article</title></head><body class="${bodyClass}"><main><h1>Research article</h1><div class="t-content__with-sidebar"><div class="t-content__beside-sidebar"><p>${text}</p></div><div class="o-sidebar"><p>Unrelated recommendations ${'sidebar junk '.repeat(40)}</p></div></div><aside class="post__sidebar">More unrelated links</aside></main></body></html>`;
    const got = readable(html, 'https://example.com/news/research');
    assert.ok(got?.text.includes('original article reports new research'));
    assert.ok(!got?.text.includes('Unrelated recommendations'));
    assert.ok(!got?.text.includes('sidebar junk'));
  }
});

// Reduced public HTML structures observed on Variety and Yahoo Sports; no browser script runs.
const restoredFixtures = JSON.parse(readFileSync(new URL('./fixtures/article-body-restoration.json', import.meta.url), 'utf8')) as {yahoo:{url:string;html:string};variety:{url:string;html:string};redstar:{url:string;html:string}};
test('Variety article-with-sidebar preserves actual article paragraphs and drops the real popular sidebar', () => {
  const f = restoredFixtures.variety;
  const got = readable(f.html, f.url);
  assert.ok(got?.text.includes('generated $12.6 million'));
  assert.ok(!got?.text.includes('Wrong sidebar story'));
});
test('Yahoo restores only its own exact static React body insertion without exposing other hidden streams', () => {
  const f = restoredFixtures.yahoo;
  const got = readable(f.html, f.url);
  assert.ok(got?.text.includes('Following a preseason loss to the Brooklyn Nets'));
  assert.ok(!got?.text.includes('Unrelated hidden stream'));
});
for (const [name, change] of [
  ['missing insertion', (h:string) => h.replace('$RC("B:2","S:2")', '')],
  ['duplicate insertion', (h:string) => h.replace('$RC("B:2","S:2")', '$RC("B:2","S:2")</script><script>$RC("B:2","S:2")')],
  ['ambiguous stream pairing', (h:string) => h.replace('$RC("B:9","S:9")', '$RC("B:9","S:2")')],
  ['ambiguous boundary pairing', (h:string) => h.replace('$RC("B:9","S:9")', '$RC("B:2","S:9")')],
  ['duplicate stream body', (h:string) => h.replace('</body>', '<div hidden id="S:3"><div class="content-body"><p>Another article body</p></div></div></body>')],
  ['duplicate boundary', (h:string) => h.replace('</body>', '<template id="B:2"></template></body>')],
  ['boundary outside own article', (h:string) => h.replace('<template id="B:2"></template></article>', '</article><template id="B:2"></template>')],
  ['canonical mismatch', (h:string) => h.replace('rel="canonical" href="https://sports.yahoo.com/', 'rel="canonical" href="https://example.com/')],
  ['metadata of another article', (h:string) => h.replace('"mainEntityOfPage":"https://sports.yahoo.com/', '"mainEntityOfPage":"https://example.com/')],
  ['explicit inaccessible article', (h:string) => h.replace('"@type":"NewsArticle"', '"isAccessibleForFree":false,"@type":"NewsArticle"')],
] as const) test(`Yahoo refuses ${name} instead of promoting its header or another story`, () => {
  const f = restoredFixtures.yahoo;
  assert.equal(readable(change(f.html), f.url), null);
});
test('Yahoo restoration does not run for a different host or path', () => {
  const f = restoredFixtures.yahoo;
  for(const address of ['https://example.com/nba/article/test.html', 'https://sports.yahoo.com/news/test.html']) {
    assert.ok(!readable(f.html, address)?.text.includes('Following a preseason loss to the Brooklyn Nets'));
  }
});

test('Red Star restores its observed article image-loading wrapper, preserving unrelated hidden content', () => {
  const f = restoredFixtures.redstar;
  const got = readable(f.html, f.url);
  assert.ok(got?.text.includes('单天线射电望远镜'));
  assert.ok(!got?.text.includes('Unrelated hidden content'));
});
for(const [name, change] of [
  ['missing known loading script', (h:string) => h.replace('/staticfile/js/base-hongxing.js', '/unknown.js')],
  ['another script host', (h:string) => h.replace('staticfilecdn.cdsb.com', 'example.com')],
  ['duplicate article body', (h:string) => h.replace('</section>', '<article class="cd-article_content"><p>Another body</p></article></section>')],
  ['missing publication date', (h:string) => h.replace('id="article-time"', 'id="other-time"')],
  ['mismatched article title', (h:string) => h.replace('<title>', '<title>Other article: ')],
  ['other hiding styles', (h:string) => h.replace('display: none;', 'display: none; visibility: hidden;')],
] as const) test(`Red Star refuses ${name}`, () => {
  const f = restoredFixtures.redstar;
  assert.equal(readable(change(f.html), f.url), null);
});
test('Red Star does not unhide an article for an unobserved host or path', () => {
  const f = restoredFixtures.redstar;
  for(const address of ['https://example.com/micropub/Articles/202610/test.html','https://static.cdsb.com/other/test.html'])
    assert.ok(!readable(f.html,address)?.text.includes('单天线射电望远镜'));
});
