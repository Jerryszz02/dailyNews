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
    updatedAt?: string | null;
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
  pipelineStatus: "healthy" | "degraded" | "failed";
  contentStatus: "current" | "quiet" | "stale" | "unknown";
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
      pipelineStatus: "failed",
      contentStatus: "unknown",
      dataAsOf: null,
      newestContentAt,
      ageMinutes: null,
      staleAfterMinutes,
    };
  }

  const ageMinutes = Math.max(0, (now.getTime() - dataAsOfTimestamp) / 60_000);
  const lastCheckedAt = validTimestamp(input.lastAttemptAt) ?? validTimestamp(input.lastSuccessAt);
  const recentlyChecked =
    lastCheckedAt !== undefined && Math.max(0, (now.getTime() - lastCheckedAt) / 60_000) <= staleAfterMinutes;
  const contentTimestamp = validTimestamp(newestContentAt);
  const contentAgeMinutes =
    contentTimestamp === undefined ? null : Math.max(0, (now.getTime() - contentTimestamp) / 60_000);
  const latestAttemptIsFailed = latestAttemptFailed(input, dataAsOfTimestamp);
  const status: FreshnessStatus =
    ageMinutes > staleAfterMinutes
      ? "stale"
      : latestAttemptIsFailed
        ? "degraded"
        : "fresh";

  return {
    status,
    pipelineStatus: latestAttemptIsFailed ? "degraded" : "healthy",
    contentStatus:
      contentAgeMinutes === null
        ? recentlyChecked ? "quiet" : "unknown"
        : contentAgeMinutes <= staleAfterMinutes
          ? "current"
          : recentlyChecked ? "quiet" : "stale",
    dataAsOf: new Date(dataAsOfTimestamp).toISOString(),
    newestContentAt,
    ageMinutes,
    staleAfterMinutes,
  };
}

export function findNewestContentAt(report: FreshnessReport): string | null {
  const timestamps = [
    ...(report.stories ?? []).map((story) => story.updatedAt),
    ...(report.items ?? []).map((item) => item.updatedAt),
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
