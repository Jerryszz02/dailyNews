import {
  defaultRefreshIntervalMinutes,
  generateDailyNewsReport,
  readPositiveInteger,
} from "./newsService.js";
import { verifyDailyNewsReport } from "../src/lib/reportAcceptance.js";
import { InMemoryNewsReportStore, readBundledReport } from "./reportStore.js";

const serverlessDefaultLimitPerSection = 3;
export const serverlessDefaultMaxSources = 10;

const jsonHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "public, max-age=0, s-maxage=60, stale-while-revalidate=300",
  "Content-Type": "application/json; charset=utf-8",
};

const reportStore = new InMemoryNewsReportStore(readBundledReport());
let lastRefreshError = "";

function refreshIntervalMinutes(): number {
  return readPositiveInteger("DAILY_NEWS_REFRESH_INTERVAL_MINUTES", defaultRefreshIntervalMinutes);
}

function serverlessGenerationOptions() {
  return {
    limitPerSection: readPositiveInteger("DAILY_NEWS_LIMIT_PER_SECTION", serverlessDefaultLimitPerSection),
    maxSources: readPositiveInteger("DAILY_NEWS_MAX_SOURCES", serverlessDefaultMaxSources),
    repairSummariesWithModel: false,
    useFirecrawlKeyless: false,
  };
}

function jsonResponse(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: jsonHeaders,
  });
}

function methodNotAllowed(methods: string[]): Response {
  return new Response(JSON.stringify({ error: "Method not allowed" }), {
    status: 405,
    headers: {
      ...jsonHeaders,
      Allow: methods.join(", "),
    },
  });
}

export function handleNewsRequest(request: Request): Response {
  if (request.method !== "GET") {
    return methodNotAllowed(["GET"]);
  }

  const report = reportStore.readLatest();
  if (!report) return jsonResponse(503, { error: "No published news report is available" });
  return jsonResponse(200, {
    ...report,
    refresh: {
      intervalMinutes: refreshIntervalMinutes(),
      status: lastRefreshError ? "degraded" : "healthy",
      lastError: lastRefreshError || null,
    },
  });
}

export async function handleRefreshRequest(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return methodNotAllowed(["POST"]);
  }

  if (process.env.VERCEL && !process.env.DAILY_NEWS_REFRESH_TOKEN) {
    return jsonResponse(503, {
      ok: false,
      error: "Refresh is not configured",
    });
  }
  if (!isRefreshAuthorized(request)) return jsonResponse(401, { ok: false, error: "Unauthorized" });

  try {
    const { report, metrics } = await generateDailyNewsReport(serverlessGenerationOptions());
    const acceptance = verifyDailyNewsReport(report, metrics);
    if (acceptance.status !== "PASS") {
      lastRefreshError = "quantitative_gate_failed";
      return jsonResponse(422, {
        ok: false,
        error: "Generated report did not pass the quantitative acceptance gate",
        failures: acceptance.failures,
      });
    }
    if (!reportStore.publish(report)) {
      lastRefreshError = "quality_gate_failed";
      return jsonResponse(422, { ok: false, error: "Generated report did not pass the publish gate" });
    }
    lastRefreshError = "";
    return jsonResponse(200, {
      ok: true,
      generatedAt: report.generatedAt,
      itemCount: report.items.length,
    });
  } catch (error) {
    lastRefreshError = "refresh_failed";
    console.warn(`Serverless refresh failed: ${String(error)}`);
    return jsonResponse(500, {
      ok: false,
      error: "Failed to refresh news report",
    });
  }
}

export function handleHealthRequest(request: Request): Response {
  if (request.method !== "GET") return methodNotAllowed(["GET"]);
  const report = reportStore.readLatest();
  return jsonResponse(report ? 200 : 503, {
    ok: Boolean(report),
    runtime: "vercel",
    reportAvailable: Boolean(report),
    refreshStatus: lastRefreshError ? "degraded" : "healthy",
    generatedAt: report?.generatedAt ?? null,
    itemCount: report?.items.length ?? 0,
  });
}

function isRefreshAuthorized(request: Request): boolean {
  const token = process.env.DAILY_NEWS_REFRESH_TOKEN;
  if (!token) return !process.env.VERCEL && process.env.NODE_ENV !== "production";
  return request.headers.get("authorization") === `Bearer ${token}`;
}
