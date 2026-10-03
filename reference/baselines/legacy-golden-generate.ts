/** Regenerate only from frozen Daily News 8519831714b0d6c8183336c81e8190dceddf7843 source. */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { newsSources } from "../../src/config/sources.ts";
import { scoreNewsItem } from "../../src/lib/scoring.ts";
import { assessTrust } from "../../src/lib/trust.ts";
import { buildCurationFields } from "../../src/lib/curation.ts";
import type { Category, NewsCluster, RawNewsItem } from "../../src/types.ts";

const now = new Date("2026-10-03T08:00:00.000Z");
const manifest = JSON.parse(readFileSync(new URL("./daily-news-v1.json", import.meta.url), "utf8")) as {
  commit: string; files: Array<{ path: string; sha256: string }>;
};
if (manifest.commit !== "8519831714b0d6c8183336c81e8190dceddf7843") throw new Error("Wrong legacy baseline");
for (const path of ["src/lib/curation.ts", "src/lib/scoring.ts", "src/lib/trust.ts", "src/lib/dedupe.ts", "src/lib/text.ts", "src/config/sources.ts", "src/config/expandedSources.ts", "src/config/xAccounts.ts"]) {
  const expected = manifest.files.find((file) => file.path === path)?.sha256;
  const actual = createHash("sha256").update(readFileSync(new URL(`../../${path}`, import.meta.url))).digest("hex");
  if (actual !== expected) throw new Error(`Legacy source changed: ${path}`);
}
const sourceById = new Map(newsSources.map((source) => [source.source_id, source]));
type Input = {
  factId: string; primaryCategory: Category; evidence: Array<{
    articleId: string; legacySourceId: string; url: string; title: string; summary: string;
    primaryCategory: Category; categories?: Category[]; publishedAt?: string; updatedAt?: string;
    sourceCredibility: number; mediaType?: string; signalRole?: string; mayHavePaywall?: boolean;
  }>;
};
function article(factId: string, beat: Category, sourceId: string, title: string, ageHours: number | null, id = factId): Input["evidence"][number] {
  const source = sourceById.get(sourceId)!;
  return {
    articleId: id, legacySourceId: sourceId,
    url: `https://${sourceId === "x-shams" ? "x.com" : sourceId === "ap" ? "apnews.com" : sourceId === "aljazeera" ? "aljazeera.com" : sourceId === "nba" ? "nba.com" : sourceId === "fifa" ? "fifa.com" : sourceId === "caixin" ? "caixin.com" : "news.cn"}/${id}`,
    title, summary: `${title}。有关部门披露具体范围、阶段安排、实际影响和后续进展，报道提供必要背景与事实细节。`,
    primaryCategory: beat, categories: [beat],
    ...(ageHours === null ? {} : { publishedAt: new Date(now.getTime() - ageHours * 3_600_000).toISOString() }),
    sourceCredibility: source.credibility, mediaType: source.mediaType,
    signalRole: source.signalRole, mayHavePaywall: source.mayHavePaywall,
  };
}
const inputs: Input[] = [
  { factId: "technology", primaryCategory: "technology", evidence: [article("technology", "technology", "xinhua", "全国重大科技芯片突破首次公布", 0.5)] },
  { factId: "finance", primaryCategory: "finance", evidence: [article("finance", "finance", "caixin", "央行发布利率新规并正式生效", 6)] },
  { factId: "international", primaryCategory: "international", evidence: [article("international", "international", "aljazeera", "全球冲突升级后宣布紧急停火", 12)] },
  { factId: "china", primaryCategory: "china", evidence: [article("china", "china", "xinhua", "全国重要公共服务政策正式实施", 24)] },
  { factId: "policy", primaryCategory: "policy", evidence: [article("policy", "policy", "xinhua", "监管部门发布全国新规明确执行时间", 1)] },
  { factId: "society", primaryCategory: "society", evidence: [article("society", "society", "ap", "社区活动公布阶段成果", 25)] },
  { factId: "science", primaryCategory: "science", evidence: [article("science", "science", "xinhua", "全国空间研究首次取得突破", 48)] },
  { factId: "sports", primaryCategory: "sports", evidence: [article("sports", "sports", "nba", "球队比赛前景排名与观点盘点", 2)] },
  { factId: "entertainment", primaryCategory: "entertainment", evidence: [article("entertainment", "entertainment", "xinhua", "地方电影节公布节目单", null)] },
  { factId: "lead", primaryCategory: "sports", evidence: [article("lead", "sports", "x-shams", "消息人士称冠军球队重大交易接近达成", 0.25)] },
  { factId: "same-host", primaryCategory: "finance", evidence: [
    article("same-host", "finance", "xinhua", "全国金融政策发布并明确实施时间", 0.5, "same-host-a"),
    article("same-host", "finance", "xinhua", "全国金融政策发布并明确实施时间", 0.25, "same-host-b"),
  ] },
  { factId: "multi-host", primaryCategory: "international", evidence: [
    article("multi-host", "international", "aljazeera", "地区冲突停火协议正式签署", 3, "multi-host-a"),
    article("multi-host", "international", "ap", "地区冲突停火协议正式签署", 1, "multi-host-b"),
  ] },
  { factId: "old-impact", primaryCategory: "policy", evidence: [article("old-impact", "policy", "xinhua", "全国重大监管新规正式生效", 72)] },
];
for (let index = 0; index < 12; index++) {
  inputs.push({ factId: `policy-cap-${index}`, primaryCategory: "policy", evidence: [
    article(`policy-cap-${index}`, "policy", "xinhua", `全国重大政策监管新规第${index}项正式生效`, 3),
  ] });
}
for (let index = 0; index < 34; index++) {
  inputs.push({ factId: `finance-cap-${index}`, primaryCategory: "finance", evidence: [
    article(`finance-cap-${index}`, "finance", "caixin", `央行金融市场第${index}项调整公布`, 3),
  ] });
}
for (let index = 0; index < 11; index++) {
  inputs.push({ factId: `lead-cap-${index}`, primaryCategory: "sports", evidence: [
    article(`lead-cap-${index}`, "sports", "x-shams", `消息人士称第${index}笔冠军球队重大交易接近达成`, 0.25),
  ] });
}

