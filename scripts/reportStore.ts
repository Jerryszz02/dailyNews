import { existsSync, readFileSync } from "node:fs";
import { defaultPreferences } from "../src/config/preferences.js";
import { newsSources } from "../src/config/sources.js";
import { firecrawlSnapshotNews } from "../src/data/firecrawlSnapshot.js";
import { selectLatestStories } from "../src/lib/curation.js";
import { buildDailyReport } from "../src/lib/newsPipeline.js";
import { isAllowedSourceUrl, isApprovedSource } from "../src/lib/sourceAdmission.js";
import { compactDailyNewsReport, hydrateWebDailyNewsReport } from "../src/lib/webReport.js";
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
    if (isV2Report(stored)) return normalizeV2Report(stored);
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

export function passesPublishGate(report: DailyNewsReport, _previous: DailyNewsReport | null = null): boolean {
  return validateReportInvariants(report).length === 0;
}

export function validateReportInvariants(report: DailyNewsReport): string[] {
  const errors: string[] = [];
  if (report.version !== 2) errors.push("unsupported_schema_version");
  if (!Number.isFinite(Date.parse(report.generatedAt))) errors.push("invalid_generated_at");
  if (!Array.isArray(report.items) || report.items.length === 0) errors.push("empty_items");
  if (!Array.isArray(report.stories) || report.stories.length === 0) errors.push("empty_stories");
  if (!Number.isFinite(report.sourceCount) || report.sourceCount < 1) errors.push("empty_sources");
  if (report.quality.unmappedCandidateCount !== 0) errors.push("unmapped_candidates");

  const approvedSourceById = new Map(
    newsSources.filter(isApprovedSource).map((source) => [source.source_id, source]),
  );
  const itemIds = new Set<string>();
  for (const item of report.items) {
    if (!item.id || itemIds.has(item.id)) errors.push("duplicate_or_missing_item_id");
    itemIds.add(item.id);
  }
  const storyIds = new Set<string>();
  const storyItemIds = new Set<string>();
  const candidateIds = new Set<string>();
  const evidenceSourceIds = new Set<string>();
  for (const story of report.stories) {
    if (!story.id || storyIds.has(story.id)) errors.push("duplicate_or_missing_story_id");
    storyIds.add(story.id);
    if (!story.itemId || storyItemIds.has(story.itemId) || !itemIds.has(story.itemId)) {
      errors.push("invalid_story_item_reference");
    }
    storyItemIds.add(story.itemId);
    const startedAt = Date.parse(story.startedAt ?? "");
    const updatedAt = Date.parse(story.updatedAt);
    if (!Number.isFinite(startedAt) || !Number.isFinite(updatedAt) || startedAt > updatedAt) {
      errors.push("invalid_story_time_relation");
    }
    if (!Array.isArray(story.evidence) || story.evidence.length === 0) {
      errors.push("missing_story_evidence");
      continue;
    }
    for (const evidence of story.evidence) {
      if (!evidence.candidateId || candidateIds.has(evidence.candidateId)) {
        errors.push("duplicate_or_missing_candidate_mapping");
      }
      candidateIds.add(evidence.candidateId);
      const source = approvedSourceById.get(evidence.sourceId);
      if (!source) {
        errors.push("unapproved_evidence_source");
      } else if (!isAllowedSourceUrl(source, evidence.url)) {
        errors.push("evidence_url_out_of_scope");
      }
      evidenceSourceIds.add(evidence.sourceId);
      if (!isHttpsUrl(evidence.url)) errors.push("invalid_story_url");
      if (evidence.publishedAt) {
        const evidencePublishedAt = Date.parse(evidence.publishedAt);
        if (!Number.isFinite(evidencePublishedAt) || evidencePublishedAt > updatedAt) {
          errors.push("invalid_evidence_time_relation");
        }
      }
    }
  }
  if (storyItemIds.size !== itemIds.size) errors.push("unmapped_report_item");
  if (candidateIds.size !== report.quality.acceptedCandidateCount) errors.push("candidate_mapping_count_mismatch");
  if (evidenceSourceIds.size !== report.sourceCount) errors.push("source_count_mismatch");

  const selected = [
    ...(report.latestStories ?? []),
    ...report.topStories,
    ...report.importantStories,
    ...report.watchlist,
  ];
  if (selected.some((story) => !storyIds.has(story.id))) errors.push("dangling_story_reference");
  const storyById = new Map(report.stories.map((story) => [story.id, story]));
  if (selected.some((story) => JSON.stringify(storyById.get(story.id)) !== JSON.stringify(story))) {
    errors.push("inconsistent_story_reference");
  }
  if (report.sections.some((section) => section.storyIds.some((storyId) => !storyIds.has(storyId)))) {
    errors.push("dangling_section_reference");
  }
  const expectedLatestIds = selectLatestStories(report.stories, new Date(report.generatedAt)).map((story) => story.id);
  const actualLatestIds = (report.latestStories ?? []).map((story) => story.id);
  if (JSON.stringify(actualLatestIds) !== JSON.stringify(expectedLatestIds)) errors.push("incomplete_latest_stories");

  try {
    const hydrated = hydrateWebDailyNewsReport(compactDailyNewsReport(report));
    if (JSON.stringify(visibleReportProjection(hydrated)) !== JSON.stringify(visibleReportProjection(report))) {
      errors.push("compact_round_trip_mismatch");
    }
  } catch {
    errors.push("compact_round_trip_failed");
  }
  return [...new Set(errors)];
}

