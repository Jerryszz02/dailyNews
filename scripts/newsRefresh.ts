import { createHash, randomUUID } from "node:crypto";
import { defaultPreferences } from "../src/config/preferences.js";
import { newsSources } from "../src/config/sources.js";
import { buildDailyReport } from "../src/lib/newsPipeline.js";
import { isCollectibleSource } from "../src/lib/sourceAdmission.js";
import { defaultSourceIntervalMinutes, selectSourcesForCoverage } from "../src/lib/sourceCoverage.js";
import type { DailyNewsReport, NewsSource, RawNewsItem } from "../src/types";
import {
  collectNewsCandidates,
  defaultCollectionBudgetMs,
  defaultLimitPerSection,
  defaultMaxNewsAgeHours,
  readPositiveInteger,
  retryPendingCandidateTranslations,
  type NewsCollectionOptions,
  type NewsCollectionResult,
} from "./newsService.js";
import type { LeaseIdentity, NewsStore, RefreshLease, RefreshTrigger, SourceCollectionResult } from "./newsStore.js";
import { newestContentTimestamp } from "./newsStore.js";
import { validateReportInvariants } from "./reportStore.js";

export const defaultServerlessMaxSources = 11;
export const defaultRefreshLeaseSeconds = 120;
export const defaultRefreshCandidateLimit = 5_000;

