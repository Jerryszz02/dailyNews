import { defaultPreferences } from "../config/preferences.js";
import { newsSources } from "../config/sources.js";
import type { DailyNewsReport, RawNewsItem, UserPreferences } from "../types";
import { applyCandidateQualityGate, buildCurationFields } from "./curation.js";
import { clusterNews } from "./dedupe.js";
import { rankNews } from "./scoring.js";

export function buildDailyReport(
  rawItems: RawNewsItem[] = [],
  preferences: UserPreferences = defaultPreferences,
  now = new Date(),
): DailyNewsReport {
  const enabledSourceIds = new Set(newsSources.filter((source) => source.enabled).map((source) => source.source_id));
  const enabledItems = rawItems.filter((item) => enabledSourceIds.has(item.sourceId));
  const qualityGate = applyCandidateQualityGate(enabledItems);
  const clusters = clusterNews(qualityGate.accepted);
  const rankedItems = rankNews(clusters, preferences, now).filter((item) => item.trust.shouldShow);
  const curation = buildCurationFields(qualityGate.accepted, rankedItems, qualityGate.rejectionReasons, now);

  return {
    version: 2,
    generatedAt: now.toISOString(),
    ...curation,
    items: rankedItems,
    sourceCount: new Set(qualityGate.accepted.map((item) => item.sourceId)).size,
    notes: [
      "报告先过滤低质量候选，再按现实事件聚合多来源证据。",
      "今日必知不受个人偏好影响；偏好只调整兼容新闻流和分类深读顺序。",
      "事件只归入一个主板块，分类索引引用同一事件，不重复生成卡片。",
      "付费墙来源只使用公开标题、导语和元数据。",
    ],
  };
}
