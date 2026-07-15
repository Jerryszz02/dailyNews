import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, resolve } from "node:path";
import { createNewsApiHandlers } from "./newsApi";
import { runNewsRefresh } from "./newsRefresh";
import { defaultRefreshIntervalMinutes, loadLocalEnv, readPositiveInteger } from "./newsService";
import { getDefaultNewsStore } from "./newsStoreFactory";

loadLocalEnv();
const port = readPositiveInteger("PORT", 4173);
const refreshIntervalMinutes = readPositiveInteger("DAILY_NEWS_REFRESH_INTERVAL_MINUTES", defaultRefreshIntervalMinutes);
const refreshIntervalMs = refreshIntervalMinutes * 60_000;
const distDir = resolve(process.cwd(), "dist");
const store = getDefaultNewsStore();
if (!store) throw new Error("Local news store is not configured");
const localStore = store;
const api = createNewsApiHandlers({ store: localStore });
let refreshInFlight: Promise<void> | null = null;

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);

  if (request.method === "GET" && url.pathname === "/api/news") {
    void writeWebResponse(response, api.handleNewsRequest(toWebRequest(request, url)));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/refresh") {
    void writeWebResponse(response, api.handleRefreshRequest(toWebRequest(request, url)));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/health") {
    void writeWebResponse(response, api.handleHealthRequest(toWebRequest(request, url)));
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
  void refreshNews();
  setInterval(() => {
    void refreshNews();
  }, refreshIntervalMs).unref();
});

async function refreshNews(): Promise<void> {
  if (refreshInFlight) {
    return refreshInFlight;
  }

  refreshInFlight = runNewsRefresh({ trigger: "local" }, { store: localStore })
    .then((result) => {
      console.log(
        `Refresh ${result.status}: ${result.discoveredCount} live candidates, ${result.candidateCount} rolling candidates, ${result.selectedSourceIds.length} sources.`,
      );
    })
    .finally(() => {
      refreshInFlight = null;
    });

  return refreshInFlight;
}

function toWebRequest(request: IncomingMessage, url: URL): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else if (value !== undefined) headers.set(name, value);
  }
  return new Request(url, { method: request.method, headers });
}

async function writeWebResponse(response: ServerResponse, pending: Promise<Response>) {
  try {
    const result = await pending;
    response.writeHead(result.status, Object.fromEntries(result.headers.entries()));
    response.end(await result.text());
  } catch {
    writeJson(response, 500, { error: "Internal server error" });
  }
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
