import type { Category, NewsCluster, RawNewsItem } from "../types";
import { normalizeText, tokenize, tokenOverlap } from "./text.js";

const categoryPriority: Category[] = [
  "sports",
  "ai",
  "technology",
  "finance",
  "policy",
  "china",
  "international",
  "science",
  "society",
  "entertainment",
];

const categoryKeywords: Record<Category, string[]> = {
  ai: ["ai", "artificial intelligence", "openai", "anthropic", "claude", "chatgpt", "大模型", "人工智能", "模型"],
  technology: ["technology", "tech", "startup", "software", "chip", "semiconductor", "科技", "芯片", "软件"],
  finance: ["market", "stock", "bank", "finance", "economy", "inflation", "财经", "金融", "市场", "经济"],
  international: ["world", "global", "war", "conflict", "diplomacy", "国际", "全球", "战争", "冲突"],
  china: ["china", "chinese", "beijing", "中国", "国内", "北京"],
  policy: ["policy", "regulation", "government", "election", "law", "政策", "监管", "政府", "选举"],
  society: ["society", "city", "education", "health", "社会", "教育", "健康", "城市"],
  sports: ["nba", "fifa", "fiba", "basketball", "football", "soccer", "sport", "体育", "篮球", "足球"],
  entertainment: ["film", "movie", "tv", "music", "entertainment", "电影", "影视", "娱乐", "音乐"],
  science: ["science", "research", "study", "space", "physics", "科学", "研究", "太空"],
};

export function clusterNews(items: RawNewsItem[]): NewsCluster[] {
  const clusters: NewsCluster[] = [];

  for (const item of items) {
    const duplicate = clusters.find((cluster) => isSameStory(cluster, item));
    if (!duplicate) {
      clusters.push({
        ...item,
        primaryCategory: item.primaryCategory ?? item.categories[0] ?? "society",
        sourceIds: [item.sourceId],
        sourceNames: [item.sourceName],
        relatedUrls: [item.url],
        primaryCategoryVotes: [item.primaryCategory ?? item.categories[0] ?? "society"],
      });
      continue;
    }

    duplicate.sourceIds = unique([...duplicate.sourceIds, item.sourceId]);
    duplicate.sourceNames = unique([...duplicate.sourceNames, item.sourceName]);
    duplicate.relatedUrls = unique([...duplicate.relatedUrls, item.url]);
    duplicate.categories = unique([...duplicate.categories, ...item.categories]);
    duplicate.primaryCategoryVotes = [...duplicate.primaryCategoryVotes, item.primaryCategory ?? item.categories[0] ?? "society"];
    duplicate.primaryCategory = choosePrimaryCategory(duplicate);
    duplicate.summary = chooseLongerSummary(duplicate.summary, item.summary);
    duplicate.publishedAt = earliestDate(duplicate.publishedAt, item.publishedAt);
  }

  return clusters.map((cluster) => ({ ...cluster, primaryCategory: choosePrimaryCategory(cluster) }));
}

function isSameStory(cluster: NewsCluster, item: RawNewsItem): boolean {
  if (canonicalUrl(cluster.url) === canonicalUrl(item.url)) {
    return true;
  }

  if (!withinEventWindow(cluster.publishedAt, item.publishedAt)) return false;
  if (!cluster.categories.some((category) => item.categories.includes(category))) return false;

  const titleOverlap = tokenOverlap(cluster.title, item.title);
  const summariesAreInformative = !isTemplateSummary(cluster.summary) && !isTemplateSummary(item.summary);
  const combinedOverlap = summariesAreInformative
    ? tokenOverlap(`${cluster.title} ${cluster.summary}`, `${item.title} ${item.summary}`)
    : 0;
  const sharedTerms = significantSharedTerms(cluster.title, item.title);
  const sharedContextTerms = summariesAreInformative
    ? significantSharedTerms(`${cluster.title} ${cluster.summary}`, `${item.title} ${item.summary}`)
    : 0;
  const cjkOverlap = longestCommonTextRatio(cluster.title, item.title);
  return (
    titleOverlap >= 0.52 ||
    combinedOverlap >= 0.7 ||
    cjkOverlap >= 0.28 ||
    (titleOverlap >= 0.34 && sharedTerms >= 3) ||
    (combinedOverlap >= 0.2 && sharedContextTerms >= 12)
  );
}

function isTemplateSummary(value: string): boolean {
  return (
    /已有新的公开信息，详细事实、影响范围和后续进展以来源页面为准/.test(value) ||
    /相关报道聚焦.+具体背景.+以原文披露为准/.test(value)
  );
}

function canonicalUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return value;
  }
}

function withinEventWindow(left?: string, right?: string): boolean {
  if (!left || !right) return true;
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) return true;
  return Math.abs(leftTime - rightTime) <= 120 * 60 * 60 * 1_000;
}

function significantSharedTerms(left: string, right: string): number {
  const ignored = new Set(["news", "latest", "update", "report", "报道", "消息", "最新", "宣布", "发布"]);
  const leftTerms = new Set(tokenize(left).filter((token) => token.length >= 2 && !ignored.has(token)));
  return new Set(tokenize(right).filter((token) => leftTerms.has(token) && !ignored.has(token))).size;
}

function longestCommonTextRatio(left: string, right: string): number {
  const normalizedLeft = normalizeText(left).replace(/\s+/g, "");
  const normalizedRight = normalizeText(right).replace(/\s+/g, "");
  if (!/[\u3400-\u9fff]/.test(`${normalizedLeft}${normalizedRight}`)) return 0;
  if (!normalizedLeft || !normalizedRight) return 0;

  const lengths = new Array(normalizedRight.length + 1).fill(0);
  let longest = 0;
  for (let leftIndex = 1; leftIndex <= normalizedLeft.length; leftIndex += 1) {
    for (let rightIndex = normalizedRight.length; rightIndex >= 1; rightIndex -= 1) {
      lengths[rightIndex] =
        normalizedLeft[leftIndex - 1] === normalizedRight[rightIndex - 1] ? lengths[rightIndex - 1] + 1 : 0;
      longest = Math.max(longest, lengths[rightIndex]);
    }
  }
  return longest / Math.min(normalizedLeft.length, normalizedRight.length);
}

function chooseLongerSummary(left: string, right: string): string {
  return right.length > left.length ? right : left;
}

function earliestDate(left?: string, right?: string): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return Date.parse(right) < Date.parse(left) ? right : left;
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function choosePrimaryCategory(item: NewsCluster): Category {
  const primaryVotes = unique(item.primaryCategoryVotes);
  if (primaryVotes.length === 1) return primaryVotes[0];

  const scores = new Map<Category, number>();
  for (const category of item.categories) {
    scores.set(category, 1);
  }

  for (const category of item.primaryCategoryVotes) {
    scores.set(category, (scores.get(category) ?? 0) + 8);
  }

  const text = normalizeText(`${item.title} ${item.summary}`);
  for (const category of item.categories) {
    const keywordHits = categoryKeywords[category].filter((keyword) => text.includes(normalizeText(keyword))).length;
    scores.set(category, (scores.get(category) ?? 0) + keywordHits * 3);
  }

  return [...scores.entries()].sort((left, right) => {
    const scoreDelta = right[1] - left[1];
    if (scoreDelta !== 0) return scoreDelta;
    return categoryPriority.indexOf(left[0]) - categoryPriority.indexOf(right[0]);
  })[0]?.[0] ?? item.categories[0] ?? "society";
}