const rawItems: RawNewsItem[] = inputs.flatMap((input) => input.evidence.map((entry) => ({
  id: entry.articleId, title: entry.title, url: entry.url, sourceId: entry.legacySourceId,
  sourceName: sourceById.get(entry.legacySourceId)!.name, language: "zh-CN", region: "china",
  categories: entry.categories ?? [entry.primaryCategory], primaryCategory: entry.primaryCategory,
  summary: entry.summary, publishedAt: entry.publishedAt, updatedAt: entry.updatedAt,
  extractedAt: now.toISOString(), mayHavePaywall: entry.mayHavePaywall,
})));
const clusters: NewsCluster[] = inputs.map((input) => {
  const evidence = rawItems.filter((item) => input.evidence.some((entry) => entry.articleId === item.id));
  const first = evidence[0]!;
  const publishedAt = evidence.map((item) => item.publishedAt).filter((value): value is string => Boolean(value)).sort()[0];
  const updatedAt = evidence.map((item) => item.updatedAt ?? item.publishedAt).filter((value): value is string => Boolean(value)).sort().at(-1) ?? "1970-01-01T00:00:00.000Z";
  return { ...first, primaryCategory: input.primaryCategory, summary: evidence.reduce((longest, item) => item.summary.length > longest.length ? item.summary : longest, first.summary),
    publishedAt, sourceIds: [...new Set(evidence.map((item) => item.sourceId))], sourceNames: [...new Set(evidence.map((item) => item.sourceName))],
    relatedUrls: evidence.map((item) => item.url), primaryCategoryVotes: evidence.map(() => input.primaryCategory),
    startedAt: publishedAt ?? now.toISOString(), updatedAt };
});
// Keep event input order fixed, independent of compatibility preference sorting.
const ranked = clusters.map((cluster) => ({ ...cluster,
  score_breakdown: scoreNewsItem(cluster, { topicWeights: {}, preferredSources: {}, blockedKeywords: [], boostedKeywords: [] }, now),
  trust: assessTrust(cluster),
}));
const result = buildCurationFields(rawItems, ranked, {}, now);
const byId = new Map(result.stories.map((story) => [story.itemId, story]));
const expected = {
  facts: inputs.map((input) => {
    const story = byId.get(input.evidence[0]!.articleId)!;
    return { factId: input.factId, importance: story.importance, tier: story.tier, status: story.status };
  }),
  topIds: result.topStories.map((story) => inputs.find((input) => input.evidence[0]!.articleId === story.itemId)!.factId),
  importantIds: result.importantStories.map((story) => inputs.find((input) => input.evidence[0]!.articleId === story.itemId)!.factId),
  watchlistIds: result.watchlist.map((story) => inputs.find((input) => input.evidence[0]!.articleId === story.itemId)!.factId),
};
writeFileSync(new URL("./legacy-golden.json", import.meta.url), JSON.stringify({ baseline: "8519831714b0d6c8183336c81e8190dceddf7843", now: now.toISOString(), inputs, expected }, null, 2) + "\n");