function visibleReportProjection(report: DailyNewsReport): unknown {
  return {
    version: report.version,
    generatedAt: report.generatedAt,
    window: report.window,
    stories: report.stories,
    latestStoryIds: (report.latestStories ?? []).map((story) => story.id),
    topStoryIds: report.topStories.map((story) => story.id),
    importantStoryIds: report.importantStories.map((story) => story.id),
    watchlistIds: report.watchlist.map((story) => story.id),
    sections: report.sections,
    coverage: report.coverage,
    quality: report.quality,
    sourceCount: report.sourceCount,
    notes: report.notes,
    refresh: report.refresh,
  };
}

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && (!url.port || url.port === "443");
  } catch {
    return false;
  }
}

export function normalizeV2Report(report: DailyNewsReport): DailyNewsReport {
  const stories = report.stories.map((story) => ({
    ...story,
    startedAt: story.startedAt ?? earliestTimestamp([
      story.publishedAt,
      ...story.evidence.map((evidence) => evidence.publishedAt),
      story.updatedAt,
    ]),
  }));
  const storyById = new Map(stories.map((story) => [story.id, story]));
  const storyByItemId = new Map(stories.map((story) => [story.itemId, story]));
  const resolveStories = (selected: DailyNewsReport["stories"]) =>
    selected.flatMap((story) => {
      const normalized = storyById.get(story.id);
      return normalized ? [normalized] : [];
    });
  const generatedAt = new Date(report.generatedAt);
  const latestStories = selectLatestStories(stories, generatedAt);

  return {
    ...report,
    items: report.items.map((item) => {
      const story = storyByItemId.get(item.id);
      const updatedAt = item.updatedAt ?? story?.updatedAt ?? item.publishedAt ?? item.extractedAt;
      return {
        ...item,
        startedAt: item.startedAt ?? story?.startedAt ?? item.publishedAt ?? updatedAt,
        updatedAt,
      };
    }),
    stories,
    latestStories,
    topStories: resolveStories(report.topStories),
    importantStories: resolveStories(report.importantStories),
    watchlist: resolveStories(report.watchlist),
    quality: {
      ...report.quality,
      latestEventCount: latestStories.length,
      unmappedCandidateCount: report.quality.unmappedCandidateCount ?? 0,
    },
  };
}

function earliestTimestamp(values: Array<string | undefined>): string {
  const timestamps = values.map((value) => Date.parse(value ?? "")).filter(Number.isFinite);
  return new Date(Math.min(...timestamps)).toISOString();
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
