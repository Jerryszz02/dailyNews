import { createHash, randomUUID } from "node:crypto";
import { defaultPreferences } from "../src/config/preferences.js";
import { newsSources } from "../src/config/sources.js";
import { evaluatePublishedContentFreshness } from "../src/lib/contentFreshness.js";
import { buildDailyReport } from "../src/lib/newsPipeline.js";
import { storyActivityTimestamp } from "../src/lib/curation.js";
import { defaultSourceIntervalMinutes, selectSourcesForCoverage } from "../src/lib/sourceCoverage.js";
import type { DailyNewsReport, NewsSource, RawNewsItem } from "../src/types";
import {
  collectNewsCandidates,
  defaultCollectionBudgetMs,
  defaultLimitPerSection,
  defaultMaxNewsAgeHours,
  readPositiveInteger,
  type NewsCollectionOptions,
  type NewsCollectionResult,
} from "./newsService.js";
import type { LeaseIdentity, NewsStore, RefreshTrigger, SourceCollectionResult } from "./newsStore.js";
import { newestContentTimestamp } from "./newsStore.js";
import { passesPublishGate } from "./reportStore.js";

export const defaultServerlessMaxSources = 11;
export const defaultRefreshLeaseSeconds = 120;
export const defaultRefreshCandidateLimit = 500;

export type NewsRefreshStatus = "published" | "unchanged" | "busy" | "duplicate" | "rejected" | "failed";

export interface NewsRefreshResult {
  ok: boolean;
  status: NewsRefreshStatus;
  runId: string | null;
  reportId: string | null;
  generatedAt: string | null;
  selectedSourceIds: string[];
  discoveredCount: number;
  candidateCount: number;
  errorCode: string | null;
}

export interface RunNewsRefreshOptions {
  trigger: RefreshTrigger;
  idempotencyKey?: string;
  scheduledAt?: Date;
  maxSources?: number;
  limitPerSection?: number;
  collectionBudgetMs?: number;
  leaseSeconds?: number;
  useFirecrawlKeyless?: boolean;
  repairSummariesWithModel?: boolean;
}

export interface NewsRefreshDependencies {
  store: NewsStore;
  now?: () => Date;
  sources?: NewsSource[];
  collect?: (options: NewsCollectionOptions) => Promise<NewsCollectionResult>;
  buildReport?: (items: RawNewsItem[], now: Date) => DailyNewsReport;
}

