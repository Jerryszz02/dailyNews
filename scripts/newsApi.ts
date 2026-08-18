import { evaluateFreshness } from "../src/lib/freshness.js";
import { compactDailyNewsReport } from "../src/lib/webReport.js";
import type { DailyNewsReport } from "../src/types";
import { runNewsRefresh, scheduledRefreshIdempotencyKey, type NewsRefreshResult } from "./newsRefresh.js";
import {
  defaultRefreshIntervalMinutes,
  defaultSourceCoverageWindowMinutes,
  readPositiveInteger,
} from "./newsService.js";
import type { NewsStore, NewsStoreState, PublishedNewsReport } from "./newsStore.js";
import { getDefaultNewsStore, hasCompleteSupabaseConfiguration } from "./newsStoreFactory.js";
import { readBundledReport } from "./reportStore.js";

const newsJsonHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "public, max-age=0, must-revalidate",
  "Content-Type": "application/json; charset=utf-8",
  "Vercel-CDN-Cache-Control": "public, max-age=30",
};

const noStoreJsonHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
};

const publicReadCacheMs = 3_000;
const reloadRateLimitWindowMs = 60_000;
const reloadRateLimit = 6;
const reloadRateLimitMaxClients = 1_024;

export interface NewsApiDependencies {
  store?: NewsStore | null;
  bundledReport?: DailyNewsReport | null;
  now?: () => Date;
  refresh?: typeof runNewsRefresh;
}

export interface NewsApiHandlers {
  handleNewsRequest(request: Request): Promise<Response>;
  handleHealthRequest(request: Request): Promise<Response>;
  handleRefreshRequest(request: Request): Promise<Response>;
  handleCronRequest(request: Request): Promise<Response>;
}

