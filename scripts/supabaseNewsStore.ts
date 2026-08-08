import { gunzipSync, gzipSync } from "node:zlib";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { compactDailyNewsReport, hydrateWebDailyNewsReport, isWebDailyNewsReport } from "../src/lib/webReport.js";
import type { DailyNewsReport, RawNewsItem } from "../src/types";
import { normalizeV2Report, validateReportInvariants } from "./reportStore.js";
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
  RefreshLease,
  SourceCollectionResult,
  SourceDefinition,
} from "./newsStore.js";

type DatabaseRow = Record<string, unknown>;
const candidatePageSize = 1_000;
const readRetryDelaysMs = [250, 750] as const;
const reconciliationPollDelaysMs = [0, 250, 750] as const;
const readAttemptTimeoutMs = 4_000;
const writeAttemptTimeoutMs = 8_000;
const storedReportEncoding = "gzip-base64";
const maxStoredReportBytes = 10_000_000;

export class SupabaseNewsStore implements NewsStore {
  readonly kind = "supabase" as const;
  readonly persistent = true;

  constructor(private readonly client: SupabaseClient) {}

  async readState(): Promise<NewsStoreState> {
    const [publication, sourceData] = await Promise.all([
      this.readPublicationState(),
      this.readRpc("daily_news_list_source_states").catch(() => []),
    ]);
    return { ...publication, sources: rows(sourceData).map(readSourceState) };
  }

  async readPublicationState(): Promise<NewsStoreState> {
    const latestData = await this.readRpc("daily_news_read_latest");
    const latestPointer = firstRow(latestData);
    let selectedSnapshot = latestPointer;
    let report = readStoredReport(selectedSnapshot?.payload);
    let snapshotFallbackUsed = false;
    if (!report && typeof latestPointer?.report_id === "string") {
      try {
        const fallbackRows = rows(await this.readRpc("daily_news_read_snapshot_fallbacks", {
          starting_report_id: latestPointer.report_id,
          max_depth: 10,
        }));
        for (const fallback of fallbackRows) {
          const candidateReport = readStoredReport(fallback.payload);
          if (!candidateReport) continue;
          selectedSnapshot = fallback;
          report = candidateReport;
          snapshotFallbackUsed = fallback.report_id !== latestPointer.report_id;
          break;
        }
      } catch {
        // The caller can still serve the bundled last-known-good report.
      }
    }
    const storedErrorCode = readNullableString(latestPointer?.last_error_code);
    const lastErrorCode = storedErrorCode ?? (snapshotFallbackUsed ? "latest_snapshot_invalid" : null);

    return {
      latest:
        selectedSnapshot && typeof selectedSnapshot.report_id === "string" && report
          ? {
              reportId: selectedSnapshot.report_id,
              report,
              contentHash: readNullableString(selectedSnapshot.content_hash) ?? undefined,
              dataAsOf: readTimestamp(selectedSnapshot.data_as_of) ?? readTimestamp(selectedSnapshot.generated_at)!,
              newestContentAt: readTimestamp(selectedSnapshot.newest_content_at),
              publishedAt: readTimestamp(selectedSnapshot.published_at) ?? readTimestamp(selectedSnapshot.generated_at)!,
            }
          : null,
      runtime: {
        lastAttemptAt: readTimestamp(latestPointer?.last_attempt_at),
        lastSuccessAt: readTimestamp(latestPointer?.last_success_at),
        lastErrorCode,
        lastOutcomeCode: lastErrorCode ? "failed" : readOutcomeCode(latestPointer?.last_outcome_code),
        enabledSourceCount: readOptionalNumber(latestPointer?.enabled_source_count),
        recentlyAttemptedSourceCount: readOptionalNumber(latestPointer?.recently_attempted_source_count),
        lastFullSweepAt: readTimestamp(latestPointer?.last_full_sweep_at),
        publicationStateAt: readTimestamp(latestPointer?.publication_state_at),
      },
      sources: [],
    };
  }

  async syncSources(lease: LeaseIdentity, sources: SourceDefinition[], observedAt: string): Promise<void> {
    await this.rpc("daily_news_sync_sources", {
      lease_owner: lease.ownerId,
      run_id: lease.runId,
      fencing_token: lease.fencingToken,
      sources: sources.map((source) => ({
        source_id: source.sourceId,
        enabled: source.enabled,
        interval_minutes: source.intervalMinutes,
      })),
      observed_at: observedAt,
    });
  }