export async function runNewsRefresh(
  options: RunNewsRefreshOptions,
  dependencies: NewsRefreshDependencies,
): Promise<NewsRefreshResult> {
  const now = dependencies.now ?? (() => new Date());
  const scheduledAt = options.scheduledAt ?? now();
  const configuredSources = dependencies.sources ?? newsSources;
  const enabledSources = configuredSources.filter((source) => source.enabled);
  const maxSources = options.maxSources ?? readPositiveInteger("DAILY_NEWS_MAX_SOURCES", defaultServerlessMaxSources);
  const limitPerSection = options.limitPerSection ?? readPositiveInteger("DAILY_NEWS_LIMIT_PER_SECTION", defaultLimitPerSection);
  const collectionBudgetMs =
    options.collectionBudgetMs ?? readPositiveInteger("DAILY_NEWS_COLLECTION_BUDGET_MS", defaultCollectionBudgetMs);
  const leaseSeconds = options.leaseSeconds ?? defaultRefreshLeaseSeconds;
  const collect = dependencies.collect ?? collectNewsCandidates;
  const buildReport = dependencies.buildReport ?? ((items, reportNow) => buildDailyReport(items, defaultPreferences, reportNow));
  const ownerId = randomUUID();
  const sourceRegistry = configuredSources.map((source) => ({
    sourceId: source.source_id,
    enabled: source.enabled,
    intervalMinutes: defaultSourceIntervalMinutes,
  }));

  const [lease, initialState] = await Promise.all([
    dependencies.store.tryAcquireRefresh({
      ownerId,
      idempotencyKey: options.idempotencyKey ?? manualIdempotencyKey(options.trigger, scheduledAt),
      trigger: options.trigger,
      scheduledAt: scheduledAt.toISOString(),
      leaseSeconds,
    }),
    dependencies.store.readState(),
  ]);

  if (!lease.acquired) {
    return emptyResult(
      lease.outcome === "duplicate" ? "duplicate" : "busy",
      lease.runId,
      initialState.latest?.reportId ?? null,
    );
  }

  const leaseIdentity: LeaseIdentity = {
    ownerId: lease.ownerId,
    runId: lease.runId,
    fencingToken: lease.fencingToken,
  };
  let plannedSourceIds: string[] = [];
  let selectedSourceIds: string[] = [];
  let skippedSourceIds: string[] = [];
  let missingSourceOutcomeIds: string[] = [];
  let discoveredCount = 0;
  let candidateCount = 0;
  let latestReportId: string | null = null;

  try {
    let state = initialState;
    if (!sourceRegistryMatches(sourceRegistry, state.sources)) {
      await dependencies.store.syncSources(leaseIdentity, sourceRegistry, scheduledAt.toISOString());
      state = await dependencies.store.readState();
    }
    latestReportId = state.latest?.reportId ?? null;
    const sourceSelectionAt = new Date(Math.max(scheduledAt.getTime(), now().getTime()));
    const selectedSources = selectSourcesForCoverage(enabledSources, maxSources, {
      health: state.sources,
      now: sourceSelectionAt,
      defaultIntervalMinutes: defaultSourceIntervalMinutes,
      lookaheadMinutes: options.trigger === "cron" ? 15 : 0,
    });
    plannedSourceIds = selectedSources.map((source) => source.source_id);
    if (selectedSources.length === 0) {
      await dependencies.store.completeRefreshWithoutPublish(leaseIdentity, {
        outcome: "no_sources_due",
        selected_source_ids: [],
      });
      return unchangedResult(
        lease.runId,
        state.latest?.reportId ?? null,
        state.latest?.report.generatedAt ?? null,
        [],
        0,
        0,
      );
    }

    const windowFrom = new Date(scheduledAt.getTime() - defaultMaxNewsAgeHours * 60 * 60_000).toISOString();
    const [collection, storedCandidates] = await Promise.all([
      collect({
        sources: selectedSources,
        maxSources: selectedSources.length,
        limitPerSection,
        collectionBudgetMs,
        now: scheduledAt,
        useFirecrawlKeyless: options.useFirecrawlKeyless ?? true,
        repairSummariesWithModel: options.repairSummariesWithModel ?? true,
      }),
      dependencies.store.readRecentCandidates(windowFrom, defaultRefreshCandidateLimit),
    ]);
    discoveredCount = collection.items.length;
    const outcomeSourceIds = new Set(collection.sourceOutcomes.map((outcome) => outcome.sourceId));
    missingSourceOutcomeIds = plannedSourceIds.filter((sourceId) => !outcomeSourceIds.has(sourceId));
    skippedSourceIds = [...new Set([
      ...collection.sourceOutcomes.filter((outcome) => outcome.status === "skipped").map((outcome) => outcome.sourceId),
      ...missingSourceOutcomeIds,
    ])];

    const sourceResults = buildSourceResults(selectedSources, collection, scheduledAt, state.sources);
    selectedSourceIds = sourceResults.map((result) => result.sourceId);
    const persistCollection = () => Promise.all([
      dependencies.store.recordSourceResults(leaseIdentity, sourceResults),
      collection.items.length > 0
        ? dependencies.store.upsertCandidates(leaseIdentity, collection.items)
        : Promise.resolve(0),
    ]);
    let persistence = dependencies.store.commitRefresh ? null : persistCollection();
    const ensurePersisted = () => {
      persistence ??= persistCollection();
      return persistence;
    };
    const candidates = mergeRefreshCandidates(
      storedCandidates,
      collection.items,
      windowFrom,
      defaultRefreshCandidateLimit,
    );
    candidateCount = candidates.length;
    const contentFreshness = evaluatePublishedContentFreshness(candidates, scheduledAt);
    const metrics: Record<string, unknown> = {
      mode: collection.mode,
      planned_source_ids: plannedSourceIds,
      selected_source_ids: selectedSourceIds,
      skipped_source_ids: skippedSourceIds,
      skipped_source_count: skippedSourceIds.length,
      missing_source_outcome_ids: missingSourceOutcomeIds,
      missing_source_outcome_count: missingSourceOutcomeIds.length,
      discovered_count: discoveredCount,
      candidate_count: candidateCount,
      newest_published_at: contentFreshness.newestPublishedAt,
      newest_content_age_minutes: contentFreshness.ageMinutes,
      max_publish_content_age_minutes: contentFreshness.maxAgeMinutes,
    };

    if (candidates.length === 0) {
      await ensurePersisted();
      if (state.latest) {
        await dependencies.store.completeRefreshWithoutPublish(leaseIdentity, { ...metrics, outcome: "no_recent_candidates" });
        return unchangedResult(lease.runId, state.latest.reportId, state.latest.report.generatedAt, selectedSourceIds, discoveredCount, 0);
      }
      await dependencies.store.markRefreshFailed(leaseIdentity, "no_recent_candidates", metrics);
      return failedResult("rejected", lease.runId, null, selectedSourceIds, discoveredCount, 0, "no_recent_candidates");
    }

    if (!contentFreshness.publishable) {
      await ensurePersisted();
      await dependencies.store.markRefreshFailed(leaseIdentity, "stale_candidate_pool", {
        ...metrics,
        outcome: "stale_candidate_pool",
      });
      return failedResult(
        state.latest ? "failed" : "rejected",
        lease.runId,
        state.latest?.reportId ?? null,
        selectedSourceIds,
        discoveredCount,
        candidateCount,
        "stale_candidate_pool",
      );
    }

    let report: DailyNewsReport;
    try {
      report = buildReport(candidates, scheduledAt);
    } catch (error) {
      await ensurePersisted().catch(() => {});
      throw error;
    }
    const homepageFreshness = evaluatePublishedContentFreshness(
      [...report.topStories, ...report.importantStories, ...report.watchlist].map((story) => ({
        publishedAt: timestampString(storyActivityTimestamp(story)),
      })),
      scheduledAt,
    );
    metrics.homepage_newest_activity_at = homepageFreshness.newestPublishedAt;
    metrics.homepage_newest_activity_age_minutes = homepageFreshness.ageMinutes;
    if (!homepageFreshness.publishable) {
      await ensurePersisted();
      await dependencies.store.markRefreshFailed(leaseIdentity, "stale_homepage_selection", {
        ...metrics,
        outcome: "stale_homepage_selection",
      });
      return failedResult(
        state.latest ? "failed" : "rejected",
        lease.runId,
        state.latest?.reportId ?? null,
        selectedSourceIds,
        discoveredCount,
        candidateCount,
        "stale_homepage_selection",
      );
    }
    if (!passesPublishGate(report, state.latest?.report ?? null)) {
      await ensurePersisted();
      await dependencies.store.markRefreshFailed(leaseIdentity, "quality_gate_failed", metrics);
      return failedResult(
        "rejected",
        lease.runId,
        state.latest?.reportId ?? null,
        selectedSourceIds,
        discoveredCount,
        candidateCount,
        "quality_gate_failed",
      );
    }

    const contentHash = hashReportContent(report);
    const previousContentHash = state.latest?.contentHash ?? (state.latest ? hashReportContent(state.latest.report) : null);
    if (state.latest && contentHash === previousContentHash) {
      await ensurePersisted();
      await dependencies.store.completeRefreshWithoutPublish(leaseIdentity, { ...metrics, outcome: "unchanged", content_hash: contentHash });
      return unchangedResult(
        lease.runId,
        state.latest.reportId,
        state.latest.report.generatedAt,
        selectedSourceIds,
        discoveredCount,
        candidateCount,
      );
    }

    const reportId = randomUUID();
    const publishInput = {
      ...leaseIdentity,
      reportId,
      report,
      dataAsOf: report.generatedAt,
      newestContentAt: newestContentTimestamp(report),
      contentHash,
      inputFingerprint: hashCandidates(candidates),
      metrics,
    };
    let publication;
    if (dependencies.store.commitRefresh) {
      publication = await dependencies.store.commitRefresh(publishInput, sourceResults, collection.items);
    } else {
      await ensurePersisted();
      publication = await dependencies.store.publishRefresh(publishInput);
    }
    if (!publication.published) {
      return unchangedResult(
        lease.runId,
        publication.reportId ?? publication.previousReportId,
        state.latest?.report.generatedAt ?? null,
        selectedSourceIds,
        discoveredCount,
        candidateCount,
      );
    }

    return {
      ok: true,
      status: "published",
      runId: lease.runId,
      reportId: publication.reportId,
      generatedAt: report.generatedAt,
      selectedSourceIds,
      discoveredCount,
      candidateCount,
      errorCode: null,
    };
  } catch (error) {
    const errorCode = normalizeRefreshError(error);
    try {
      await dependencies.store.markRefreshFailed(leaseIdentity, errorCode, {
        planned_source_ids: plannedSourceIds,
        selected_source_ids: selectedSourceIds,
        skipped_source_ids: skippedSourceIds,
        skipped_source_count: skippedSourceIds.length,
        missing_source_outcome_ids: missingSourceOutcomeIds,
        missing_source_outcome_count: missingSourceOutcomeIds.length,
        discovered_count: discoveredCount,
        candidate_count: candidateCount,
      });
    } catch {
      // A newer fencing token may already own the lease; never hide the original outcome.
    }
    return failedResult(
      "failed",
      lease.runId,
      latestReportId,
      selectedSourceIds,
      discoveredCount,
      candidateCount,
      errorCode,
    );
  }
}

