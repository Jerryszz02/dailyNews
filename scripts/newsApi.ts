import {
  defaultRefreshIntervalMinutes,
  generateDailyNewsReport,
  readPositiveInteger,
} from "./newsService.js";

const serverlessDefaultLimitPerSection = 3;
const serverlessDefaultMaxSources = 6;

const jsonHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
};

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

export async function handleNewsRequest(request: Request): Promise<Response> {
  if (request.method !== "GET") {
    return methodNotAllowed(["GET"]);
  }

  try {
    const { report } = await generateDailyNewsReport(serverlessGenerationOptions());
    return jsonResponse(200, {
      ...report,
      refresh: {
        intervalMinutes: refreshIntervalMinutes(),
        lastError: null,
      },
    });
  } catch (error) {
    return jsonResponse(500, {
      error: "Failed to generate news report",
      refresh: {
        intervalMinutes: refreshIntervalMinutes(),
        lastError: String(error),
      },
    });
  }
}

export async function handleRefreshRequest(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return methodNotAllowed(["POST"]);
  }

  try {
    const { report } = await generateDailyNewsReport(serverlessGenerationOptions());
    return jsonResponse(200, {
      ok: true,
      generatedAt: report.generatedAt,
      itemCount: report.items.length,
    });
  } catch (error) {
    return jsonResponse(500, {
      ok: false,
      error: String(error),
    });
  }
}
