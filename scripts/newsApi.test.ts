import { afterEach, describe, expect, it, vi } from "vitest";
import type { NewsStore } from "./newsStore";
import {
  createNewsApiHandlers,
  handleHealthRequest,
  handleNewsRequest,
  handleRefreshRequest,
  resetDefaultNewsApiHandlersForTests,
} from "./newsApi";
import { resetDefaultNewsStoreForTests } from "./newsStoreFactory";
import { readBundledReport } from "./reportStore";

const originalVercel = process.env.VERCEL;
const originalRefreshToken = process.env.DAILY_NEWS_REFRESH_TOKEN;
const originalCronSecret = process.env.CRON_SECRET;
const originalSupabaseUrl = process.env.SUPABASE_URL;
const originalSupabaseSecretKey = process.env.SUPABASE_SECRET_KEY;

afterEach(() => {
  if (originalVercel === undefined) delete process.env.VERCEL;
  else process.env.VERCEL = originalVercel;
  restoreEnv("DAILY_NEWS_REFRESH_TOKEN", originalRefreshToken);
  restoreEnv("CRON_SECRET", originalCronSecret);
  restoreEnv("SUPABASE_URL", originalSupabaseUrl);
  restoreEnv("SUPABASE_SECRET_KEY", originalSupabaseSecretKey);
  resetDefaultNewsApiHandlersForTests();
  resetDefaultNewsStoreForTests();
  vi.restoreAllMocks();
});

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe("serverless report API", () => {
  it("serves last-known-good without making a network request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const response = await handleNewsRequest(new Request("https://example.com/api/news"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    expect(response.headers.get("vercel-cdn-cache-control")).toBe("public, max-age=30");
    expect(body.version).toBe(2);
    expect(body.items.length).toBeGreaterThan(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a non-cacheable 503 when neither durable nor bundled reports are available", async () => {
    const handlers = createNewsApiHandlers({ store: null, bundledReport: null });
    const response = await handlers.handleNewsRequest(new Request("https://example.com/api/news"));

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("vercel-cdn-cache-control")).toBeNull();
    expect(await response.json()).toEqual({ error: "No published news report is available" });
  });

  it("keeps manual reload responses out of the CDN cache", async () => {
    const response = await handleNewsRequest(new Request("https://example.com/api/news?reload=1"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("vercel-cdn-cache-control")).toBe("public, max-age=5");
  });

  it("serves a compact cacheable representation for the web app", async () => {
    const response = await handleNewsRequest(new Request("https://example.com/api/news?view=web"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("vercel-cdn-cache-control")).toBe("public, max-age=30");
    expect(body.webView).toBe(1);
    expect(body.stories.length).toBeGreaterThan(0);
    expect(body.topStoryIds.length).toBeGreaterThan(0);
    expect(body.rankingMetadata).toBeTypeOf("object");
    expect(body).not.toHaveProperty("items");
    expect(body).not.toHaveProperty("topStories");
  });

  it("keeps compact manual reload responses out of the CDN cache", async () => {
    const response = await handleNewsRequest(new Request("https://example.com/api/news?view=web&reload=1"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("vercel-cdn-cache-control")).toBe("public, max-age=5");
  });

  it("rejects unknown cache keys before reading durable storage", async () => {
    const store = { readState: vi.fn() } as unknown as NewsStore;
    const handlers = createNewsApiHandlers({ store });
    const response = await handlers.handleNewsRequest(new Request("https://example.com/api/news?window=random"));

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(store.readState).not.toHaveBeenCalled();
  });

  it("rejects non-canonical window keys before reading durable storage", async () => {
    const store = { readState: vi.fn() } as unknown as NewsStore;
    const handlers = createNewsApiHandlers({ store, now: () => new Date(60_000) });
    const response = await handlers.handleNewsRequest(new Request("https://example.com/api/news?window=0002"));

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(store.readState).not.toHaveBeenCalled();
  });

  it("reports the readable snapshot independently from refresh health", async () => {
    const response = await handleHealthRequest(new Request("https://example.com/api/health"));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.reportAvailable).toBe(true);
    expect(body.itemCount).toBeGreaterThan(0);
    expect(body.refreshStatus).toBe("stale");
  });

  it("recovers from a transient durable read failure without sticking to bundled fallback", async () => {
    const now = new Date("2026-07-15T11:40:00.000Z");
    const bundledReport = { ...readBundledReport(), generatedAt: "2026-07-15T11:35:00.000Z" };
    const currentReport = { ...bundledReport, generatedAt: "2026-07-15T11:39:00.000Z" };
    const rawStorageError = "raw database connection details must stay private";
    const store = {
      kind: "supabase",
      persistent: true,
      readState: vi
        .fn()
        .mockRejectedValueOnce(new Error(rawStorageError))
        .mockRejectedValueOnce(new Error(rawStorageError))
        .mockResolvedValue({
          latest: {
            reportId: "current-report",
            report: currentReport,
            dataAsOf: currentReport.generatedAt,
            newestContentAt: null,
            publishedAt: currentReport.generatedAt,
          },
          runtime: {
            lastAttemptAt: currentReport.generatedAt,
            lastSuccessAt: currentReport.generatedAt,
            lastErrorCode: null,
          },
          sources: [],
        }),
    } as unknown as NewsStore;
    const handlers = createNewsApiHandlers({ store, bundledReport, now: () => now });

    const degradedHealthResponse = await handlers.handleHealthRequest(new Request("https://example.com/api/health"));
    const degradedHealth = await degradedHealthResponse.json();

    expect(degradedHealthResponse.status).toBe(503);
    expect(degradedHealth).toMatchObject({
      ok: false,
      storage: "bundled",
      reportAvailable: true,
      refreshStatus: "degraded",
      lastError: "storage_unavailable",
    });
    expect(JSON.stringify(degradedHealth)).not.toContain(rawStorageError);

    const degradedNewsResponse = await handlers.handleNewsRequest(new Request("https://example.com/api/news"));
    const degradedNews = await degradedNewsResponse.json();

    expect(degradedNewsResponse.status).toBe(200);
    expect(degradedNews.refresh).toMatchObject({
      status: "degraded",
      lastError: "storage_unavailable",
    });
    expect(JSON.stringify(degradedNews)).not.toContain(rawStorageError);

    const recoveredHealthResponse = await handlers.handleHealthRequest(new Request("https://example.com/api/health"));
    const recoveredHealth = await recoveredHealthResponse.json();

    expect(recoveredHealthResponse.status).toBe(200);
    expect(recoveredHealth).toMatchObject({
      ok: true,
      storage: "supabase",
      reportAvailable: true,
      refreshStatus: "fresh",
      latestReportId: "current-report",
      lastError: null,
    });
    expect(store.readState).toHaveBeenCalledTimes(3);
  });

  it("does not expose an unconfigured refresh endpoint on Vercel", async () => {
    process.env.VERCEL = "1";
    const response = await handleRefreshRequest(
      new Request("https://example.com/api/refresh", { method: "POST" }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: "Refresh is not configured" });
  });

  it("rejects an incorrect configured refresh token as unauthorized", async () => {
    process.env.VERCEL = "1";
    process.env.DAILY_NEWS_REFRESH_TOKEN = "configured-token";
    const response = await handleRefreshRequest(
      new Request("https://example.com/api/refresh", {
        method: "POST",
        headers: { authorization: "Bearer wrong-token" },
      }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, error: "Unauthorized" });
  });

  it("marks an old bundled report stale instead of healthy", async () => {
    const now = new Date("2026-07-13T12:00:00.000Z");
    const handlers = createNewsApiHandlers({ store: null, bundledReport: readBundledReport(), now: () => now });
    const newsResponse = await handlers.handleNewsRequest(new Request("https://example.com/api/news"));
    const healthResponse = await handlers.handleHealthRequest(new Request("https://example.com/api/health"));
    const news = await newsResponse.json();
    const health = await healthResponse.json();

    expect(news.refresh.status).toBe("stale");
    expect(news.refresh.dataAsOf).toBe(news.generatedAt);
    expect(news.refresh.lastAttemptAt).toBeNull();
    expect(news.refresh.lastSuccessAt).toBeNull();
    expect(healthResponse.status).toBe(503);
    expect(health.ok).toBe(false);
    expect(health.refreshStatus).toBe("stale");
  });

  it("keeps an old snapshot stale after a newer successful refresh attempt", async () => {
    const report = readBundledReport();
    const now = new Date("2026-07-13T12:00:00.000Z");
    const store = {
      kind: "memory",
      persistent: false,
      readState: vi.fn().mockResolvedValue({
        latest: {
          reportId: "old-report",
          report,
          dataAsOf: report.generatedAt,
          newestContentAt: null,
          publishedAt: report.generatedAt,
        },
        runtime: {
          lastAttemptAt: now.toISOString(),
          lastSuccessAt: now.toISOString(),
          lastErrorCode: null,
        },
        sources: [],
      }),
    } as unknown as NewsStore;
    const handlers = createNewsApiHandlers({ store, now: () => now });

    const news = await (await handlers.handleNewsRequest(new Request("https://example.com/api/news"))).json();
    const health = await handlers.handleHealthRequest(new Request("https://example.com/api/health"));

    expect(news.refresh.status).toBe("stale");
    expect(news.refresh.dataAsOf).toBe(report.generatedAt);
    expect(news.refresh.lastSuccessAt).toBe(now.toISOString());
    expect(health.status).toBe(503);
    expect((await health.json()).dataAsOf).toBe(report.generatedAt);
  });

  it("returns 503 when a fresh report has a degraded refresh state", async () => {
    const report = { ...readBundledReport(), generatedAt: "2026-07-13T11:50:00.000Z" };
    const store = {
      kind: "memory",
      persistent: false,
      readState: vi.fn().mockResolvedValue({
        latest: {
          reportId: "degraded-report",
          report,
          dataAsOf: report.generatedAt,
          newestContentAt: null,
          publishedAt: report.generatedAt,
        },
        runtime: {
          lastAttemptAt: "2026-07-13T11:55:00.000Z",
          lastSuccessAt: "2026-07-13T11:50:00.000Z",
          lastErrorCode: "upstream_timeout",
        },
        sources: [],
      }),
    } as unknown as NewsStore;
    const handlers = createNewsApiHandlers({ store, now: () => new Date("2026-07-13T12:00:00.000Z") });

    const response = await handlers.handleHealthRequest(new Request("https://example.com/api/health"));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.refreshStatus).toBe("degraded");
  });

  it("protects cron and sends one idempotent scheduled refresh", async () => {
    const now = new Date("2026-07-13T12:07:00.000Z");
    const refresh = vi.fn().mockResolvedValue({
      ok: true,
      status: "unchanged",
      runId: "run-1",
      reportId: "report-1",
      generatedAt: "2026-07-13T12:00:00.000Z",
      selectedSourceIds: [],
      discoveredCount: 0,
      candidateCount: 0,
      errorCode: null,
    });
    const persistentStore = { kind: "supabase", persistent: true } as NewsStore;
    const handlers = createNewsApiHandlers({ store: persistentStore, now: () => now, refresh });

    expect((await handlers.handleCronRequest(new Request("https://example.com/api/cron"))).status).toBe(503);
    process.env.CRON_SECRET = "test-cron-secret";
    expect((await handlers.handleCronRequest(new Request("https://example.com/api/cron"))).status).toBe(401);
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SECRET_KEY = "test-secret-placeholder";
    const response = await handlers.handleCronRequest(
      new Request("https://example.com/api/cron", {
        headers: { authorization: "Bearer test-cron-secret" },
      }),
    );

    expect(response.status).toBe(200);
    expect(refresh).toHaveBeenCalledOnce();
    expect(refresh.mock.calls[0][0]).toMatchObject({
      trigger: "cron",
      idempotencyKey: "refresh:2026-07-13T12:00:00.000Z",
    });
  });
});