export function createNewsApiHandlers(dependencies: NewsApiDependencies = {}): NewsApiHandlers {
  const store = dependencies.store === undefined ? getDefaultNewsStore() : dependencies.store;
  const bundledReport = dependencies.bundledReport === undefined ? readBundledReport() : dependencies.bundledReport;
  const now = dependencies.now ?? (() => new Date());
  const refresh = dependencies.refresh ?? runNewsRefresh;
  let cachedRead: { expiresAt: number; value: Awaited<ReturnType<typeof readLatestWithFallback>> } | null = null;
  let readInFlight: Promise<Awaited<ReturnType<typeof readLatestWithFallback>>> | null = null;
  const reloadRequests = new Map<string, { windowStartedAt: number; count: number }>();

  const readPublicState = async () => {
    const requestedAt = now().getTime();
    if (cachedRead && cachedRead.expiresAt > requestedAt) return cachedRead.value;
    readInFlight ??= readLatestWithFallback(store, bundledReport).then((value) => {
      if (!value.storageErrorCode) {
        cachedRead = { expiresAt: now().getTime() + publicReadCacheMs, value };
      }
      return value;
    }).finally(() => {
      readInFlight = null;
    });
    return readInFlight;
  };

  return {
    async handleNewsRequest(request) {
      if (request.method !== "GET") return methodNotAllowed(["GET"]);
      const requestedAt = now();
      const requestMode = newsRequestMode(request, requestedAt);
      if (!requestMode) return jsonResponse(400, { error: "Invalid news cache key" }, noStoreJsonHeaders);
      if (requestMode.cache === "reload" && !acceptReloadRequest(request, reloadRequests, requestedAt)) {
        return jsonResponse(429, { error: "Too many reload requests" }, {
          ...noStoreJsonHeaders,
          "Retry-After": "60",
        });
      }
      const read = await readPublicState();
      if (!read.latest) return jsonResponse(503, { error: "No published news report is available" }, noStoreJsonHeaders);
      const report = reportResponse(read.latest, read.state, read.storage, read.storageErrorCode, requestedAt);
      return jsonResponse(
        200,
        requestMode.view === "web" ? compactDailyNewsReport(report) : report,
        requestMode.cache === "reload" ? noStoreJsonHeaders : newsJsonHeaders,
      );
    },

    async handleHealthRequest(request) {
      if (request.method !== "GET") return methodNotAllowed(["GET"]);
      const read = await readPublicState();
      const freshness = evaluateFreshness(
        {
          report: read.latest?.report,
          dataAsOf: read.latest?.dataAsOf,
          lastAttemptAt: read.state.runtime.lastAttemptAt,
          lastSuccessAt: read.state.runtime.lastSuccessAt,
          lastError: read.storageErrorCode ?? read.state.runtime.lastErrorCode,
        },
        now(),
      );
      const reportAvailable = Boolean(read.latest);
      const healthy = reportAvailable;
      const status = reportAvailable ? 200 : 503;
      return jsonResponse(
        status,
        {
          ok: healthy,
          runtime: process.env.VERCEL ? "vercel" : "node",
          storage: read.storage,
          reportAvailable,
          refreshStatus: freshness.status,
          servingMode: servingModeForStorage(read.storage),
          pipelineStatus: pipelineStatusForState(freshness.pipelineStatus, read.state),
          contentStatus: freshness.contentStatus,
          coverageStatus: coverageStatus(read.state, now()),
          generatedAt: read.latest?.report.generatedAt ?? null,
          dataAsOf: freshness.dataAsOf,
          latestReportId: read.latest?.reportId ?? null,
          lastAttemptAt: read.state.runtime.lastAttemptAt,
          lastSuccessAt: read.state.runtime.lastSuccessAt,
          lastCheckedAt: read.state.runtime.lastAttemptAt,
          lastFullSweepAt: fullSweepTimestamp(read.state),
          lastPublishedAt: read.latest?.publishedAt ?? null,
          publicationStateAt: read.state.runtime.publicationStateAt ?? null,
          newestContentAt: read.latest?.newestContentAt ?? freshness.newestContentAt,
          lastOutcomeCode: read.state.runtime.lastOutcomeCode ?? null,
          ageMinutes: freshness.ageMinutes,
          staleAfterMinutes: freshness.staleAfterMinutes,
          itemCount: read.latest?.report.items.length ?? 0,
          lastError: read.storageErrorCode ?? read.state.runtime.lastErrorCode,
        },
        noStoreJsonHeaders,
      );
    },

    async handleRefreshRequest(request) {
      if (request.method !== "POST") return methodNotAllowed(["POST"]);
      if (process.env.VERCEL && !process.env.DAILY_NEWS_REFRESH_TOKEN) {
        return jsonResponse(503, { ok: false, error: "Refresh is not configured" }, noStoreJsonHeaders);
      }
      if (!process.env.DAILY_NEWS_REFRESH_TOKEN && (store?.persistent || process.env.NODE_ENV === "production")) {
        return jsonResponse(503, { ok: false, error: "Refresh is not configured" }, noStoreJsonHeaders);
      }
      if (!isRefreshAuthorized(request, store)) {
        return jsonResponse(401, { ok: false, error: "Unauthorized" }, noStoreJsonHeaders);
      }
      if (!store || (process.env.VERCEL && !hasCompleteSupabaseConfiguration())) {
        return jsonResponse(503, { ok: false, error: "Refresh storage is not configured" }, noStoreJsonHeaders);
      }
      const result = await refresh({ trigger: process.env.VERCEL ? "manual" : "local", scheduledAt: now() }, { store, now });
      return refreshResponse(result);
    },

    async handleCronRequest(request) {
      if (request.method !== "GET") return methodNotAllowed(["GET"]);
      const cronSecret = process.env.CRON_SECRET;
      if (!cronSecret) return jsonResponse(503, { ok: false, error: "Cron is not configured" }, noStoreJsonHeaders);
      if (request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
        return jsonResponse(401, { ok: false, error: "Unauthorized" }, noStoreJsonHeaders);
      }
      if (!store || !store.persistent || !hasCompleteSupabaseConfiguration()) {
        return jsonResponse(503, { ok: false, error: "Persistent refresh storage is not configured" }, noStoreJsonHeaders);
      }
      const scheduledAt = now();
      const result = await refresh(
        {
          trigger: "cron",
          scheduledAt,
          idempotencyKey: scheduledRefreshIdempotencyKey(scheduledAt, refreshIntervalMinutes()),
        },
        { store, now },
      );
      return refreshResponse(result);
    },
  };
}

let defaultHandlers: NewsApiHandlers | null = null;

function handlers(): NewsApiHandlers {
  defaultHandlers ??= createNewsApiHandlers();
  return defaultHandlers;
}

export function handleNewsRequest(request: Request): Promise<Response> {
  return handlers().handleNewsRequest(request);
}

