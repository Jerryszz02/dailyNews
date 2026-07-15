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
}

export const defaultSourceIntervalMinutes = 90;

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
  const available = sources.filter((source) => source.enabled && !isCircuitOpen(healthById.get(source.source_id), now));
  const defaultIntervalMinutes = positiveNumber(options.defaultIntervalMinutes) ?? defaultSourceIntervalMinutes;
  const candidates =
    options.health === undefined
      ? available
      : available.filter((source) => sourceDueAt(healthById.get(source.source_id), defaultIntervalMinutes) <= now.getTime());
  if (options.health === undefined && maxSources >= candidates.length) return candidates;

  const selected: NewsSource[] = [];
  const beatCounts = new Map<Category, number>();
  const coveredRegions = new Set<string>();

  while (selected.length < Math.min(maxSources, candidates.length)) {
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
    source.credibility +
    Math.round(source.defaultWeight * 10) +
    acceptedRateScore -
    failurePenalty
  );
}

function isCircuitOpen(state: SourceHealthState | undefined, now: Date): boolean {
  if (!state?.circuitOpenUntil) return false;
  const until = Date.parse(state.circuitOpenUntil);
  return Number.isFinite(until) && until > now.getTime();
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
