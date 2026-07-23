import { createHash, randomUUID } from "node:crypto";
import type { DailyNewsReport, RawNewsItem } from "../src/types";
import { passesPublishGate } from "./reportStore.js";
import type {
  AcquireRefreshInput,
  CompleteWithoutPublishResult,
  LeaseIdentity,
  NewsRuntimeState,
  NewsSourceState,
  NewsStore,
  NewsStoreState,
  PublishRefreshInput,
  PublishRefreshResult,
  PublishedNewsReport,
  RefreshLease,
  SourceCollectionResult,
  SourceDefinition,
} from "./newsStore.js";
import { newestContentTimestamp } from "./newsStore.js";

interface ActiveLease {
  ownerId: string;
  runId: string;
  fencingToken: number;
  expiresAt: number;
}

interface MemoryRun {
  runId: string;
  status: "running" | "published" | "completed" | "failed";
}

export class InMemoryNewsStore implements NewsStore {
  readonly kind = "memory" as const;
  readonly persistent = false;

  private latest: PublishedNewsReport | null;
  private runtime: NewsRuntimeState;
  private sourceStates = new Map<string, NewsSourceState>();
  private candidates = new Map<string, RawNewsItem>();
  private reports = new Map<string, PublishedNewsReport>();
  private runs = new Map<string, MemoryRun>();
  private idempotencyRuns = new Map<string, string>();
  private activeLease: ActiveLease | null = null;
  private fencingToken = 0;

  constructor(
    initialReport: DailyNewsReport | null = null,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.latest = initialReport ? asPublishedReport(initialReport) : null;
    if (this.latest) this.reports.set(this.latest.reportId, this.latest);
    this.runtime = {
      lastAttemptAt: this.latest?.dataAsOf ?? null,
      lastSuccessAt: this.latest?.dataAsOf ?? null,
      lastErrorCode: null,
    };
  }

  async readState(): Promise<NewsStoreState> {
    return {
      latest: this.latest,
      runtime: { ...this.runtime },
      sources: Array.from(this.sourceStates.values(), (state) => ({ ...state })),
    };
  }

  async syncSources(lease: LeaseIdentity, sources: SourceDefinition[], observedAt: string): Promise<void> {
    this.assertLease(lease);
    for (const [sourceId, current] of this.sourceStates) {
      this.sourceStates.set(sourceId, { ...current, enabled: false });
    }
    for (const source of sources) {
      const current = this.sourceStates.get(source.sourceId);
      this.sourceStates.set(source.sourceId, {
        sourceId: source.sourceId,
        enabled: source.enabled,
        lastAttemptAt: current?.lastAttemptAt ?? null,
        lastSuccessAt: current?.lastSuccessAt ?? null,
        nextDueAt: current?.nextDueAt ?? observedAt,
        intervalMinutes: source.intervalMinutes,
        consecutiveFailures: current?.consecutiveFailures ?? 0,
        acceptedRate: current?.acceptedRate,
        circuitOpenUntil: current?.circuitOpenUntil ?? null,
        lastErrorCode: current?.lastErrorCode ?? null,
      });
    }
  }

  async tryAcquireRefresh(input: AcquireRefreshInput): Promise<RefreshLease> {
    const now = Date.parse(input.scheduledAt);
    const duplicateRunId = this.idempotencyRuns.get(input.idempotencyKey);
    const duplicateRun = duplicateRunId ? this.runs.get(duplicateRunId) : undefined;
    if (duplicateRun && duplicateRun.status !== "running" && duplicateRun.status !== "failed") {
      const activeDuplicateLease = this.activeLease?.runId === duplicateRun.runId ? this.activeLease : null;
      return {
        acquired: false,
        outcome: "duplicate",
        runId: duplicateRun.runId,
        ownerId: input.ownerId,
        fencingToken: activeDuplicateLease?.fencingToken ?? this.fencingToken,
        leaseExpiresAt: activeDuplicateLease ? new Date(activeDuplicateLease.expiresAt).toISOString() : null,
      };
    }

    if (this.activeLease && this.activeLease.expiresAt > now) {
      return {
        acquired: false,
        outcome: "busy",
        runId: this.activeLease.runId,
        ownerId: input.ownerId,
        fencingToken: this.activeLease.fencingToken,
        leaseExpiresAt: new Date(this.activeLease.expiresAt).toISOString(),
      };
    }

    if (this.activeLease && this.activeLease.runId !== duplicateRunId) {
      this.runs.set(this.activeLease.runId, { runId: this.activeLease.runId, status: "failed" });
    }

    const runId = duplicateRunId ?? randomUUID();
    this.fencingToken += 1;
    this.activeLease = {
      ownerId: input.ownerId,
      runId,
      fencingToken: this.fencingToken,
      expiresAt: now + input.leaseSeconds * 1_000,
    };
    this.idempotencyRuns.set(input.idempotencyKey, runId);
    this.runs.set(runId, { runId, status: "running" });
    this.runtime.lastAttemptAt = input.scheduledAt;

    return {
      acquired: true,
      outcome: "acquired",
      runId,
      ownerId: input.ownerId,
      fencingToken: this.fencingToken,
      leaseExpiresAt: new Date(this.activeLease.expiresAt).toISOString(),
    };
  }

  async renewRefresh(lease: LeaseIdentity, leaseSeconds: number): Promise<boolean> {
    if (!this.hasLease(lease)) return false;
    this.activeLease!.expiresAt = this.now().getTime() + leaseSeconds * 1_000;
    return true;
  }