export function handleHealthRequest(request: Request): Promise<Response> {
  return handlers().handleHealthRequest(request);
}

export function handleRefreshRequest(request: Request): Promise<Response> {
  return handlers().handleRefreshRequest(request);
}

export function handleCronRequest(request: Request): Promise<Response> {
  return handlers().handleCronRequest(request);
}

export function resetDefaultNewsApiHandlersForTests(): void {
  defaultHandlers = null;
}

async function readLatestWithFallback(
  store: NewsStore | null,
  bundledReport: DailyNewsReport | null,
): Promise<{
  latest: PublishedNewsReport | null;
  state: NewsStoreState;
  storage: "supabase" | "memory" | "bundled";
  storageErrorCode: string | null;
}> {
  if (store) {
    try {
      const state = await (store.readPublicationState?.() ?? store.readState());
      if (state.latest) return { latest: state.latest, state, storage: store.kind, storageErrorCode: null };
      return {
        latest: bundledPublication(bundledReport),
        state,
        storage: "bundled",
        storageErrorCode: "durable_report_unavailable",
      };
    } catch {
      // Public responses use the checked-in last-known-good and a normalized error code.
    }
  }

  const latest = bundledPublication(bundledReport);
  return {
    latest,
    state: {
      latest,
      runtime: {
        lastAttemptAt: null,
        lastSuccessAt: null,
        lastErrorCode: "storage_unavailable",
      },
      sources: [],
    },
    storage: "bundled",
    storageErrorCode: "storage_unavailable",
  };
}

function reportResponse(
  latest: PublishedNewsReport,
  state: NewsStoreState,
  storage: "supabase" | "memory" | "bundled",
  storageErrorCode: string | null,
  now: Date,
): DailyNewsReport {
  const lastError = storageErrorCode ?? state.runtime.lastErrorCode;
  const freshness = evaluateFreshness(
    {
      report: latest.report,
      dataAsOf: latest.dataAsOf,
      lastAttemptAt: state.runtime.lastAttemptAt,
      lastSuccessAt: state.runtime.lastSuccessAt,
      lastError,
    },
    now,
  );
  return {
    ...latest.report,
    refresh: {
      reportId: latest.reportId,
      intervalMinutes: refreshIntervalMinutes(),
      status: freshness.status,
      servingMode: servingModeForStorage(storage),
      pipelineStatus: pipelineStatusForState(freshness.pipelineStatus, state),
      contentStatus: freshness.contentStatus,
      coverageStatus: coverageStatus(state, now),
      dataAsOf: freshness.dataAsOf,
      newestContentAt: latest.newestContentAt ?? freshness.newestContentAt,
      lastAttemptAt: state.runtime.lastAttemptAt,
      lastSuccessAt: state.runtime.lastSuccessAt,
      lastCheckedAt: state.runtime.lastAttemptAt,
      lastFullSweepAt: fullSweepTimestamp(state),
      lastPublishedAt: latest.publishedAt,
      publicationStateAt: state.runtime.publicationStateAt ?? null,
      lastOutcomeCode: state.runtime.lastOutcomeCode ?? null,
      staleAfterMinutes: freshness.staleAfterMinutes,
      lastError,
    },
  };
}

function bundledPublication(report: DailyNewsReport | null): PublishedNewsReport | null {
  if (!report) return null;
  return {
    reportId: `bundled:${report.generatedAt}`,
    report,
    dataAsOf: report.generatedAt,
    newestContentAt: evaluateFreshness({ report }, new Date(report.generatedAt)).newestContentAt,
    publishedAt: report.generatedAt,
  };
}

function refreshResponse(result: NewsRefreshResult): Response {
  const status = result.status === "busy" || result.status === "duplicate" ? 202 : result.status === "rejected" ? 422 : result.status === "failed" ? 500 : 200;
  return jsonResponse(
    status,
    {
      ok: result.ok,
      status: result.status,
      runId: result.runId,
      reportId: result.reportId,
      generatedAt: result.generatedAt,
      selectedSourceCount: result.selectedSourceIds.length,
      discoveredCount: result.discoveredCount,
      candidateCount: result.candidateCount,
      error: result.errorCode,
    },
    noStoreJsonHeaders,
  );
}

function refreshIntervalMinutes(): number {
  return readPositiveInteger("DAILY_NEWS_REFRESH_INTERVAL_MINUTES", defaultRefreshIntervalMinutes);
}