  async tryAcquireRefresh(input: AcquireRefreshInput): Promise<RefreshLease> {
    const args = {
      lease_owner: input.ownerId,
      idempotency_key: input.idempotencyKey,
      trigger_kind: input.trigger,
      scheduled_at: input.scheduledAt,
      lease_seconds: input.leaseSeconds,
    };
    try {
      return readRefreshLease(
        requiredFirstRow(await this.rpc("daily_news_try_acquire_refresh_v2", args), "refresh_lease_missing"),
        input.ownerId,
      );
    } catch (error) {
      const reconciled = await this.reconcileAcquire(input);
      if (reconciled) return reconciled;
      throw error;
    }
  }

  async renewRefresh(lease: LeaseIdentity, leaseSeconds: number): Promise<boolean> {
    const row = firstRow(
      await this.rpc("daily_news_renew_refresh", {
        lease_owner: lease.ownerId,
        run_id: lease.runId,
        fencing_token: lease.fencingToken,
        lease_seconds: leaseSeconds,
      }),
    );
    return Boolean(row?.renewed);
  }

  async recordSourceResults(lease: LeaseIdentity, results: SourceCollectionResult[]): Promise<void> {
    await this.rpc("daily_news_record_source_results", {
      lease_owner: lease.ownerId,
      run_id: lease.runId,
      fencing_token: lease.fencingToken,
      results: sourceResultsPayload(results),
    });
  }

  async upsertCandidates(lease: LeaseIdentity, candidates: RawNewsItem[]): Promise<number> {
    const data = await this.rpc("daily_news_upsert_candidates", {
      lease_owner: lease.ownerId,
      run_id: lease.runId,
      fencing_token: lease.fencingToken,
      candidates: candidatesPayload(candidates),
    });
    return readNumber(firstRow(data)?.upserted_count);
  }

  async readRecentCandidates(since: string, limit?: number): Promise<RawNewsItem[]> {
    try {
      return await this.readRecentCandidatesV2(since, limit);
    } catch (error) {
      if (!(error instanceof NewsStoreError) || error.code !== "supabase_rpc_missing") throw error;
      return this.readRecentCandidatesLegacy(since, limit);
    }
  }

  private async readRecentCandidatesV2(since: string, limit?: number): Promise<RawNewsItem[]> {
    const candidates: RawNewsItem[] = [];
    let offset = 0;
    while (limit === undefined || offset < limit) {
      const pageLimit = Math.min(candidatePageSize, limit === undefined ? candidatePageSize : limit - offset);
      const data = await this.readRpc("daily_news_read_candidates_v2", {
        since,
        page_limit: pageLimit,
        page_offset: offset,
      });
      const pageRows = rows(data);
      const page = pageRows
        .map((row) => row.payload ?? row.candidate ?? row)
        .filter(isRecord) as unknown as RawNewsItem[];
      candidates.push(...page);
      offset += pageRows.length;
      if (pageRows.length < pageLimit) break;
    }
    return candidates;
  }

  private async readRecentCandidatesLegacy(since: string, limit?: number): Promise<RawNewsItem[]> {
    const legacyLimit = Math.min(limit ?? 5_000, 5_000);
    const candidates: RawNewsItem[] = [];
    let offset = 0;
    while (offset < legacyLimit) {
      const pageLimit = Math.min(candidatePageSize, legacyLimit - offset);
      const data = await this.readRpcRange(
        "daily_news_read_candidates",
        { since, candidate_limit: legacyLimit },
        offset,
        offset + pageLimit - 1,
      );
      const pageRows = rows(data);
      candidates.push(...pageRows
        .map((row) => row.payload ?? row.candidate ?? row)
        .filter(isRecord) as unknown as RawNewsItem[]);
      offset += pageRows.length;
      if (pageRows.length < pageLimit) break;
    }
    if (limit === undefined && candidates.length === 5_000) {
      throw new NewsStoreError("candidate_window_incomplete");
    }
    return candidates;
  }

  async commitRefresh(
    input: PublishRefreshInput,
    sourceResults: SourceCollectionResult[],
    candidates: RawNewsItem[],
  ): Promise<PublishRefreshResult> {
    const args = {
      ...publishRefreshArgs(input),
      source_results: sourceResultsPayload(sourceResults),
      candidates: candidatesPayload(candidates),
      refresh_outcome: input.metrics.outcome === "partial" ? "partial" : "published",
    };
    try {
      return readPublishRefreshResult(
        requiredFirstRow(await this.rpc("daily_news_finish_refresh_v2", args), "commit_result_missing"),
      );
    } catch (error) {
      const reconciled = await this.reconcileRefresh(input.runId);
      if (reconciled) return reconciled;
      throw error;
    }
  }

