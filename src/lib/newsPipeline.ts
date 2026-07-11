import { defaultPreferences } from "../config/preferences.js";
import { newsSources } from "../config/sources.js";
import type { Category, DailyNewsReport, NewsCluster, RawNewsItem, UserPreferences } from "../types";
import { applyCandidateQualityGate, buildCurationFields } from "./curation.js";
import { clusterNews } from "./dedupe.js";
import { rankNews } from "./scoring.js";
import { coverageBeatOrder } from "./sourceCoverage.js";
import { assessTrust } from "./trust.js";

export function buildDailyReport(
  rawItems: RawNewsItem[] = [],
  preferences: UserPreferences = defaultPreferences,
  now = new Date(),
): DailyNewsReport {
  const enabledSourceIds = new Set(newsSources.filter((source) => source.enabled).map((source) => source.source_id));
  const enabledItems = rawItems.filter((item) => enabledSourceIds.has(item.sourceId));
  const qualityGate = applyCandidateQualityGate(enabledItems);
  const trustedClusters = clusterNews(qualityGate.accepted).filter((cluster) => assessTrust(cluster).shouldShow);
  const clusters = allocateClusterPrimaryCategories(trustedClusters);
  const rankedItems = rankNews(clusters, preferences, now);
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

export function allocateClusterPrimaryCategories(clusters: NewsCluster[]): NewsCluster[] {
  const allocated = clusters.map((cluster) => ({ ...cluster }));
  const candidateIndexesByBeat = new Map(
    coverageBeatOrder.map((beat) => [
      beat,
      allocated
        .map((cluster, index) => ({ cluster, index }))
        .filter(({ cluster }) => cluster.primaryCategoryVotes.includes(beat))
        .sort((left, right) => {
          const leftKeepsPrimary = left.cluster.primaryCategory === beat ? 1 : 0;
          const rightKeepsPrimary = right.cluster.primaryCategory === beat ? 1 : 0;
          if (leftKeepsPrimary !== rightKeepsPrimary) return rightKeepsPrimary - leftKeepsPrimary;
          return Date.parse(right.cluster.publishedAt ?? "") - Date.parse(left.cluster.publishedAt ?? "");
        })
        .map(({ index }) => index),
    ]),
  );
  const beatByClusterIndex = new Map<number, Category>();
  const beatsByScarcity = [...coverageBeatOrder].sort(
    (left, right) => (candidateIndexesByBeat.get(left)?.length ?? 0) - (candidateIndexesByBeat.get(right)?.length ?? 0),
  );

  const assignBeat = (beat: Category, seen: Set<number>): boolean => {
    for (const index of candidateIndexesByBeat.get(beat) ?? []) {
      if (seen.has(index)) continue;
      seen.add(index);
      const previousBeat = beatByClusterIndex.get(index);
      if (!previousBeat || assignBeat(previousBeat, seen)) {
        beatByClusterIndex.set(index, beat);
        return true;
      }
    }
    return false;
  };

  for (const beat of beatsByScarcity) assignBeat(beat, new Set());
  for (const [index, beat] of beatByClusterIndex) allocated[index].primaryCategory = beat;

  const matchedBeats = new Set(beatByClusterIndex.values());
  const unmatchedBeats = coverageBeatOrder.filter((beat) => !matchedBeats.has(beat) && (candidateIndexesByBeat.get(beat)?.length ?? 0) > 0);
  if (unmatchedBeats.length > 0) {
    console.warn(
      `Category allocation incomplete: ${JSON.stringify({
        unmatchedBeats,
        candidateCounts: Object.fromEntries(coverageBeatOrder.map((beat) => [beat, candidateIndexesByBeat.get(beat)?.length ?? 0])),
      })}`,
    );
  }

  return allocated;
}
