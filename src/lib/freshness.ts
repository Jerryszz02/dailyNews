export type FreshnessStatus = "fresh" | "stale" | "degraded" | "unavailable";

export const defaultStaleAfterMinutes = 30;

export interface FreshnessReport {
  generatedAt?: string | null;
  stories?: Array<{
    publishedAt?: string | null;
    updatedAt?: string | null;
    evidence?: Array<{ publishedAt?: string | null }>;
  }>;
  items?: Array<{
    publishedAt?: string | null;
    extractedAt?: string | null;
  }>;
}

export interface FreshnessInput {
  report?: FreshnessReport | null;
  dataAsOf?: string | null;
  lastAttemptAt?: string | null;
  lastSuccessAt?: string | null;
  lastError?: string | null;
  staleAfterMinutes?: number;
}

export interface FreshnessResult {
  status: FreshnessStatus;
  dataAsOf: string | null;
  newestContentAt: string | null;
  ageMinutes: number | null;
  staleAfterMinutes: number;
}

export function evaluateFreshness(input: FreshnessInput, now: Date): FreshnessResult {
  const staleAfterMinutes = positiveNumber(input.staleAfterMinutes) ?? defaultStaleAfterMinutes;
  const newestContentAt = input.report ? findNewestContentAt(input.report) : null;
  const dataAsOfTimestamp = validTimestamp(input.dataAsOf) ?? validTimestamp(input.report?.generatedAt);

  if (!input.report || dataAsOfTimestamp === undefined) {
    return {
      status: "unavailable",
      dataAsOf: null,
      newestContentAt,
      ageMinutes: null,
      staleAfterMinutes,
    };
  }

  const ageMinutes = Math.max(0, (now.getTime() - dataAsOfTimestamp) / 60_000);
  const status: FreshnessStatus =
    ageMinutes > staleAfterMinutes
      ? "stale"
      : latestAttemptFailed(input, dataAsOfTimestamp)
        ? "degraded"
        : "fresh";

  return {
    status,
    dataAsOf: new Date(dataAsOfTimestamp).toISOString(),
    newestContentAt,
    ageMinutes,
    staleAfterMinutes,
  };
}

export function findNewestContentAt(report: FreshnessReport): string | null {
  const timestamps = [
    ...(report.stories ?? []).flatMap((story) => [
      story.publishedAt,
      story.updatedAt,
      ...(story.evidence ?? []).map((evidence) => evidence.publishedAt),
    ]),
    ...(report.items ?? []).map((item) => item.publishedAt),
  ]
    .map(validTimestamp)
    .filter((timestamp): timestamp is number => timestamp !== undefined);

  return timestamps.length > 0 ? new Date(Math.max(...timestamps)).toISOString() : null;
}

function latestAttemptFailed(input: FreshnessInput, dataAsOfTimestamp: number): boolean {
  if (!input.lastError?.trim()) return false;
  const lastAttemptAt = validTimestamp(input.lastAttemptAt);
  return lastAttemptAt === undefined || lastAttemptAt >= dataAsOfTimestamp;
}

function validTimestamp(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function positiveNumber(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
}
