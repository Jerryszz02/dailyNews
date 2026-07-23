import { existsSync, readFileSync } from "node:fs";
import { defaultPreferences } from "../src/config/preferences.js";
import { firecrawlSnapshotNews } from "../src/data/firecrawlSnapshot.js";
import { buildDailyReport } from "../src/lib/newsPipeline.js";
import {
  freshCoreWindowMinutes,
  isStoryActiveWithin,
  selectionBeatLimit,
  selectionPublisherLimit,
} from "../src/lib/curation.js";
import type { DailyNewsReport, RankedNewsItem, RawNewsItem } from "../src/types";

export interface NewsReportStore {
  readLatest(): DailyNewsReport | null;
  publish(report: DailyNewsReport): boolean;
}

export class InMemoryNewsReportStore implements NewsReportStore {
  private latest: DailyNewsReport | null;

  constructor(initialReport: DailyNewsReport | null = null) {
    this.latest = initialReport;
  }

  readLatest(): DailyNewsReport | null {
    return this.latest;
  }

  publish(report: DailyNewsReport): boolean {
    if (!passesPublishGate(report, this.latest)) return false;
    this.latest = report;
    return true;
  }
}

export function readBundledReport(filePath: URL | string = new URL("../public/daily-news.json", import.meta.url)): DailyNewsReport {
  if (!existsSync(filePath)) return buildSnapshotReport();

  try {
    const stored = JSON.parse(readFileSync(filePath, "utf8")) as Partial<DailyNewsReport>;
    if (isV2Report(stored)) return stored;
    if (Array.isArray(stored.items) && stored.items.length > 0) {
      const items = expandLegacyItems(stored.items);
      return buildDailyReport(items, defaultPreferences, reportDate(stored.generatedAt, items));
    }
  } catch {
    // Fall through to the checked-in TypeScript snapshot.
  }

  return buildSnapshotReport();
}

export function expandLegacyItems(items: RankedNewsItem[] | RawNewsItem[]): RawNewsItem[] {
  return items.flatMap((item) => {
    const ranked = item as Partial<RankedNewsItem>;
    const sourceIds = Array.isArray(ranked.sourceIds) && ranked.sourceIds.length > 0 ? ranked.sourceIds : [item.sourceId];
    const sourceNames = Array.isArray(ranked.sourceNames) && ranked.sourceNames.length > 0 ? ranked.sourceNames : [item.sourceName];
    const relatedUrls = Array.isArray(ranked.relatedUrls) && ranked.relatedUrls.length > 0 ? ranked.relatedUrls : [item.url];

    return sourceIds.map((sourceId, index) => ({
      id: sourceIds.length > 1 ? `${item.id}-evidence-${index + 1}` : item.id,
      title: item.title,
      url: relatedUrls[index] ?? item.url,
      sourceId,
      sourceName: sourceNames[index] ?? item.sourceName,
      language: item.language,
      region: item.region,
      categories: item.categories,
      primaryCategory: item.primaryCategory,
      summary: item.summary,
      publishedAt: item.publishedAt,
      extractedAt: item.extractedAt,
      mayHavePaywall: item.mayHavePaywall,
    }));
  });
}

