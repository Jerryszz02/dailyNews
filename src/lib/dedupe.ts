import type { Category, NewsCluster, RawNewsItem } from "../types";
import { normalizeText, tokenOverlap } from "./text.js";

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
  if (cluster.url === item.url) {
    return true;
  }

  const titleOverlap = tokenOverlap(cluster.title, item.title);
  const combinedOverlap = tokenOverlap(`${cluster.title} ${cluster.summary}`, `${item.title} ${item.summary}`);
  return titleOverlap >= 0.58 || combinedOverlap >= 0.72;
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