export type NewsRefreshStatus = "published" | "unchanged" | "partial" | "busy" | "duplicate" | "rejected" | "failed";

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
  const enabledSources = configuredSources.filter(isCollectibleSource);
  const maxSources = options.maxSources ?? readPositiveInteger("DAILY_NEWS_MAX_SOURCES", defaultServerlessMaxSources);
  const limitPerSection = options.limitPerSection ?? readPositiveInteger("DAILY_NEWS_LIMIT_PER_SECTION", defaultLimitPerSection);
  const collectionBudgetMs =
    options.collectionBudgetMs ?? readPositiveInteger("DAILY_NEWS_COLLECTION_BUDGET_MS", defaultCollectionBudgetMs);
  const leaseSeconds = options.leaseSeconds ?? defaultRefreshLeaseSeconds;
  const collect = dependencies.collect ?? collectNewsCandidates;
  const buildReport = dependencies.buildReport ?? ((items, reportNow) => buildDailyReport(items, defaultPreferences, reportNow));
  const ownerId = randomUUID();
  const idempotencyKey = options.idempotencyKey ?? manualIdempotencyKey(options.trigger, scheduledAt);
  const sourceRegistry = configuredSources.map((source) => ({
    sourceId: source.source_id,
    enabled: isCollectibleSource(source),
    intervalMinutes: defaultSourceIntervalMinutes,
  }));

  let lease: RefreshLease;
  try {
    lease = await dependencies.store.tryAcquireRefresh({
      ownerId,
      idempotencyKey,
      trigger: options.trigger,
      scheduledAt: scheduledAt.toISOString(),
      leaseSeconds,
    });
  } catch (error) {
    return failedResult("failed", `unresolved:${idempotencyKey}`, null, [], 0, 0, normalizeRefreshError(error));
  }

  if (!lease.acquired) {
    let latestReportId: string | null = null;
    try {
      latestReportId = (await dependencies.store.readState()).latest?.reportId ?? null;
    } catch {
      // A busy or duplicate outcome remains authoritative even if diagnostics are temporarily unavailable.
    }
    return emptyResult(
      lease.outcome === "duplicate" ? "duplicate" : "busy",
      lease.runId,
      latestReportId,
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
    let state = await dependencies.store.readState();
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
      lookaheadMinutes: options.trigger === "cron" ? 5 : 0,
    });
    plannedSourceIds = selectedSources.map((source) => source.source_id);
    const windowFrom = new Date(scheduledAt.getTime() - defaultMaxNewsAgeHours * 60 * 60_000).toISOString();
    const candidateWindowPromise = dependencies.store.readRecentCandidates(windowFrom)
      .then((candidates) => ({ candidates, complete: true, errorCode: null as string | null }))
      .catch((error) => ({
        candidates: state.latest ? candidatesFromLastKnownGood(state.latest.report, configuredSources) : [],
        complete: false,
        errorCode: normalizeRefreshError(error),
      }));
    const [collection, candidateWindow] = await Promise.all([
      selectedSources.length > 0
        ? collect({
            sources: selectedSources,
            maxSources: selectedSources.length,
            limitPerSection,
            collectionBudgetMs,
            now: scheduledAt,
            useFirecrawlKeyless: options.useFirecrawlKeyless ?? true,
            repairSummariesWithModel: options.repairSummariesWithModel ?? true,
          })
        : Promise.resolve({
            items: [],
            mode: "No live data" as const,
            sourceOutcomes: [],
          }),
      candidateWindowPromise,
    ]);
    const storedCandidates = candidateWindow.candidates;
    discoveredCount = collection.items.length;
    const outcomeSourceIds = new Set(collection.sourceOutcomes.map((outcome) => outcome.sourceId));
    missingSourceOutcomeIds = plannedSourceIds.filter((sourceId) => !outcomeSourceIds.has(sourceId));
    skippedSourceIds = [...new Set([
      ...collection.sourceOutcomes.filter((outcome) => outcome.status === "skipped").map((outcome) => outcome.sourceId),
      ...missingSourceOutcomeIds,
    ])];

    const sourceResults = buildSourceResults(selectedSources, collection, scheduledAt, state.sources);
    selectedSourceIds = sourceResults.map((result) => result.sourceId);
    const candidateWindowComplete = candidateWindow.complete;
    const partialRefresh =
      !candidateWindowComplete ||
      skippedSourceIds.length > 0 ||
      sourceResults.some((result) => result.status === "partial" || result.status === "failed");
    const mergedCandidates = mergeRefreshCandidates(
      storedCandidates,
      collection.items,
      windowFrom,
    );
    const candidates = await retryPendingCandidateTranslations(
      mergedCandidates,
      Date.now() + 4_000,
      scheduledAt,
    );
    const mergedByKey = new Map(mergedCandidates.map((candidate) => [candidateKey(candidate), candidate]));
    const translationRepairs = candidates.filter((candidate) => {
      const previous = mergedByKey.get(candidateKey(candidate));
      return previous?.translationStatus === "pending" && candidate.translationStatus === "translated";
    });
    const collectedKeys = new Set(collection.items.map(candidateKey));
    const mergedCollectionUpdates = mergedCandidates.filter((candidate) => collectedKeys.has(candidateKey(candidate)));
    const candidateUpdates = uniqueCandidateUpdates([...mergedCollectionUpdates, ...translationRepairs]);
    candidateCount = candidates.length;
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
      candidate_window_limit: defaultRefreshCandidateLimit,
      candidate_window_complete: candidateWindowComplete,
      candidate_window_error_code: candidateWindow.errorCode,
      translation_repaired_count: translationRepairs.length,
      outcome: partialRefresh ? "partial" : "published",
    };

    if (candidates.length === 0) {
      if (state.latest) {
        await dependencies.store.completeRefreshWithoutPublish(
          leaseIdentity,
          {
            ...metrics,
            outcome: partialRefresh ? "partial" : "unchanged",
            reason: "no_recent_candidates",
          },
          sourceResults,
          candidateUpdates,
        );
        return successfulNoPublishResult(
          partialRefresh,
          lease.runId,
          state.latest.reportId,
          state.latest.report.generatedAt,
          selectedSourceIds,
          discoveredCount,
          0,
        );
      }
      await dependencies.store.markRefreshFailed(leaseIdentity, "no_recent_candidates", metrics);
      return failedResult("rejected", lease.runId, null, selectedSourceIds, discoveredCount, 0, "no_recent_candidates");
    }

    const report: DailyNewsReport = buildReport(candidates, scheduledAt);
    const invariantErrors = validateReportInvariants(report);
    if (invariantErrors.length > 0) {
      await dependencies.store.markRefreshFailed(leaseIdentity, "report_invariant_failed", {
        ...metrics,
        invariant_errors: invariantErrors,
      });
      return failedResult(
        "rejected",
        lease.runId,
        state.latest?.reportId ?? null,
        selectedSourceIds,
        discoveredCount,
        candidateCount,
        "report_invariant_failed",
      );
    }

    const contentHash = hashReportContent(report);
    const previousContentHash = state.latest?.contentHash ?? (state.latest ? hashReportContent(state.latest.report) : null);
    if (state.latest && contentHash === previousContentHash) {
      await dependencies.store.completeRefreshWithoutPublish(
        leaseIdentity,
        {
          ...metrics,
          outcome: partialRefresh ? "partial" : "unchanged",
          content_hash: contentHash,
        },
        sourceResults,
        candidateUpdates,
      );
      return successfulNoPublishResult(
        partialRefresh,
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
    if (!dependencies.store.commitRefresh) throw new Error("atomic_refresh_commit_unavailable");
    const publication = await dependencies.store.commitRefresh(publishInput, sourceResults, candidateUpdates);
    if (!publication.published) {
      return successfulNoPublishResult(
        partialRefresh || publication.outcome === "partial",
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
      status: partialRefresh || publication.outcome === "partial" ? "partial" : "published",
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
      updatedAt: candidate.updatedAt ?? stored?.updatedAt,
      discoveredAt: earliestTimestamp(stored?.discoveredAt, candidate.discoveredAt ?? candidate.extractedAt),
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
      candidateKey(left).localeCompare(candidateKey(right)));
}

function candidatesFromLastKnownGood(report: DailyNewsReport, configuredSources: NewsSource[]): RawNewsItem[] {
  const itemById = new Map(report.items.map((item) => [item.id, item]));
  const sourceById = new Map(configuredSources.map((source) => [source.source_id, source]));
  return report.stories.flatMap((story) => {
    const item = itemById.get(story.itemId);
    return story.evidence.map((evidence) => {
      const source = sourceById.get(evidence.sourceId);
      return {
        id: evidence.candidateId,
        title: evidence.title || story.title,
        url: evidence.url,
        sourceId: evidence.sourceId,
        sourceName: evidence.sourceName,
        language: source?.language ?? item?.language ?? "zh-CN",
        region: source?.countryOrRegion ?? item?.region ?? story.scope,
        categories: item?.categories?.length ? item.categories : [story.primaryBeat],
        primaryCategory: item?.primaryCategory ?? story.primaryBeat,
        summary: story.whatHappened,
        publishedAt: evidence.publishedAt ?? story.publishedAt,
        updatedAt: story.updatedAt,
        discoveredAt: story.startedAt ?? evidence.publishedAt ?? story.updatedAt,
        extractedAt: story.updatedAt,
        mayHavePaywall: item?.mayHavePaywall ?? source?.mayHavePaywall,
        qualityStatus: item?.qualityStatus ?? "display_ready",
        rejectionReasons: item?.rejectionReasons,
        translationStatus: story.translationStatus ?? item?.translationStatus,
        summaryStatus: story.summaryStatus ?? item?.summaryStatus,
        timeStatus: story.timeStatus ?? item?.timeStatus,
      } satisfies RawNewsItem;
    });
  });
}

function uniqueCandidateUpdates(candidates: RawNewsItem[]): RawNewsItem[] {
  const updates = new Map<string, RawNewsItem>();
  for (const candidate of candidates) updates.set(candidateKey(candidate), candidate);
  return [...updates.values()];
}

function candidateTimestamp(candidate: RawNewsItem): number {
  return Date.parse(candidate.updatedAt ?? candidate.publishedAt ?? candidate.discoveredAt ?? candidate.extractedAt ?? "");
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

export function scheduledRefreshIdempotencyKey(date: Date, intervalMinutes = 5): string {
  const intervalMs = intervalMinutes * 60_000;
  const slot = new Date(Math.floor(date.getTime() / intervalMs) * intervalMs).toISOString();
  return `refresh:${slot}`;
}

export function hashReportContent(report: DailyNewsReport): string {
  const {
    generatedAt: _generatedAt,
    refresh,
    ...content
  } = report;
  const stableRefresh = refresh
    ? omitKeys(refresh, new Set([
        "reportId",
        "activeRunId",
        "dataAsOf",
        "lastAttemptAt",
        "lastSuccessAt",
        "lastCheckedAt",
        "lastFullSweepAt",
        "lastPublishedAt",
      ]))
    : undefined;
  return sha256({ ...content, ...(stableRefresh ? { refresh: stableRefresh } : {}) });
}

export function hashCandidates(candidates: RawNewsItem[]): string {
  const content = candidates
    .map(({ extractedAt: _extractedAt, ...candidate }) => candidate)
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

function successfulNoPublishResult(
  partial: boolean,
  runId: string,
  reportId: string | null,
  generatedAt: string | null,
  selectedSourceIds: string[],
  discoveredCount: number,
  candidateCount: number,
): NewsRefreshResult {
  const result = unchangedResult(
    runId,
    reportId,
    generatedAt,
    selectedSourceIds,
    discoveredCount,
    candidateCount,
  );
  return partial ? { ...result, status: "partial" } : result;
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
  if (/invariant/i.test(message)) return "report_invariant_failed";
  return "refresh_failed";
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]),
  );
}

function omitKeys<T extends object>(value: T, omitted: Set<string>): Partial<T> {
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([key]) => !omitted.has(key)),
  ) as Partial<T>;
}
