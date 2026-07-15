import { evaluateFreshness } from "../src/lib/freshness.js";
import { compactDailyNewsReport } from "../src/lib/webReport.js";
import type { DailyNewsReport } from "../src/types";
import { runNewsRefresh, scheduledRefreshIdempotencyKey, type NewsRefreshResult } from "./newsRefresh.js";
import { defaultRefreshIntervalMinutes, readPositiveInteger } from "./newsService.js";
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

const reloadJsonHeaders = {
  ...noStoreJsonHeaders,
  "Vercel-CDN-Cache-Control": "public, max-age=5",
};

const reportCacheWindowMs = 30_000;

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

  return {
    async handleNewsRequest(request) {
      if (request.method !== "GET") return methodNotAllowed(["GET"]);
      const requestedAt = now();
      const requestMode = newsRequestMode(request, requestedAt);
      if (!requestMode) return jsonResponse(400, { error: "Invalid news cache key" }, noStoreJsonHeaders);
      const read = await readLatestWithFallback(store, bundledReport);
      if (!read.latest) return jsonResponse(503, { error: "No published news report is available" }, noStoreJsonHeaders);
      const report = reportResponse(read.latest, read.state, read.storageErrorCode, requestedAt);
      return jsonResponse(
        200,
        requestMode.view === "web" ? compactDailyNewsReport(report) : report,
        requestMode.cache === "reload" ? reloadJsonHeaders : newsJsonHeaders,
      );
    },

    async handleHealthRequest(request) {
      if (request.method !== "GET") return methodNotAllowed(["GET"]);
      const read = await readLatestWithFallback(store, bundledReport);
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
      const healthy = freshness.status === "fresh";
      const status = healthy ? 200 : 503;
      return jsonResponse(
        status,
        {
          ok: healthy,
          runtime: process.env.VERCEL ? "vercel" : "node",
          storage: read.storage,
          reportAvailable,
          refreshStatus: freshness.status,
          generatedAt: read.latest?.report.generatedAt ?? null,
          dataAsOf: freshness.dataAsOf,
          latestReportId: read.latest?.reportId ?? null,
          lastAttemptAt: read.state.runtime.lastAttemptAt,
          lastSuccessAt: read.state.runtime.lastSuccessAt,
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
      if (!isRefreshAuthorized(request)) return jsonResponse(401, { ok: false, error: "Unauthorized" }, noStoreJsonHeaders);
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
      const state = await store.readState();
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
      dataAsOf: freshness.dataAsOf,
      newestContentAt: latest.newestContentAt ?? freshness.newestContentAt,
      lastAttemptAt: state.runtime.lastAttemptAt,
      lastSuccessAt: state.runtime.lastSuccessAt,
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

function newsRequestMode(request: Request, now: Date): { cache: "shared" | "reload"; view: "full" | "web" } | null {
  const searchParams = new URL(request.url).searchParams;
  if ([...searchParams.keys()].some((key) => key !== "view" && key !== "reload" && key !== "window")) return null;
  if (["view", "reload", "window"].some((key) => searchParams.getAll(key).length > 1)) return null;
  const viewValue = searchParams.get("view");
  if (viewValue !== null && viewValue !== "web") return null;
  const view = viewValue === "web" ? "web" : "full";
  const reloadValue = searchParams.get("reload");
  const windowValue = searchParams.get("window");
  if (reloadValue !== null && windowValue !== null) return null;
  if (reloadValue !== null) return reloadValue === "1" ? { cache: "reload", view } : null;
  if (windowValue === null) return { cache: "shared", view };

  if (!/^\d+$/.test(windowValue)) return null;
  const requestedWindow = Number(windowValue);
  const currentWindow = Math.floor(now.getTime() / reportCacheWindowMs);
  return Number.isSafeInteger(requestedWindow) && String(requestedWindow) === windowValue && Math.abs(requestedWindow - currentWindow) <= 2
    ? { cache: "shared", view }
    : null;
}

function isRefreshAuthorized(request: Request): boolean {
  const token = process.env.DAILY_NEWS_REFRESH_TOKEN;
  if (!token) return !process.env.VERCEL && process.env.NODE_ENV !== "production";
  return request.headers.get("authorization") === `Bearer ${token}`;
}