  async recordSourceResults(lease: LeaseIdentity, results: SourceCollectionResult[]): Promise<void> {
    this.assertLease(lease);
    for (const result of results) {
      const current = this.sourceStates.get(result.sourceId);
      if (!current) continue;
      const succeeded = result.status !== "failed";
      const attempts = succeeded ? 0 : current.consecutiveFailures + 1;
      const total = Math.max(1, result.discoveredCount);
      this.sourceStates.set(result.sourceId, {
        ...current,
        lastAttemptAt: result.attemptedAt,
        lastSuccessAt: succeeded ? result.attemptedAt : current.lastSuccessAt,
        nextDueAt: result.nextDueAt,
        consecutiveFailures: attempts,
        acceptedRate: succeeded ? result.acceptedCount / total : current.acceptedRate,
        circuitOpenUntil:
          !succeeded && attempts >= 3
            ? new Date(Date.parse(result.attemptedAt) + current.intervalMinutes * 2 * 60_000).toISOString()
            : succeeded
              ? null
              : current.circuitOpenUntil,
        lastErrorCode: result.errorCode,
      });
    }
  }

  async upsertCandidates(lease: LeaseIdentity, candidates: RawNewsItem[]): Promise<number> {
    this.assertLease(lease);
    for (const candidate of candidates) {
      this.candidates.set(candidateKey(candidate), structuredClone(candidate));
    }
    return candidates.length;
  }

  async readRecentCandidates(since: string, limit = 2_000): Promise<RawNewsItem[]> {
    const sinceMs = Date.parse(since);
    return Array.from(this.candidates.values())
      .filter((candidate) => {
        const publishedAt = Date.parse(candidate.publishedAt ?? "");
        return Number.isFinite(publishedAt) && publishedAt >= sinceMs;
      })
      .sort((left, right) => Date.parse(right.publishedAt ?? "") - Date.parse(left.publishedAt ?? ""))
      .slice(0, limit)
      .map((candidate) => structuredClone(candidate));
  }

  async publishRefresh(input: PublishRefreshInput): Promise<PublishRefreshResult> {
    this.assertLease(input);
    const previous = this.latest;
    if (!passesPublishGate(input.report, previous?.report ?? null)) {
      return { published: false, reportId: null, previousReportId: previous?.reportId ?? null, lastSuccessAt: this.runtime.lastSuccessAt };
    }

    const publishedAt = this.now().toISOString();
    const stored: PublishedNewsReport = {
      reportId: input.reportId,
      report: structuredClone(input.report),
      contentHash: input.contentHash,
      dataAsOf: input.dataAsOf,
      newestContentAt: input.newestContentAt,
      publishedAt,
    };
    this.reports.set(stored.reportId, stored);
    this.latest = stored;
    this.runtime = { lastAttemptAt: input.dataAsOf, lastSuccessAt: input.dataAsOf, lastErrorCode: null };
    this.runs.set(input.runId, { runId: input.runId, status: "published" });
    this.activeLease = null;

    return {
      published: true,
      reportId: stored.reportId,
      previousReportId: previous?.reportId ?? null,
      lastSuccessAt: this.runtime.lastSuccessAt,
    };
  }

  async completeRefreshWithoutPublish(
    lease: LeaseIdentity,
    _metrics: Record<string, unknown>,
  ): Promise<CompleteWithoutPublishResult> {
    this.assertLease(lease);
    const completedAt = this.now().toISOString();
    this.runtime = { lastAttemptAt: completedAt, lastSuccessAt: completedAt, lastErrorCode: null };
    this.runs.set(lease.runId, { runId: lease.runId, status: "completed" });
    this.activeLease = null;
    return { completed: true, lastAttemptAt: completedAt, lastSuccessAt: completedAt };
  }

  async markRefreshFailed(lease: LeaseIdentity, errorCode: string): Promise<void> {
    if (!this.hasLease(lease)) return;
    this.runtime = { ...this.runtime, lastAttemptAt: this.now().toISOString(), lastErrorCode: errorCode };
    this.runs.set(lease.runId, { runId: lease.runId, status: "failed" });
    this.activeLease = null;
  }

  async rollbackLatest(reportId: string, _reasonCode: string): Promise<PublishedNewsReport> {
    const target = this.reports.get(reportId);
    if (!target) throw new Error("report_not_found");
    this.latest = target;
    return target;
  }

  private hasLease(lease: LeaseIdentity): boolean {
    return Boolean(
      this.activeLease &&
        this.activeLease.ownerId === lease.ownerId &&
        this.activeLease.runId === lease.runId &&
        this.activeLease.fencingToken === lease.fencingToken &&
        this.activeLease.expiresAt > this.now().getTime(),
    );
  }

  private assertLease(lease: LeaseIdentity): void {
    if (!this.hasLease(lease)) throw new Error("refresh_lease_invalid");
  }
}

function asPublishedReport(report: DailyNewsReport): PublishedNewsReport {
  const reportId = `bundled-${createHash("sha256").update(JSON.stringify(report)).digest("hex").slice(0, 16)}`;
  return {
    reportId,
    report,
    dataAsOf: report.generatedAt,
    newestContentAt: newestContentTimestamp(report),
    publishedAt: report.generatedAt,
  };
}

function candidateKey(candidate: RawNewsItem): string {
  return `${candidate.sourceId}\n${canonicalUrl(candidate.url)}`;
}

function canonicalUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const key of Array.from(url.searchParams.keys())) {
      if (/^(utm_|spm$|from$|source$|ref$)/i.test(key)) url.searchParams.delete(key);
    }
    url.hash = "";
    return url.toString();
  } catch {
    return value;
  }
}