export function passesPublishGate(report: DailyNewsReport, previous: DailyNewsReport | null = null): boolean {
  const selectedCount = report.topStories.length + report.importantStories.length + report.watchlist.length;
  const passesAbsoluteGate =
    report.version === 2 &&
    report.items.length > 0 &&
    report.stories.length > 0 &&
    report.sourceCount > 0 &&
    selectedCount > 0 &&
    report.quality.acceptedCandidateCount > 0 &&
    report.quality.rejectedCandidateCount < report.quality.candidateCount &&
    selectsFreshCoreWhenAvailable(report);
  if (!passesAbsoluteGate || !previous) return passesAbsoluteGate;

  const previousCoreCount = previous.topStories.length + previous.importantStories.length;
  const currentCoreCount = report.topStories.length + report.importantStories.length;
  const candidatePoolRatio = Math.min(
    1,
    report.quality.candidateCount / Math.max(1, previous.quality.candidateCount),
  );
  const minimumSelectedEventCount = Math.max(
    10,
    Math.floor(previous.quality.selectedEventCount * candidatePoolRatio * 0.6),
  );
  if (report.quality.selectedEventCount < minimumSelectedEventCount) return false;
  if (currentCoreCount < Math.max(5, Math.floor(previousCoreCount * 0.5))) return false;
  if (report.sourceCount < Math.max(3, Math.floor(previous.sourceCount * 0.5))) return false;

  const protectedBeats = new Set(["china", "international", "policy", "finance", "technology", "ai"]);
  const currentCoverage = new Map(report.coverage.beats.map((beat) => [beat.beat, beat]));
  return previous.coverage.beats.every((beat) => {
    if (!protectedBeats.has(beat.beat) || beat.storyCount === 0) return true;
    return (currentCoverage.get(beat.beat)?.candidateCount ?? 0) > 0;
  });
}

function selectsFreshCoreWhenAvailable(report: DailyNewsReport): boolean {
  const generatedAt = new Date(report.generatedAt);
  if (!Number.isFinite(generatedAt.getTime())) return false;
  const freshCoreCandidates = report.stories.filter(
    (story) =>
      story.status === "confirmed" &&
      (story.tier === "must_know" || story.tier === "important") &&
      isStoryActiveWithin(story, generatedAt, freshCoreWindowMinutes),
  );
  if (freshCoreCandidates.length === 0) return true;
  const selectedCore = [...report.topStories, ...report.importantStories];
  const selectedIds = new Set(selectedCore.map((story) => story.id));
  if (freshCoreCandidates.some((story) => selectedIds.has(story.id))) return true;

  const publisherCounts = countBy(selectedCore, (story) => story.evidence[0]?.sourceId ?? "unknown");
  const topBeatCounts = countBy(report.topStories, (story) => story.primaryBeat);
  const importantBeatCounts = countBy(report.importantStories, (story) => story.primaryBeat);
  return freshCoreCandidates.every((story) => {
    const publisher = story.evidence[0]?.sourceId ?? "unknown";
    if ((publisherCounts.get(publisher) ?? 0) >= selectionPublisherLimit) return true;
    if (story.tier === "important") {
      return (importantBeatCounts.get(story.primaryBeat) ?? 0) >= selectionBeatLimit;
    }
    return (
      (topBeatCounts.get(story.primaryBeat) ?? 0) >= selectionBeatLimit &&
      (importantBeatCounts.get(story.primaryBeat) ?? 0) >= selectionBeatLimit
    );
  });
}

function countBy<T>(values: T[], keyFor: (value: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const key = keyFor(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function isV2Report(value: Partial<DailyNewsReport>): value is DailyNewsReport {
  return (
    value.version === 2 &&
    typeof value.generatedAt === "string" &&
    Number.isFinite(Date.parse(value.generatedAt)) &&
    Array.isArray(value.items) &&
    Array.isArray(value.stories) &&
    Array.isArray(value.topStories) &&
    Array.isArray(value.importantStories) &&
    Array.isArray(value.watchlist) &&
    Array.isArray(value.sections) &&
    Boolean(value.coverage) &&
    Boolean(value.quality)
  );
}

function reportDate(value: string | undefined, items: RawNewsItem[]): Date {
  const timestamp = Date.parse(value ?? "");
  return Number.isFinite(timestamp) ? new Date(timestamp) : snapshotReferenceDate(items);
}

function buildSnapshotReport(): DailyNewsReport {
  return buildDailyReport(firecrawlSnapshotNews, defaultPreferences, snapshotReferenceDate(firecrawlSnapshotNews));
}

function snapshotReferenceDate(items: RawNewsItem[]): Date {
  const timestamps = items
    .flatMap((item) => [item.publishedAt, item.extractedAt])
    .map((value) => Date.parse(value ?? ""))
    .filter(Number.isFinite);
  return new Date(timestamps.length > 0 ? Math.max(...timestamps) : 0);
}
