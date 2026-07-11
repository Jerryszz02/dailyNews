import type { Category, DailyNewsReport } from "../types";
import { coverageBeatOrder } from "./sourceCoverage";

export interface AcceptanceMetrics {
  selectedSourceCount: number;
  selectedSectionCount: number;
  searchRequestCount: number;
  sourcePageRequestCount: number;
  articlePageRequestCount: number;
  translatedUniqueEventCount: number;
  duplicateTranslationCount: number;
  collectedCandidateCount?: number;
  recentCandidateCount?: number;
  preparedCandidateCount?: number;
  usedFallback?: boolean;
}

export interface ReportAcceptanceResult {
  status: "PASS" | "FAIL";
  failures: string[];
  categoryCoverage: string;
  emptyCategories: Category[];
  categoryCounts: Record<Category, number>;
  acceptedCategoryCounts: Record<Category, number>;
  rankedCategoryCounts: Record<Category, number>;
  rejectionReasons: Record<string, number>;
  invalidPublishedAtCount: number;
  staleNewsCount: number;
  chronologicalInversionCount: number;
  duplicateTitleSummaryCount: number;
  nonChineseDisplayCount: number;
  sourceDiscoveryRequestCount: number;
  metrics: AcceptanceMetrics;
  singleSourceShare: number;
}

const maxAgeHours = 72;
const maxSourceDiscoveryRequests = 20;
const maxArticlePageRequests = 30;
const maxTranslatedEvents = 15;

export function verifyDailyNewsReport(
  report: DailyNewsReport,
  metrics: AcceptanceMetrics,
  now = new Date(report.generatedAt),
): ReportAcceptanceResult {
  const failures: string[] = [];
  const storyById = new Map(report.stories.map((story) => [story.id, story]));
  const categoryCounts = Object.fromEntries(
    coverageBeatOrder.map((beat) => [beat, report.stories.filter((story) => story.primaryBeat === beat).length]),
  ) as Record<Category, number>;
  const emptyCategories = coverageBeatOrder.filter((beat) => categoryCounts[beat] === 0);
  const acceptedCategoryCounts = Object.fromEntries(
    coverageBeatOrder.map((beat) => [beat, report.coverage.beats.find((entry) => entry.beat === beat)?.candidateCount ?? 0]),
  ) as Record<Category, number>;
  const rankedCategoryCounts = Object.fromEntries(
    coverageBeatOrder.map((beat) => [beat, report.items.filter((item) => item.primaryCategory === beat).length]),
  ) as Record<Category, number>;
  const invalidPublishedAtCount = report.stories.filter((story) => !story.publishedAt || !Number.isFinite(Date.parse(story.publishedAt))).length;
  const staleNewsCount = report.stories.filter((story) => {
    const publishedAt = Date.parse(story.publishedAt ?? "");
    if (!Number.isFinite(publishedAt)) return false;
    const ageMs = now.getTime() - publishedAt;
    return ageMs < 0 || ageMs > maxAgeHours * 3_600_000;
  }).length;
  const duplicateTitleSummaryCount = report.stories.filter(
    (story) => normalize(story.title) === normalize(story.whatHappened),
  ).length;
  const nonChineseDisplayCount = report.stories.filter(
    (story) => !containsChinese(story.title) || !containsChinese(story.whatHappened),
  ).length;
  const chronologicalInversionCount = report.sections.reduce((count, section) => {
    const stories = section.storyIds.map((id) => storyById.get(id)).filter((story) => Boolean(story));
    return count + stories.slice(1).filter((story, index) => storyTime(stories[index]) < storyTime(story)).length;
  }, 0);
  const sourceDiscoveryRequestCount = metrics.searchRequestCount + metrics.sourcePageRequestCount;

  if (emptyCategories.length > 0) failures.push(`empty_categories:${emptyCategories.join(",")}`);
  if (invalidPublishedAtCount > 0) failures.push(`invalid_published_at:${invalidPublishedAtCount}`);
  if (staleNewsCount > 0) failures.push(`stale_news:${staleNewsCount}`);
  if (duplicateTitleSummaryCount > 0) failures.push(`duplicate_title_summary:${duplicateTitleSummaryCount}`);
  if (nonChineseDisplayCount > 0) failures.push(`non_chinese_display:${nonChineseDisplayCount}`);
  if (chronologicalInversionCount > 0) failures.push(`chronological_inversions:${chronologicalInversionCount}`);
  if (metrics.selectedSectionCount > maxSourceDiscoveryRequests) failures.push(`selected_sections:${metrics.selectedSectionCount}`);
  if (sourceDiscoveryRequestCount > maxSourceDiscoveryRequests) failures.push(`source_discovery_requests:${sourceDiscoveryRequestCount}`);
  if (metrics.articlePageRequestCount > maxArticlePageRequests) failures.push(`article_page_requests:${metrics.articlePageRequestCount}`);
  if (metrics.translatedUniqueEventCount > maxTranslatedEvents) failures.push(`translated_events:${metrics.translatedUniqueEventCount}`);
  if (metrics.duplicateTranslationCount > 0) failures.push(`duplicate_translations:${metrics.duplicateTranslationCount}`);
  if (metrics.usedFallback) failures.push("fallback_data");

  return {
    status: failures.length === 0 ? "PASS" : "FAIL",
    failures,
    categoryCoverage: `${coverageBeatOrder.length - emptyCategories.length}/${coverageBeatOrder.length}`,
    emptyCategories,
    categoryCounts,
    acceptedCategoryCounts,
    rankedCategoryCounts,
    rejectionReasons: report.quality.rejectionReasons,
    invalidPublishedAtCount,
    staleNewsCount,
    chronologicalInversionCount,
    duplicateTitleSummaryCount,
    nonChineseDisplayCount,
    sourceDiscoveryRequestCount,
    metrics,
    singleSourceShare: report.quality.singleSourceShare,
  };
}

function storyTime(story: { publishedAt?: string; updatedAt: string } | undefined): number {
  const value = Date.parse(story?.publishedAt ?? story?.updatedAt ?? "");
  return Number.isFinite(value) ? value : 0;
}

function containsChinese(value: string): boolean {
  return /[\u4e00-\u9fff]/.test(value);
}

function normalize(value: string): string {
  return value.replace(/\s+/g, "").trim().toLowerCase();
}