  async publishRefresh(input: PublishRefreshInput): Promise<PublishRefreshResult> {
    try {
      return readPublishRefreshResult(
        requiredFirstRow(
          await this.rpc("daily_news_publish_refresh", publishRefreshArgs(input)),
          "publish_result_missing",
        ),
      );
    } catch (error) {
      const reconciled = await this.reconcileRefresh(input.runId);
      if (reconciled) return reconciled;
      throw error;
    }
  }

  async completeRefreshWithoutPublish(
    lease: LeaseIdentity,
    metrics: Record<string, unknown>,
    sourceResults: SourceCollectionResult[] = [],
    candidates: RawNewsItem[] = [],
  ): Promise<CompleteWithoutPublishResult> {
    const refreshOutcome = metrics.outcome === "partial" ? "partial" : "unchanged";
    let data: unknown;
    try {
      data = await this.rpc("daily_news_finish_without_publish_v2", {
        lease_owner: lease.ownerId,
        run_id: lease.runId,
        fencing_token: lease.fencingToken,
        source_results: sourceResultsPayload(sourceResults),
        candidates: candidatesPayload(candidates),
        run_metrics: metrics,
        refresh_outcome: refreshOutcome,
      });
    } catch (error) {
      const reconciled = await this.reconcileRefresh(lease.runId);
      if (reconciled && !reconciled.published) {
        return {
          completed: true,
          lastAttemptAt: reconciled.lastSuccessAt,
          lastSuccessAt: reconciled.lastSuccessAt,
        };
      }
      throw error;
    }
    const row = requiredFirstRow(
      data,
      "complete_result_missing",
    );
    return {
      completed: Boolean(row.completed),
      lastAttemptAt: readTimestamp(row.last_attempt_at),
      lastSuccessAt: readTimestamp(row.last_success_at),
    };
  }

  async markRefreshFailed(lease: LeaseIdentity, errorCode: string, metrics: Record<string, unknown> = {}): Promise<void> {
    await this.rpc("daily_news_mark_refresh_failed", {
      lease_owner: lease.ownerId,
      run_id: lease.runId,
      fencing_token: lease.fencingToken,
      error_code: errorCode,
      run_metrics: metrics,
    });
  }

  async rollbackLatest(reportId: string, reasonCode: string) {
    await this.rpc("daily_news_rollback_latest", { target_report_id: reportId, reason_code: reasonCode });
    const state = await this.readState();
    if (!state.latest || state.latest.reportId !== reportId) throw new NewsStoreError("rollback_not_visible");
    return state.latest;
  }

  private async rpc(name: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<unknown> {
    const operation = async (requestSignal?: AbortSignal) => {
      try {
        const request = this.client.rpc(name, args);
        const { data, error } = requestSignal && typeof request.abortSignal === "function"
          ? await request.abortSignal(requestSignal)
          : await request;
        if (error) throw new NewsStoreError(normalizeSupabaseError(error.code), error.code);
        return data;
      } catch (error) {
        if (error instanceof NewsStoreError) throw error;
        throw new NewsStoreError("supabase_request_failed");
      }
    };
    return signal ? operation(signal) : runWriteAttempt(operation);
  }

  private async readRpc(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    return this.retryRead((signal) => this.rpc(name, args, signal));
  }

  private async readRpcRange(name: string, args: Record<string, unknown>, from: number, to: number): Promise<unknown> {
    return this.retryRead((signal) => this.rpcRange(name, args, from, to, signal));
  }

  private async retryRead(operation: (signal: AbortSignal) => Promise<unknown>): Promise<unknown> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await runReadAttempt(operation);
      } catch (error) {
        if (!isRetryableReadError(error) || attempt >= readRetryDelaysMs.length) {
          throw error;
        }
        await delay(readRetryDelaysMs[attempt]);
      }
    }
  }

  private async rpcRange(
    name: string,
    args: Record<string, unknown>,
    from: number,
    to: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    try {
      const request = this.client.rpc(name, args).range(from, to);
      const { data, error } = signal && typeof request.abortSignal === "function"
        ? await request.abortSignal(signal)
        : await request;
      if (error) throw new NewsStoreError(normalizeSupabaseError(error.code), error.code);
      return data;
    } catch (error) {
      if (error instanceof NewsStoreError) throw error;
      throw new NewsStoreError("supabase_request_failed");
    }
  }

  private async reconcileRefresh(runId: string): Promise<PublishRefreshResult | null> {
    for (const pollDelayMs of reconciliationPollDelaysMs) {
      if (pollDelayMs > 0) await delay(pollDelayMs);
      try {
        const row = firstRow(await this.readRpc("daily_news_read_refresh_result", { target_run_id: runId }));
        if (
          row &&
          (row.status === "published" || row.status === "completed") &&
          readPublishOutcome(row.outcome)
        ) {
          return readPublishRefreshResult(row);
        }
      } catch {
        // A timed-out write may still be committing; retry only this idempotent read.
      }
    }
    return null;
  }

  private async reconcileAcquire(input: AcquireRefreshInput): Promise<RefreshLease | null> {
    for (const pollDelayMs of reconciliationPollDelaysMs) {
      if (pollDelayMs > 0) await delay(pollDelayMs);
      try {
        const row = firstRow(await this.readRpc("daily_news_read_acquire_result", {
          target_idempotency_key: input.idempotencyKey,
          expected_owner: input.ownerId,
        }));
        if (row) return readRefreshLease(row, input.ownerId);
      } catch {
        // The acquisition may still be committing; retry only the read by idempotency key.
      }
    }
    return null;
  }

}

