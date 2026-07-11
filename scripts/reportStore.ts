import { existsSync, readFileSync } from "node:fs";
import { defaultPreferences } from "../src/config/preferences.js";
import { firecrawlSnapshotNews } from "../src/data/firecrawlSnapshot.js";
import { buildDailyReport } from "../src/lib/newsPipeline.js";
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

export function readBundledReport(): DailyNewsReport {
  const filePath = new URL("../public/daily-news.json", import.meta.url);
  if (!existsSync(filePath)) return buildDailyReport(firecrawlSnapshotNews, defaultPreferences);

  try {
    const stored = JSON.parse(readFileSync(filePath, "utf8")) as Partial<DailyNewsReport>;
    if (isV2Report(stored)) return stored;
    if (Array.isArray(stored.items) && stored.items.length > 0) {
      return buildDailyReport(expandLegacyItems(stored.items), defaultPreferences, reportDate(stored.generatedAt));
    }
  } catch {
    // Fall through to the checked-in TypeScript snapshot.
  }

  return buildDailyReport(firecrawlSnapshotNews, defaultPreferences);
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
    report.quality.rejectedCandidateCount < report.quality.candidateCount;
  if (!passesAbsoluteGate || !previous) return passesAbsoluteGate;

  if (report.quality.selectedEventCount < 10) return false;
  if (report.sourceCount < 3) return false;

  const protectedBeats = new Set(["china", "international", "policy", "finance", "technology", "ai"]);
  const currentCoverage = new Map(report.coverage.beats.map((beat) => [beat.beat, beat]));
  return previous.coverage.beats.every((beat) => {
    if (!protectedBeats.has(beat.beat) || beat.storyCount === 0) return true;
    return (currentCoverage.get(beat.beat)?.candidateCount ?? 0) > 0;
  });
}

function isV2Report(value: Partial<DailyNewsReport>): value is DailyNewsReport {
  return (
    value.version === 2 &&
    typeof value.generatedAt === "string" &&
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

function reportDate(value: string | undefined): Date {
  const timestamp = Date.parse(value ?? "");
  return Number.isFinite(timestamp) ? new Date(timestamp) : new Date();
}
