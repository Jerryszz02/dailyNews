import type { Category, MediaType, NewsSource } from "../types";

export const coverageBeatOrder: Category[] = [
  "china",
  "international",
  "policy",
  "society",
  "finance",
  "technology",
  "ai",
  "science",
  "sports",
  "entertainment",
];

export interface SourceHealthState {
  sourceId: string;
  consecutiveFailures: number;
  acceptedRate?: number;
  lastErrorCode?: string | null;
  circuitOpenUntil?: string | null;
  lastAttemptAt?: string | null;
  lastSuccessAt?: string | null;
  nextDueAt?: string | null;
  intervalMinutes?: number;
}

export interface CoverageSelectionOptions {
  health?: SourceHealthState[];
  now?: Date;
  defaultIntervalMinutes?: number;
  lookaheadMinutes?: number;
}

export const defaultSourceIntervalMinutes = 30;
export const normalRotationSlots = 9;
export const retrySlots = 2;

const mediaRoleScore: Record<MediaType, number> = {
  wire: 28,
  official: 24,
  public: 20,
  business: 14,
  technology: 14,
  commercial: 10,
  social: -30,
};

export function selectSourcesForCoverage(
  sources: NewsSource[],
  maxSources: number,
  options: CoverageSelectionOptions = {},
): NewsSource[] {
  const now = options.now ?? new Date();
  const healthById = new Map((options.health ?? []).map((state) => [state.sourceId, state]));
  const available = sources.filter(
    (source) =>
      source.enabled &&
      source.admission === "approved",
  );
  const defaultIntervalMinutes = positiveNumber(options.defaultIntervalMinutes) ?? defaultSourceIntervalMinutes;
  const lookaheadMinutes = positiveNumber(options.lookaheadMinutes) ?? 0;
  const selectionCutoff = now.getTime() + lookaheadMinutes * 60_000;
  const candidates =
    options.health === undefined
      ? available
      : available.filter((source) => sourceDueAt(healthById.get(source.source_id), defaultIntervalMinutes) <= selectionCutoff);
  const effectiveLimit = Math.min(
    maxSources,
    options.health === undefined ? candidates.length : normalRotationSlots + retrySlots,
  );
  if (options.health === undefined) {
    return effectiveLimit >= candidates.length
      ? candidates
      : selectFairSources(candidates, effectiveLimit, healthById, defaultIntervalMinutes);
  }

  const retryCandidates = candidates.filter((source) =>
    shouldPrioritizeRetry(healthById.get(source.source_id)),
  );
  const normalCandidates = candidates.filter((source) => !retryCandidates.includes(source));
  const reservedRetrySlots = Math.min(retrySlots, retryCandidates.length, effectiveLimit);
  const normal = selectFairSources(
    normalCandidates,
    Math.min(normalRotationSlots, Math.max(0, effectiveLimit - reservedRetrySlots)),
    healthById,
    defaultIntervalMinutes,
  );
  const retries = selectFairSources(
    retryCandidates,
    Math.min(retrySlots, Math.max(0, effectiveLimit - normal.length)),
    healthById,
    defaultIntervalMinutes,
  );
  const backfill = selectFairSources(
    candidates.filter((source) => !normal.includes(source) && !retries.includes(source)),
    Math.max(0, effectiveLimit - normal.length - retries.length),
    healthById,
    defaultIntervalMinutes,
  );

  return [...normal, ...backfill, ...retries];
}

function selectFairSources(
  candidates: NewsSource[],
  limit: number,
  healthById: Map<string, SourceHealthState>,
  defaultIntervalMinutes: number,
): NewsSource[] {
  if (limit <= 0 || candidates.length === 0) return [];

  const selected: NewsSource[] = [];
  const beatCounts = new Map<Category, number>();
  const coveredRegions = new Set<string>();

  while (selected.length < Math.min(limit, candidates.length)) {
    const remaining = candidates.filter((source) => !selected.includes(source));
    const earliestDueAt = Math.min(
      ...remaining.map((source) => sourceDueAt(healthById.get(source.source_id), defaultIntervalMinutes)),
    );
    const candidate = remaining
      .filter(
        (source) => sourceDueAt(healthById.get(source.source_id), defaultIntervalMinutes) === earliestDueAt,
      )
      .map((source) => ({ source, score: coverageScore(source, beatCounts, coveredRegions, healthById.get(source.source_id)) }))
      .sort((left, right) => right.score - left.score || left.source.source_id.localeCompare(right.source.source_id))[0]?.source;
    if (!candidate) break;

    selected.push(candidate);
    sourceBeats(candidate).forEach((beat) => beatCounts.set(beat, (beatCounts.get(beat) ?? 0) + 1));
    coveredRegions.add(candidate.countryOrRegion);
  }

  return selected;
}

function shouldPrioritizeRetry(state: SourceHealthState | undefined): boolean {
  return (state?.consecutiveFailures ?? 0) > 0 || Boolean(state?.lastErrorCode);
}

export function sourceBeats(source: NewsSource): Category[] {
  return Array.from(new Set(source.sections.flatMap((section) => [section.primaryCategory, ...section.categories])));
}

function coverageScore(
  source: NewsSource,
  beatCounts: Map<Category, number>,
  coveredRegions: Set<string>,
  health?: SourceHealthState,
): number {
  const uncoveredBeatScore = sourceBeats(source).reduce((score, beat) => {
    const priority = coverageBeatOrder.length - coverageBeatOrder.indexOf(beat);
    const count = beatCounts.get(beat) ?? 0;
    if (count === 0) return score + 60 + Math.max(0, priority);
    if (count === 1) return score + 30 + Math.max(0, priority);
    return score;
  }, 0);
  const regionScore = coveredRegions.has(source.countryOrRegion) ? 0 : 18;
  const acceptedRateScore = Math.round((health?.acceptedRate ?? 0.5) * 20);
  const failurePenalty = Math.min(60, (health?.consecutiveFailures ?? 0) * 15);

  return (
    uncoveredBeatScore +
    regionScore +
    mediaRoleScore[source.mediaType] +
    Math.round(source.defaultWeight * 10) +
    acceptedRateScore -
    failurePenalty
  );
}

function sourceDueAt(state: SourceHealthState | undefined, defaultIntervalMinutes: number): number {
  if (!state) return Number.NEGATIVE_INFINITY;

  const explicitNextDueAt = parseDate(state.nextDueAt);
  if (explicitNextDueAt !== undefined) return explicitNextDueAt;

  const lastAttemptAt = parseDate(state.lastAttemptAt);
  if (lastAttemptAt === undefined) return Number.NEGATIVE_INFINITY;

  const intervalMinutes = positiveNumber(state.intervalMinutes) ?? defaultIntervalMinutes;
  return lastAttemptAt + intervalMinutes * 60_000;
}

function parseDate(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function positiveNumber(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
}
