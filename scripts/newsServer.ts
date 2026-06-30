import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, resolve } from "node:path";
import type { DailyNewsReport } from "../src/types";
import {
  defaultRefreshIntervalMinutes,
  generateDailyNewsReport,
  loadLocalEnv,
  readPositiveInteger,
} from "./newsService";

const port = readPositiveInteger("PORT", 4173);
const refreshIntervalMinutes = readPositiveInteger("DAILY_NEWS_REFRESH_INTERVAL_MINUTES", defaultRefreshIntervalMinutes);
const refreshIntervalMs = refreshIntervalMinutes * 60_000;
const distDir = resolve(process.cwd(), "dist");

let cachedReport: DailyNewsReport | null = null;
let lastError = "";
let refreshInFlight: Promise<void> | null = null;

loadLocalEnv();

await refreshNews();
setInterval(() => {
  void refreshNews();
}, refreshIntervalMs).unref();

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);

  if (request.method === "GET" && url.pathname === "/api/news") {
    writeJson(response, 200, {
      ...cachedReport,
      refresh: {
        intervalMinutes: refreshIntervalMinutes,
        lastError: lastError || null,
      },
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/refresh") {
    refreshNews()
      .then(() => writeJson(response, 200, { ok: true, generatedAt: cachedReport?.generatedAt ?? null }))
      .catch((error: unknown) => writeJson(response, 500, { ok: false, error: String(error) }));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/health") {
    writeJson(response, cachedReport ? 200 : 503, {
      ok: Boolean(cachedReport),
      generatedAt: cachedReport?.generatedAt ?? null,
      itemCount: cachedReport?.items.length ?? 0,
      lastError: lastError || null,
    });
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    writeJson(response, 404, { error: "Not found" });
    return;
  }

  serveStatic(request, response, url.pathname);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Daily News API listening on http://127.0.0.1:${port}`);
});

async function refreshNews(): Promise<void> {
  if (refreshInFlight) {
    return refreshInFlight;
  }

  refreshInFlight = generateDailyNewsReport()
    .then(({ report, mode, rawItemCount }) => {
      cachedReport = report;
      lastError = "";
      console.log(`Refreshed ${report.items.length} ranked items from ${report.sourceCount} sources using ${mode} (${rawItemCount} raw items).`);
    })
    .catch((error: unknown) => {
      lastError = String(error);
      console.warn(`Refresh failed: ${lastError}`);
      if (!cachedReport) {
        throw error;
      }
    })
    .finally(() => {
      refreshInFlight = null;
    });

  return refreshInFlight;
}

function writeJson(response: ServerResponse, statusCode: number, value: unknown) {
  response.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
}

function serveStatic(_request: IncomingMessage, response: ServerResponse, pathName: string) {
  const safePath = pathName === "/" ? "/index.html" : pathName;
  const filePath = resolve(join(distDir, safePath));
  if (!filePath.startsWith(distDir) || !existsSync(filePath) || !statSync(filePath).isFile()) {
    const fallback = join(distDir, "index.html");
    if (existsSync(fallback)) {
      streamFile(response, fallback);
      return;
    }
    writeJson(response, 404, { error: "Not found" });
    return;
  }

  streamFile(response, filePath);
}

function streamFile(response: ServerResponse, filePath: string) {
  response.writeHead(200, { "Content-Type": contentType(filePath) });
  createReadStream(filePath).pipe(response);
}

function contentType(filePath: string): string {
  const types: Record<string, string> = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
  };
  return types[extname(filePath)] ?? "application/octet-stream";
}
