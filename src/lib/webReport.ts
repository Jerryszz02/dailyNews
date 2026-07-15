import type {
  DailyNewsReport,
  RankedNewsItem,
  StoryCard,
  WebDailyNewsReport,
  WebReportRankingMetadata,
} from "../types";

export function compactDailyNewsReport(report: DailyNewsReport): WebDailyNewsReport {
  const itemById = new Map(report.items.map((item) => [item.id, item]));
  const rankingMetadata = Object.fromEntries(
    report.stories.map((story) => {
      const item = itemById.get(story.itemId);
      return [
        story.itemId,
        {
          categories: item?.categories ?? [story.primaryBeat],
          mayHavePaywall: item?.mayHavePaywall,
        } satisfies WebReportRankingMetadata,
      ];
    }),
  );
  const { items: _items, topStories, importantStories, watchlist, ...shared } = report;

  return {
    ...shared,
    webView: 1,
    topStoryIds: topStories.map((story) => story.id),
    importantStoryIds: importantStories.map((story) => story.id),
    watchlistIds: watchlist.map((story) => story.id),
    rankingMetadata,
  };
}

export function hydrateWebDailyNewsReport(report: WebDailyNewsReport): DailyNewsReport {
  const storyById = new Map(report.stories.map((story) => [story.id, story]));
  const { webView: _webView, topStoryIds, importantStoryIds, watchlistIds, rankingMetadata, ...shared } = report;

  return {
    ...shared,
    items: report.stories.map((story) => rankingItemFromStory(story, rankingMetadata[story.itemId])),
    topStories: storiesForIds(storyById, topStoryIds),
    importantStories: storiesForIds(storyById, importantStoryIds),
    watchlist: storiesForIds(storyById, watchlistIds),
  };
}

export function isWebDailyNewsReport(value: unknown): value is WebDailyNewsReport {
  if (!value || typeof value !== "object") return false;
  const report = value as Partial<WebDailyNewsReport>;
  const hasShape =
    report.version === 2 &&
    report.webView === 1 &&
    typeof report.generatedAt === "string" &&
    Number.isFinite(Date.parse(report.generatedAt)) &&
    Array.isArray(report.stories) &&
    report.stories.length > 0 &&
    Array.isArray(report.topStoryIds) &&
    Array.isArray(report.importantStoryIds) &&
    Array.isArray(report.watchlistIds) &&
    Array.isArray(report.sections) &&
    Boolean(report.coverage) &&
    Boolean(report.quality) &&
    Boolean(report.rankingMetadata) &&
    typeof report.rankingMetadata === "object";
  if (!hasShape) return false;

  const stories = report.stories as StoryCard[];
  const storyIds = new Set(stories.map((story) => story.id));
  const rankingMetadata = report.rankingMetadata as Record<string, WebReportRankingMetadata>;
  const selectedIds = [
    ...(report.topStoryIds as string[]),
    ...(report.importantStoryIds as string[]),
    ...(report.watchlistIds as string[]),
  ];
  return (
    storyIds.size === stories.length &&
    selectedIds.every((id) => storyIds.has(id)) &&
    stories.every(
      (story) =>
        typeof story.itemId === "string" &&
        story.itemId.length > 0 &&
        Array.isArray(rankingMetadata[story.itemId]?.categories) &&
        rankingMetadata[story.itemId].categories.length > 0,
    )
  );
}

function rankingItemFromStory(story: StoryCard, metadata?: WebReportRankingMetadata): RankedNewsItem {
  const sourceIds = unique(story.evidence.map((entry) => entry.sourceId));
  const relatedUrls = unique(story.evidence.map((entry) => entry.url));
  const primaryEvidence = story.evidence[0];

  return {
    id: story.itemId,
    title: story.title,
    url: primaryEvidence?.url ?? "",
    sourceId: primaryEvidence?.sourceId ?? sourceIds[0] ?? "unknown",
    sourceName: primaryEvidence?.sourceName ?? story.sourceNames[0] ?? "未知来源",
    language: "zh-CN",
    region: story.scope,
    categories: metadata?.categories?.length ? metadata.categories : [story.primaryBeat],
    primaryCategory: story.primaryBeat,
    summary: story.whatHappened,
    publishedAt: story.publishedAt,
    extractedAt: story.updatedAt,
    mayHavePaywall: metadata?.mayHavePaywall,
    sourceIds,
    sourceNames: story.sourceNames,
    relatedUrls,
    primaryCategoryVotes: [story.primaryBeat],
    score_breakdown: {
      final_score: 0,
      public_importance: 0,
      user_preference: 0,
      timeliness: 0,
      source_confidence: 0,
      content_quality: 0,
      ranking_reason: "",
    },
    trust: {
      score: 0,
      level: "low",
      shouldShow: true,
      reasons: [],
    },
  };
}

function storiesForIds(storyById: Map<string, StoryCard>, ids: string[]): StoryCard[] {
  return ids.flatMap((id) => {
    const story = storyById.get(id);
    return story ? [story] : [];
  });
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
