import assert from "node:assert/strict";
import { test } from "node:test";
import { displaySourceName } from "@aihot/contracts/source-display";
import { shortSourceName } from "../apps/web/app/lib/format.ts";

test("the fourteen trial source labels share one public Chinese display mapping", () => {
  const cases: Record<string, string> = {
    "苹果新闻室 Apple Newsroom · Newsroom": "苹果新闻室 · 新闻",
    "BBC · World": "英国广播公司 · 国际",
    "中国新闻网 · 财经": "中国新闻网 · 财经",
    "中国新闻网 · 社会": "中国新闻网 · 社会",
    "CNBC · Business": "美国消费者新闻与商业频道 · 商业",
    "CNN · World": "美国有线电视新闻网 · 国际",
    "Deadline 影视行业新闻 · Film": "Deadline 影视行业新闻 · 电影",
    "美联储 · Press Releases": "美联储 · 新闻稿",
    "IT之家 · 科技": "IT之家 · 科技",
    "NBA官网 · NBA News": "NBA 官网 · NBA 新闻",
    "OpenAI · News": "OpenAI 官方动态 · 新闻",
    "量子位 · AI": "量子位 · 人工智能",
    "Wired · Science": "连线 · 科学",
    "新华网 · 要闻": "新华网 · 要闻",
  };
  for (const [stored, shown] of Object.entries(cases)) {
    assert.equal(displaySourceName(stored), shown, stored);
    assert.equal(displaySourceName(shown), shown, "display names remain stable on old ledger and web caches");
    assert.equal(shortSourceName(stored), shown, "web formatting uses the same mapping");
  }
  assert.equal(Object.keys(cases).length, 14);
});

test("legacy labels, brand names and unknown sources retain their fallback", () => {
  assert.equal(displaySourceName("BBC"), "英国广播公司");
  assert.equal(displaySourceName("OpenAI"), "OpenAI 官方动态");
  assert.equal(displaySourceName("未知实验室"), "未知实验室");
  assert.equal(displaySourceName("Unknown Wire · Unreviewed Desk"), "Unknown Wire · Unreviewed Desk");
  assert.equal(displaySourceName("Unknown Wire · World"), "Unknown Wire · World");
  assert.equal(shortSourceName("X：Ethan Mollick (@emollick)"), "Ethan Mollick");
});