function storeReport(report: DailyNewsReport): DatabaseRow {
  return {
    storageView: 2,
    encoding: storedReportEncoding,
    data: gzipSync(JSON.stringify(compactDailyNewsReport(report))).toString("base64"),
  };
}

function sourceResultsPayload(results: SourceCollectionResult[]): DatabaseRow[] {
  return results.map((result) => ({
    source_id: result.sourceId,
    status: result.status,
    success: result.status === "success" || result.status === "empty",
    attempted_at: result.attemptedAt,
    next_due_at: result.nextDueAt,
    discovered_count: result.discoveredCount,
    accepted_count: result.acceptedCount,
    last_error_code: result.errorCode,
  }));
}

function candidatesPayload(candidates: RawNewsItem[]): DatabaseRow[] {
  return candidates.map((candidate) => ({
    source_id: candidate.sourceId,
    canonical_url: canonicalUrl(candidate.url),
    title: candidate.title,
    summary: candidate.summary,
    published_at: candidate.publishedAt,
    updated_at: candidate.updatedAt,
    discovered_at: candidate.discoveredAt ?? candidate.extractedAt,
    language: candidate.language,
    quality_status: "accepted",
    rejection_reasons: candidate.rejectionReasons ?? [],
    payload: candidate,
  }));
}

function publishRefreshArgs(input: PublishRefreshInput): DatabaseRow {
  return {
    lease_owner: input.ownerId,
    run_id: input.runId,
    fencing_token: input.fencingToken,
    report_id: input.reportId,
    generated_at: input.report.generatedAt,
    schema_version: String(input.report.version),
    payload: storeReport(input.report),
    data_as_of: input.dataAsOf,
    newest_content_at: input.newestContentAt,
    content_hash: input.contentHash,
    input_fingerprint: input.inputFingerprint,
    run_metrics: input.metrics,
  };
}

function readPublishRefreshResult(row: DatabaseRow): PublishRefreshResult {
  return {
    published: typeof row.published_report_id === "string",
    outcome: readPublishOutcome(row.outcome),
    reportId: readNullableString(row.published_report_id),
    previousReportId: readNullableString(row.previous_report_id),
    lastSuccessAt: readTimestamp(row.last_success_at),
  };
}

function readRefreshLease(row: DatabaseRow, ownerId: string): RefreshLease {
  const outcome = readString(row.outcome);
  return {
    acquired: Boolean(row.acquired),
    outcome: outcome === "duplicate" || outcome === "busy" ? outcome : "acquired",
    runId: readString(row.run_id),
    ownerId,
    fencingToken: readNumber(row.fencing_token),
    leaseExpiresAt: readTimestamp(row.lease_expires_at),
  };
}

function readPublishOutcome(value: unknown): "published" | "unchanged" | "partial" | undefined {
  return value === "published" || value === "unchanged" || value === "partial" ? value : undefined;
}

function readOutcomeCode(value: unknown): NewsRuntimeState["lastOutcomeCode"] {
  return value === "published" || value === "unchanged" || value === "partial" || value === "failed"
    ? value
    : null;
}

