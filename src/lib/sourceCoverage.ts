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
  circuitOpenUntil?: string;
}

export interface CoverageSelectionOptions {
  health?: SourceHealthState[];
  now?: Date;
}

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
  if (maxSources >= available.length) return available;

  const selected: NewsSource[] = [];
  const beatCounts = new Map<Category, number>();
  const coveredRegions = new Set<string>();

  while (selected.length < maxSources) {
    const candidate = available
      .filter((source) => !selected.includes(source))
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
  return Array.from(new Set(source.sections.map((section) => section.primaryCategory)));
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
  const collectionCostScore = source.language.startsWith("zh") ? 30 : -10;

  return (
    uncoveredBeatScore +
    regionScore +
    mediaRoleScore[source.mediaType] +
    source.credibility +
    Math.round(source.defaultWeight * 10) +
    collectionCostScore +
    acceptedRateScore -
    failurePenalty
  );
}

function isCircuitOpen(state: SourceHealthState | undefined, now: Date): boolean {
  if (!state?.circuitOpenUntil) return false;
  const until = Date.parse(state.circuitOpenUntil);
  return Number.isFinite(until) && until > now.getTime();
}
