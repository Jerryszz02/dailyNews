import { gunzipSync, gzipSync } from "node:zlib";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { compactDailyNewsReport, hydrateWebDailyNewsReport, isWebDailyNewsReport } from "../src/lib/webReport.js";
import type { DailyNewsReport, RawNewsItem } from "../src/types";
import type {
  AcquireRefreshInput,
  CompleteWithoutPublishResult,
  LeaseIdentity,
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
const readAttemptTimeoutMs = 4_000;
const writeAttemptTimeoutMs = 8_000;
const storedReportEncoding = "gzip-base64";
const maxStoredReportBytes = 10_000_000;

export class SupabaseNewsStore implements NewsStore {
  readonly kind = "supabase" as const;
  readonly persistent = true;

  constructor(private readonly client: SupabaseClient) {}

  async readState(): Promise<NewsStoreState> {
    const [latestData, sourceData] = await Promise.all([
      this.readRpc("daily_news_read_latest"),
      this.readRpc("daily_news_list_source_states"),
    ]);
    const latest = firstRow(latestData);
    const report = readStoredReport(latest?.payload);

    return {
      latest:
        latest && typeof latest.report_id === "string" && report
          ? {
              reportId: latest.report_id,
              report,
              contentHash: readNullableString(latest.content_hash) ?? undefined,
              dataAsOf: readTimestamp(latest.data_as_of) ?? readTimestamp(latest.generated_at)!,
              newestContentAt: readTimestamp(latest.newest_content_at),
              publishedAt: readTimestamp(latest.published_at) ?? readTimestamp(latest.generated_at)!,
            }
          : null,
      runtime: {
        lastAttemptAt: readTimestamp(latest?.last_attempt_at),
        lastSuccessAt: readTimestamp(latest?.last_success_at),
        lastErrorCode: readNullableString(latest?.last_error_code),
      },
      sources: rows(sourceData).map(readSourceState),
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
    const row = requiredFirstRow(
      await this.rpc("daily_news_try_acquire_refresh", {
        lease_owner: input.ownerId,
        idempotency_key: input.idempotencyKey,
        trigger_kind: input.trigger,
        scheduled_at: input.scheduledAt,
        lease_seconds: input.leaseSeconds,
      }),
      "refresh_lease_missing",
    );
    const outcome = readString(row.outcome);
    return {
      acquired: Boolean(row.acquired),
      outcome: outcome === "duplicate" || outcome === "busy" ? outcome : "acquired",
      runId: readString(row.run_id),
      ownerId: input.ownerId,
      fencingToken: readNumber(row.fencing_token),
      leaseExpiresAt: readTimestamp(row.lease_expires_at),
    };
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

  async readRecentCandidates(since: string, limit = 2_000): Promise<RawNewsItem[]> {
    const candidates: RawNewsItem[] = [];
    let offset = 0;
    while (offset < limit) {
      const pageLimit = Math.min(candidatePageSize, limit - offset);
      const data = await this.readRpcRange(
        "daily_news_read_candidates",
        { since, candidate_limit: limit },
        offset,
        offset + pageLimit - 1,
      );
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

  async commitRefresh(
    input: PublishRefreshInput,
    sourceResults: SourceCollectionResult[],
    candidates: RawNewsItem[],
  ): Promise<PublishRefreshResult> {
    return readPublishRefreshResult(
      requiredFirstRow(
        await this.rpc("daily_news_commit_refresh", {
          ...publishRefreshArgs(input),
          source_results: sourceResultsPayload(sourceResults),
          candidates: candidatesPayload(candidates),
        }),
        "commit_result_missing",
      ),
    );
  }

  async publishRefresh(input: PublishRefreshInput): Promise<PublishRefreshResult> {
    return readPublishRefreshResult(
      requiredFirstRow(
        await this.rpc("daily_news_publish_refresh", publishRefreshArgs(input)),
        "publish_result_missing",
      ),
    );
  }

  async completeRefreshWithoutPublish(
    lease: LeaseIdentity,
    metrics: Record<string, unknown>,
  ): Promise<CompleteWithoutPublishResult> {
    const row = requiredFirstRow(
      await this.rpc("daily_news_complete_refresh_without_publish", {
        lease_owner: lease.ownerId,
        run_id: lease.runId,
        fencing_token: lease.fencingToken,
        run_metrics: metrics,
      }),
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
    success: result.status !== "failed",
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
    discovered_at: candidate.extractedAt,
    language: candidate.language,
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
    reportId: readNullableString(row.published_report_id),
    previousReportId: readNullableString(row.previous_report_id),
    lastSuccessAt: readTimestamp(row.last_success_at),
  };
}

function readStoredReport(value: unknown): DailyNewsReport | null {
  if (isDailyNewsReport(value)) return value;
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
    if (isDailyNewsReport(decoded)) return decoded;
    return isWebDailyNewsReport(decoded) ? hydrateWebDailyNewsReport(decoded) : null;
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
