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
      const startedAt = itemStartedAt(item);
      clusters.push({
        ...item,
        primaryCategory: item.primaryCategory ?? item.categories[0] ?? "society",
        sourceIds: [item.sourceId],
        sourceNames: [item.sourceName],
        relatedUrls: [item.url],
        primaryCategoryVotes: [item.primaryCategory ?? item.categories[0] ?? "society"],
        startedAt,
        updatedAt: itemUpdatedAt(item),
      });
      continue;
    }

    duplicate.sourceIds = unique([...duplicate.sourceIds, item.sourceId]);
    duplicate.sourceNames = unique([...duplicate.sourceNames, item.sourceName]);
    duplicate.relatedUrls = unique([...duplicate.relatedUrls, item.url]);
    duplicate.categories = unique([...duplicate.categories, ...item.categories]);
    duplicate.primaryCategoryVotes = [...duplicate.primaryCategoryVotes, item.primaryCategory ?? item.categories[0] ?? "society"];
    duplicate.primaryCategory = choosePrimaryCategory(duplicate);
    duplicate.summary = chooseSummary(duplicate, item);
    duplicate.publishedAt = earliestDate(duplicate.publishedAt, item.publishedAt);
    duplicate.startedAt = earliestDate(duplicate.startedAt, itemStartedAt(item)) ?? duplicate.startedAt;
    duplicate.updatedAt = latestDate(duplicate.updatedAt, itemUpdatedAt(item));
    duplicate.translationStatus = preferredTranslationStatus(duplicate.translationStatus, item.translationStatus);
    duplicate.summaryStatus =
      duplicate.summaryStatus === "complete" || item.summaryStatus === "complete"
        ? "complete"
        : duplicate.summaryStatus === "pending" || item.summaryStatus === "pending"
          ? "pending"
          : undefined;
    duplicate.timeStatus =
      duplicate.timeStatus === "verified" || item.timeStatus === "verified"
        ? "verified"
        : duplicate.timeStatus === "estimated" || item.timeStatus === "estimated"
          ? "estimated"
          : undefined;
    duplicate.qualityStatus =
      duplicate.qualityStatus === "display_ready" || item.qualityStatus === "display_ready"
        ? "display_ready"
        : duplicate.qualityStatus === "degraded" || item.qualityStatus === "degraded"
          ? "degraded"
          : undefined;
    duplicate.rejectionReasons = unique([...(duplicate.rejectionReasons ?? []), ...(item.rejectionReasons ?? [])]);
  }

  return clusters.map((cluster) => ({ ...cluster, primaryCategory: choosePrimaryCategory(cluster) }));
}

function isSameStory(cluster: NewsCluster, item: RawNewsItem): boolean {
  if (canonicalUrl(cluster.url) === canonicalUrl(item.url)) {
    return true;
  }

  if (!withinEventWindow(cluster.updatedAt, itemUpdatedAt(item))) return false;
  if (cluster.primaryCategory !== (item.primaryCategory ?? item.categories[0] ?? "society")) return false;

  const titleOverlap = tokenOverlap(cluster.title, item.title);
  const combinedOverlap = tokenOverlap(`${cluster.title} ${cluster.summary}`, `${item.title} ${item.summary}`);
  return titleOverlap >= 0.8 && combinedOverlap >= 0.85;
}

function canonicalUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_.+|fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    url.hostname = url.hostname.toLowerCase();
    return url.toString().replace(/\/$/, "");
  } catch {
    return value;
  }
}

function withinEventWindow(left: string, right: string): boolean {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) && Math.abs(leftTime - rightTime) <= 24 * 60 * 60 * 1_000;
}

function chooseSummary(left: NewsCluster, right: RawNewsItem): string {
  if (left.summaryStatus === "complete" && right.summaryStatus === "pending") return left.summary;
  if (left.summaryStatus === "pending" && right.summaryStatus === "complete") return right.summary;
  return right.summary.length > left.summary.length ? right.summary : left.summary;
}

function earliestDate(left?: string, right?: string): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return Date.parse(right) < Date.parse(left) ? right : left;
}

function latestDate(left: string, right: string): string {
  return Date.parse(right) > Date.parse(left) ? right : left;
}

function itemStartedAt(item: RawNewsItem): string {
  return earliestValidDate([item.publishedAt, item.discoveredAt, item.extractedAt]);
}

function itemUpdatedAt(item: RawNewsItem): string {
  return firstValidDate([item.updatedAt, item.publishedAt, item.discoveredAt, item.extractedAt]);
}

function earliestValidDate(values: Array<string | undefined>): string {
  const timestamps = values.map((value) => Date.parse(value ?? "")).filter(Number.isFinite);
  return timestamps.length > 0
    ? new Date(Math.min(...timestamps)).toISOString()
    : "1970-01-01T00:00:00.000Z";
}

function firstValidDate(values: Array<string | undefined>): string {
  const value = values.find((candidate) => Number.isFinite(Date.parse(candidate ?? "")));
  return new Date(Date.parse(value ?? "1970-01-01T00:00:00.000Z")).toISOString();
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function preferredTranslationStatus(
  left?: RawNewsItem["translationStatus"],
  right?: RawNewsItem["translationStatus"],
): RawNewsItem["translationStatus"] {
  const priority: NonNullable<RawNewsItem["translationStatus"]>[] = ["translated", "original", "pending"];
  return priority.find((status) => status === left || status === right);
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
