import type { NewsCluster, RawNewsItem } from "../types";
import { tokenOverlap } from "./text";

export function clusterNews(items: RawNewsItem[]): NewsCluster[] {
  const clusters: NewsCluster[] = [];

  for (const item of items) {
    const duplicate = clusters.find((cluster) => isSameStory(cluster, item));
    if (!duplicate) {
      clusters.push({
        ...item,
        sourceIds: [item.sourceId],
        sourceNames: [item.sourceName],
        relatedUrls: [item.url],
      });
      continue;
    }

    duplicate.sourceIds = unique([...duplicate.sourceIds, item.sourceId]);
    duplicate.sourceNames = unique([...duplicate.sourceNames, item.sourceName]);
    duplicate.relatedUrls = unique([...duplicate.relatedUrls, item.url]);
    duplicate.categories = unique([...duplicate.categories, ...item.categories]);
    duplicate.summary = chooseLongerSummary(duplicate.summary, item.summary);
    duplicate.publishedAt = earliestDate(duplicate.publishedAt, item.publishedAt);
  }

  return clusters;
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
