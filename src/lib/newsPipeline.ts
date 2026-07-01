import { defaultPreferences } from "../config/preferences";
import { newsSources } from "../config/sources";
import type { DailyNewsReport, RawNewsItem, UserPreferences } from "../types";
import { clusterNews } from "./dedupe";
import { rankNews } from "./scoring";

export function buildDailyReport(
  rawItems: RawNewsItem[] = [],
  preferences: UserPreferences = defaultPreferences,
  now = new Date(),
): DailyNewsReport {
  const enabledSourceIds = new Set(newsSources.filter((source) => source.enabled).map((source) => source.source_id));
  const filteredItems = rawItems.filter((item) => enabledSourceIds.has(item.sourceId));
  const clusters = clusterNews(filteredItems);
  const rankedItems = rankNews(clusters, preferences, now).filter((item) => item.trust.shouldShow);

  return {
    generatedAt: now.toISOString(),
    items: rankedItems,
    sourceCount: new Set(filteredItems.map((item) => item.sourceId)).size,
    notes: [
      "排序由公共重要性、用户偏好、时效性、来源可信度和内容质量共同决定。",
      "可信度分级独立于排序，低可信内容会保留标记，极低质量内容不展示。",
      "每条新闻只归入一个最相关板块，辅助标签仅用于解释。",
      "付费墙来源只使用公开标题、导语和元数据。",
    ],
  };
}