function readStoredReport(value: unknown): DailyNewsReport | null {
  if (isDailyNewsReport(value)) return validateStoredReport(value);
  if (
    !isRecord(value) ||
    (value.storageView !== 1 && value.storageView !== 2) ||
    value.encoding !== storedReportEncoding ||
    typeof value.data !== "string"
  ) {
    return null;
  }

  try {
    const decoded: unknown = JSON.parse(
      gunzipSync(Buffer.from(value.data, "base64"), { maxOutputLength: maxStoredReportBytes }).toString("utf8"),
    );
    if (isDailyNewsReport(decoded)) return validateStoredReport(decoded);
    return isWebDailyNewsReport(decoded) ? validateStoredReport(hydrateWebDailyNewsReport(decoded)) : null;
  } catch {
    return null;
  }
}

function validateStoredReport(report: DailyNewsReport): DailyNewsReport | null {
  try {
    const normalized = normalizeV2Report(report);
    return validateReportInvariants(normalized).length === 0 ? normalized : null;
  } catch {
    return null;
  }
}

function isDailyNewsReport(value: unknown): value is DailyNewsReport {
  if (!isRecord(value)) return false;
  return (
    value.version === 2 &&
    typeof value.generatedAt === "string" &&
    Array.isArray(value.items) &&
    Array.isArray(value.stories) &&
    Array.isArray(value.topStories) &&
    Array.isArray(value.importantStories) &&
    Array.isArray(value.watchlist) &&
    Array.isArray(value.sections) &&
    isRecord(value.coverage) &&
    isRecord(value.quality)
  );
}

export function createSupabaseNewsStore(url: string, secretKey: string): SupabaseNewsStore {
  const client = createClient(url, secretKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  return new SupabaseNewsStore(client);
}

export class NewsStoreError extends Error {
  constructor(readonly code: string, readonly sourceCode?: string) {
    super(code);
    this.name = "NewsStoreError";
  }
}

function rows(value: unknown): DatabaseRow[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  return isRecord(value) ? [value] : [];
}

function firstRow(value: unknown): DatabaseRow | null {
  return rows(value)[0] ?? null;
}

function requiredFirstRow(value: unknown, code: string): DatabaseRow {
  const row = firstRow(value);
  if (!row) throw new NewsStoreError(code);
  return row;
}

function readSourceState(row: DatabaseRow): NewsSourceState {
  return {
    sourceId: readString(row.source_id),
    enabled: typeof row.enabled === "boolean" ? row.enabled : undefined,
    lastAttemptAt: readTimestamp(row.last_attempt_at),
    lastSuccessAt: readTimestamp(row.last_success_at),
    nextDueAt: readTimestamp(row.next_due_at),
    intervalMinutes: Math.max(1, readNumber(row.interval_minutes) || 15),
    consecutiveFailures: Math.max(0, readNumber(row.consecutive_failures)),
    acceptedRate: typeof row.accepted_rate === "number" ? row.accepted_rate : undefined,
    circuitOpenUntil: readTimestamp(row.circuit_open_until),
    lastErrorCode: readNullableString(row.last_error_code),
  };
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readNullableString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function readNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function readOptionalNumber(value: unknown): number | undefined {
  return value === null || value === undefined ? undefined : readNumber(value);
}

function readTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return value;
}

function isRecord(value: unknown): value is DatabaseRow {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeSupabaseError(code: string | undefined): string {
  if (!code) return "supabase_request_failed";
  if (code === "PGRST202" || code === "42883") return "supabase_rpc_missing";
  if (code === "42501") return "supabase_permission_denied";
  if (code === "23505") return "supabase_conflict";
  return "supabase_request_failed";
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

async function runReadAttempt(operation: (signal: AbortSignal) => Promise<unknown>): Promise<unknown> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new NewsStoreError("supabase_request_failed", "read_timeout"));
        }, readAttemptTimeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function runWriteAttempt(operation: (signal: AbortSignal) => Promise<unknown>): Promise<unknown> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new NewsStoreError("supabase_request_failed", "write_timeout"));
          controller.abort();
        }, writeAttemptTimeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function isRetryableReadError(error: unknown): error is NewsStoreError {
  if (!(error instanceof NewsStoreError) || error.code !== "supabase_request_failed") return false;
  const sourceCode = error.sourceCode?.toUpperCase();
  if (!sourceCode || sourceCode === "READ_TIMEOUT") return true;
  if (/^(08|53)/.test(sourceCode)) return true;
  // PGRST303 was observed transiently on an opaque-key read; writes never use this retry path.
  return [
    "40001",
    "40P01",
    "57014",
    "57P01",
    "57P02",
    "57P03",
    "PGRST000",
    "PGRST001",
    "PGRST002",
    "PGRST003",
    "PGRST303",
  ].includes(sourceCode);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