function sourceRegistryMatches(
  registry: Array<{ sourceId: string; enabled: boolean; intervalMinutes: number }>,
  states: Array<{ sourceId: string; enabled?: boolean; intervalMinutes: number }>,
): boolean {
  const registryById = new Map(registry.map((source) => [source.sourceId, source]));
  const stateById = new Map(states.map((source) => [source.sourceId, source]));
  if (registry.some((source) => {
    const state = stateById.get(source.sourceId);
    return !state || state.enabled !== source.enabled || state.intervalMinutes !== source.intervalMinutes;
  })) return false;
  return states.every((state) => state.enabled !== true || registryById.get(state.sourceId)?.enabled === true);
}

export function mergeRefreshCandidates(
  storedCandidates: RawNewsItem[],
  collectedCandidates: RawNewsItem[],
  since: string,
  limit: number,
): RawNewsItem[] {
  const bySourceAndUrl = new Map<string, RawNewsItem>();
  for (const candidate of storedCandidates) {
    bySourceAndUrl.set(candidateKey(candidate), candidate);
  }
  for (const candidate of collectedCandidates) {
    const key = candidateKey(candidate);
    const stored = bySourceAndUrl.get(key);
    bySourceAndUrl.set(key, {
      ...candidate,
      publishedAt: candidate.publishedAt ?? stored?.publishedAt,
      extractedAt: earliestTimestamp(stored?.extractedAt, candidate.extractedAt),
    });
  }
  const sinceMs = Date.parse(since);
  return [...bySourceAndUrl.values()]
    .filter((candidate) => {
      const timestamp = candidateTimestamp(candidate);
      return Number.isFinite(timestamp) && timestamp >= sinceMs;
    })
    .sort((left, right) =>
      candidateTimestamp(right) - candidateTimestamp(left) ||
      candidateKey(left).localeCompare(candidateKey(right)))
    .slice(0, limit);
}