function jsonResponse(status: number, value: unknown, headers: HeadersInit = newsJsonHeaders): Response {
  return new Response(JSON.stringify(value), { status, headers });
}

function methodNotAllowed(methods: string[]): Response {
  return new Response(JSON.stringify({ error: "Method not allowed" }), {
    status: 405,
    headers: { ...noStoreJsonHeaders, Allow: methods.join(", ") },
  });
}

function newsRequestMode(request: Request, _now: Date): { cache: "shared" | "reload"; view: "full" | "web" } | null {
  const searchParams = new URL(request.url).searchParams;
  if ([...searchParams.keys()].some((key) => key !== "view" && key !== "reload")) return null;
  if (["view", "reload"].some((key) => searchParams.getAll(key).length > 1)) return null;
  const viewValue = searchParams.get("view");
  if (viewValue !== null && viewValue !== "web") return null;
  const view = viewValue === "web" ? "web" : "full";
  const reloadValue = searchParams.get("reload");
  if (reloadValue !== null) return reloadValue === "1" && view === "web" ? { cache: "reload", view } : null;
  return { cache: "shared", view };
}

function acceptReloadRequest(
  request: Request,
  requests: Map<string, { windowStartedAt: number; count: number }>,
  requestedAt: Date,
): boolean {
  const forwardedFor = request.headers.get("x-vercel-forwarded-for") ?? request.headers.get("x-forwarded-for") ?? "unknown";
  const client = forwardedFor.split(",", 1)[0]?.trim() || "unknown";
  const timestamp = requestedAt.getTime();
  const current = requests.get(client);
  if (current && timestamp - current.windowStartedAt < reloadRateLimitWindowMs) {
    if (current.count >= reloadRateLimit) return false;
    current.count += 1;
    return true;
  }
  if (!current && requests.size >= reloadRateLimitMaxClients) {
    requests.delete(requests.keys().next().value ?? "");
  }
  requests.set(client, { windowStartedAt: timestamp, count: 1 });
  return true;
}

function fullSweepTimestamp(state: NewsStoreState): string | null {
  if (state.runtime.lastFullSweepAt !== undefined) return state.runtime.lastFullSweepAt;
  const enabled = state.sources.filter((source) => source.enabled !== false);
  if (enabled.length === 0 || enabled.some((source) => !source.lastAttemptAt)) return null;
  return enabled
    .map((source) => source.lastAttemptAt!)
    .sort((left, right) => Date.parse(left) - Date.parse(right))[0] ?? null;
}

function servingModeForStorage(storage: "supabase" | "memory" | "bundled"): "durable" | "bundled" {
  return storage === "bundled" ? "bundled" : "durable";
}

function pipelineStatusForState(
  status: "healthy" | "degraded" | "failed",
  state: NewsStoreState,
): "healthy" | "degraded" | "failed" {
  return status === "healthy" && state.runtime.lastOutcomeCode === "partial" ? "degraded" : status;
}

function coverageStatus(state: NewsStoreState, now: Date): "current" | "stale" | "incomplete" | "unavailable" {
  if (state.runtime.enabledSourceCount !== undefined) {
    if (state.runtime.enabledSourceCount === 0) return "unavailable";
    if ((state.runtime.recentlyAttemptedSourceCount ?? 0) >= state.runtime.enabledSourceCount) return "current";
    return state.runtime.lastFullSweepAt ? "stale" : "incomplete";
  }
  const enabled = state.sources.filter((source) => source.enabled !== false);
  if (enabled.length === 0) return "unavailable";
  if (enabled.some((source) => !source.lastAttemptAt)) return "incomplete";
  return enabled.every(
    (source) => now.getTime() - Date.parse(source.lastAttemptAt!) <= defaultSourceCoverageWindowMinutes * 60_000,
  )
    ? "current"
    : "stale";
}

function isRefreshAuthorized(request: Request, store: NewsStore | null): boolean {
  const token = process.env.DAILY_NEWS_REFRESH_TOKEN;
  if (token) return request.headers.get("authorization") === `Bearer ${token}`;
  if (process.env.VERCEL || process.env.NODE_ENV === "production" || store?.persistent) return false;
  if (request.headers.get("x-daily-news-refresh") !== "1") return false;
  if (request.headers.get("sec-fetch-site") === "cross-site") return false;
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}
