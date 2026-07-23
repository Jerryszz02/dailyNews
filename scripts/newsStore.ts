import type { DailyNewsReport, RawNewsItem } from "../src/types";

export type NewsStoreKind = "memory" | "supabase";
export type RefreshTrigger = "cron" | "manual" | "local";
export type SourceResultStatus = "success" | "empty" | "failed";

export interface PublishedNewsReport {
  reportId: string;
  report: DailyNewsReport;
  contentHash?: string;
  dataAsOf: string;
  newestContentAt: string | null;
  publishedAt: string;
}

export interface NewsRuntimeState {
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastErrorCode: string | null;
}

export interface NewsSourceState {
  sourceId: string;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  nextDueAt: string | null;
  intervalMinutes: number;
  consecutiveFailures: number;
  acceptedRate?: number;
  circuitOpenUntil: string | null;
  lastErrorCode: string | null;
}

export interface NewsStoreState {
  latest: PublishedNewsReport | null;
  runtime: NewsRuntimeState;
  sources: NewsSourceState[];
}

export interface SourceDefinition {
  sourceId: string;
  enabled: boolean;
  intervalMinutes: number;
}

export interface SourceCollectionResult {
  sourceId: string;
  status: SourceResultStatus;
  attemptedAt: string;
  nextDueAt: string;
  discoveredCount: number;
  acceptedCount: number;
  errorCode: string | null;
}

export interface RefreshLease {
  acquired: boolean;
  outcome: "acquired" | "busy" | "duplicate";
  runId: string;
  ownerId: string;
  fencingToken: number;
  leaseExpiresAt: string | null;
}

export interface AcquireRefreshInput {
  ownerId: string;
  idempotencyKey: string;
  trigger: RefreshTrigger;
  scheduledAt: string;
  leaseSeconds: number;
}

export interface LeaseIdentity {
  ownerId: string;
  runId: string;
  fencingToken: number;
}

export interface PublishRefreshInput extends LeaseIdentity {
  reportId: string;
  report: DailyNewsReport;
  dataAsOf: string;
  newestContentAt: string | null;
  contentHash: string;
  inputFingerprint: string;
  metrics: Record<string, unknown>;
}

export interface PublishRefreshResult {
  published: boolean;
  reportId: string | null;
  previousReportId: string | null;
  lastSuccessAt: string | null;
}

export interface CompleteWithoutPublishResult {
  completed: boolean;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
}

export interface NewsStore {
  readonly kind: NewsStoreKind;
  readonly persistent: boolean;
  readState(): Promise<NewsStoreState>;
  syncSources(lease: LeaseIdentity, sources: SourceDefinition[], observedAt: string): Promise<void>;
  tryAcquireRefresh(input: AcquireRefreshInput): Promise<RefreshLease>;
  renewRefresh(lease: LeaseIdentity, leaseSeconds: number): Promise<boolean>;
  recordSourceResults(lease: LeaseIdentity, results: SourceCollectionResult[]): Promise<void>;
  upsertCandidates(lease: LeaseIdentity, candidates: RawNewsItem[]): Promise<number>;
  readRecentCandidates(since: string, limit?: number): Promise<RawNewsItem[]>;
  publishRefresh(input: PublishRefreshInput): Promise<PublishRefreshResult>;
  completeRefreshWithoutPublish(
    lease: LeaseIdentity,
    metrics: Record<string, unknown>,
  ): Promise<CompleteWithoutPublishResult>;
  markRefreshFailed(lease: LeaseIdentity, errorCode: string, metrics?: Record<string, unknown>): Promise<void>;
  rollbackLatest(reportId: string, reasonCode: string): Promise<PublishedNewsReport>;
}

export function newestContentTimestamp(report: DailyNewsReport): string | null {
  const timestamps = [
    ...report.items.map((item) => item.publishedAt),
    ...report.stories.flatMap((story) => [
      story.publishedAt,
      story.updatedAt,
      ...story.evidence.map((evidence) => evidence.publishedAt),
    ]),
  ]
    .filter((value): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)))
    .sort((left, right) => Date.parse(right) - Date.parse(left));
  return timestamps[0] ?? null;
}