function candidateTimestamp(candidate: RawNewsItem): number {
  return Date.parse(candidate.publishedAt ?? candidate.extractedAt ?? "");
}

function earliestTimestamp(left: string | undefined, right: string): string {
  const leftMs = Date.parse(left ?? "");
  const rightMs = Date.parse(right);
  if (!Number.isFinite(leftMs)) return right;
  if (!Number.isFinite(rightMs)) return left!;
  return leftMs <= rightMs ? left! : right;
}

function candidateKey(candidate: RawNewsItem): string {
  return `${candidate.sourceId}\n${canonicalCandidateUrl(candidate.url)}`;
}

function canonicalCandidateUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|spm$|from$|source$|ref$)/i.test(key)) url.searchParams.delete(key);
    }
    url.hash = "";
    return url.toString();
  } catch {
    return value;
  }
}

function timestampString(timestamp: number): string | null {
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

export function scheduledRefreshIdempotencyKey(date: Date, intervalMinutes = 15): string {
  const intervalMs = intervalMinutes * 60_000;
  const slot = new Date(Math.floor(date.getTime() / intervalMs) * intervalMs).toISOString();
  return `refresh:${slot}`;
}

export function hashReportContent(report: DailyNewsReport): string {
  const content = {
    items: report.items
      .map((item) => ({
        id: item.id,
        title: item.title,
        url: item.url,
        summary: item.summary,
        publishedAt: item.publishedAt ?? null,
        sourceIds: [...item.sourceIds].sort(),
        relatedUrls: [...item.relatedUrls].sort(),
        primaryCategory: item.primaryCategory,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    stories: report.stories
      .map((story) => ({
        id: story.id,
        updatedAt: story.updatedAt,
        status: story.status,
        tier: story.tier,
        evidence: story.evidence
          .map((evidence) => ({ url: evidence.url, publishedAt: evidence.publishedAt ?? null }))
          .sort((left, right) => left.url.localeCompare(right.url)),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    topStoryIds: report.topStories.map((story) => story.id),
    importantStoryIds: report.importantStories.map((story) => story.id),
    watchlistIds: report.watchlist.map((story) => story.id),
  };
  return sha256(content);
}

export function hashCandidates(candidates: RawNewsItem[]): string {
  const content = candidates
    .map((candidate) => ({
      id: candidate.id,
      sourceId: candidate.sourceId,
      url: candidate.url,
      title: candidate.title,
      summary: candidate.summary,
      publishedAt: candidate.publishedAt ?? null,
    }))
    .sort((left, right) => `${left.sourceId}:${left.id}`.localeCompare(`${right.sourceId}:${right.id}`));
  return sha256(content);
}

function buildSourceResults(
  selectedSources: NewsSource[],
  collection: NewsCollectionResult,
  attemptedAt: Date,
  currentStates: Array<{ sourceId: string; intervalMinutes: number }>,
): SourceCollectionResult[] {
  const outcomes = new Map(collection.sourceOutcomes.map((outcome) => [outcome.sourceId, outcome]));
  const intervalBySource = new Map(currentStates.map((state) => [state.sourceId, state.intervalMinutes]));
  return selectedSources.flatMap((source) => {
    const outcome = outcomes.get(source.source_id);
    if (!outcome || outcome.status === "skipped") return [];
    const intervalMinutes = intervalBySource.get(source.source_id) ?? defaultSourceIntervalMinutes;
    return [{
      sourceId: source.source_id,
      status: outcome.status,
      attemptedAt: attemptedAt.toISOString(),
      nextDueAt: new Date(attemptedAt.getTime() + intervalMinutes * 60_000).toISOString(),
      discoveredCount: outcome.discoveredCount,
      acceptedCount: outcome.discoveredCount,
      errorCode: outcome.errorCode,
    }];
  });
}

function emptyResult(status: "busy" | "duplicate", runId: string, reportId: string | null): NewsRefreshResult {
  return {
    ok: true,
    status,
    runId,
    reportId,
    generatedAt: null,
    selectedSourceIds: [],
    discoveredCount: 0,
    candidateCount: 0,
    errorCode: null,
  };
}

function unchangedResult(
  runId: string,
  reportId: string | null,
  generatedAt: string | null,
  selectedSourceIds: string[],
  discoveredCount: number,
  candidateCount: number,
): NewsRefreshResult {
  return {
    ok: true,
    status: "unchanged",
    runId,
    reportId,
    generatedAt,
    selectedSourceIds,
    discoveredCount,
    candidateCount,
    errorCode: null,
  };
}

function failedResult(
  status: "rejected" | "failed",
  runId: string,
  reportId: string | null,
  selectedSourceIds: string[],
  discoveredCount: number,
  candidateCount: number,
  errorCode: string,
): NewsRefreshResult {
  return {
    ok: false,
    status,
    runId,
    reportId,
    generatedAt: null,
    selectedSourceIds,
    discoveredCount,
    candidateCount,
    errorCode,
  };
}

function manualIdempotencyKey(trigger: RefreshTrigger, scheduledAt: Date): string {
  return trigger === "cron" ? scheduledRefreshIdempotencyKey(scheduledAt) : `${trigger}:${scheduledAt.toISOString()}:${randomUUID()}`;
}

function normalizeRefreshError(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  const message = String(error);
  if (/lease/i.test(message)) return "refresh_lease_invalid";
  if (/quality/i.test(message)) return "quality_gate_failed";
  return "refresh_failed";
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
