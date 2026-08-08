import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatRelativeTime,
  readReport,
  reportApiUrl,
  resolveLatestStories,
  resolveReportFreshness,
  shouldReplaceReport,
  sourceLabel,
} from "./App";
import { newsSources } from "./config/sources";
import type { DailyNewsReport } from "./types";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("sourceLabel", () => {
  it("returns a Chinese display label for every enabled source", () => {
    for (const source of newsSources.filter((item) => item.enabled)) {
      expect(sourceLabel(source.name)).toMatch(/[\u4e00-\u9fff]/);
    }
  });
});

describe("reportApiUrl", () => {
  it("uses one stable CDN URL independent of the client clock", () => {
    expect(reportApiUrl(30_001)).toBe("/api/news?view=web");
    expect(reportApiUrl(59_999)).toBe("/api/news?view=web");
    expect(reportApiUrl(Number.MAX_SAFE_INTEGER)).toBe("/api/news?view=web");
  });

  it("uses the fixed no-store reload key when the user explicitly reloads the report", () => {
    expect(reportApiUrl(30_001, true)).toBe("/api/news?view=web&reload=1");
  });
});

describe("latest stories", () => {
  const story = (id: string, updatedAt: string) =>
    ({ id, updatedAt, evidence: [], sourceNames: [] }) as unknown as DailyNewsReport["stories"][number];

  it("derives every story in the latest 24-hour window for legacy V2 reports", () => {
    const report = {
      generatedAt: "2026-08-03T12:00:00.000Z",
      stories: [
        story("older", "2026-08-02T11:59:59.000Z"),
        story("newer", "2026-08-03T11:00:00.000Z"),
        story("newest", "2026-08-03T11:30:00.000Z"),
      ],
    } as unknown as DailyNewsReport;

    expect(resolveLatestStories(report).map((item) => item.id)).toEqual(["newest", "newer"]);
  });

  it("falls back to the 72-hour window when there is no 24-hour story", () => {
    const report = {
      generatedAt: "2026-08-03T12:00:00.000Z",
      stories: [story("too-old", "2026-07-30T12:00:00.000Z"), story("fallback", "2026-08-01T12:00:00.000Z")],
    } as DailyNewsReport;

    expect(resolveLatestStories(report).map((item) => item.id)).toEqual(["fallback"]);
  });

  it("preserves an explicit empty latest selection from the serving report", () => {
    const report = {
      generatedAt: "2026-08-03T12:00:00.000Z",
      stories: [story("old", "2026-08-03T11:00:00.000Z")],
      latestStories: [],
    } as unknown as DailyNewsReport;

    expect(resolveLatestStories(report)).toEqual([]);
  });
});

describe("report loading", () => {
  const reportAt = (dataAsOf: string) =>
    ({
      generatedAt: dataAsOf,
      items: [{}],
      refresh: { dataAsOf },
    }) as DailyNewsReport;

  it("never replaces a newer loaded report with an older cache or fallback", () => {
    const newer = reportAt("2026-07-13T12:00:00.000Z");
    const older = reportAt("2026-07-13T11:59:59.000Z");

    expect(shouldReplaceReport(newer, older)).toBe(false);
    expect(shouldReplaceReport(older, newer)).toBe(true);
    expect(shouldReplaceReport(newer, reportAt("2026-07-13T12:00:00.000Z"))).toBe(true);
  });

  it("accepts an authoritative durable rollback but rejects an older durable response", () => {
    const current = reportAt("2026-07-13T12:00:00.000Z");
    current.refresh = {
      ...current.refresh,
      reportId: "current",
      servingMode: "durable",
      publicationStateAt: "2026-07-13T12:01:00.000Z",
    };
    const rollback = reportAt("2026-07-13T11:00:00.000Z");
    rollback.refresh = {
      ...rollback.refresh,
      reportId: "rollback",
      servingMode: "durable",
      publicationStateAt: "2026-07-13T12:02:00.000Z",
    };
    const staleResponse = reportAt("2026-07-13T13:00:00.000Z");
    staleResponse.refresh = {
      ...staleResponse.refresh,
      reportId: "stale-cache",
      servingMode: "durable",
      publicationStateAt: "2026-07-13T12:00:00.000Z",
    };

    expect(shouldReplaceReport(current, rollback)).toBe(true);
    expect(shouldReplaceReport(current, staleResponse)).toBe(false);

    const bundledFallback = reportAt("2026-07-13T13:00:00.000Z");
    bundledFallback.refresh = {
      ...bundledFallback.refresh,
      reportId: "bundled-fallback",
      servingMode: "bundled",
      pipelineStatus: "degraded",
    };
    expect(shouldReplaceReport(rollback, bundledFallback)).toBe(false);
  });

  it("aborts a hanging report request at the configured timeout", async () => {
    vi.useFakeTimers();
    let wasAborted = false;
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      const requestSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener("abort", () => {
          wasAborted = requestSignal.aborted;
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    });

    const pending = readReport("/api/news", 10);
    await vi.advanceTimersByTimeAsync(10);

    expect(await pending).toBeNull();
    expect(wasAborted).toBe(true);
  });
});

describe("report freshness", () => {
  const now = Date.parse("2026-07-13T12:00:00.000Z");

  it("infers missing legacy metadata without confusing page load time with report freshness", () => {
    const report = {
      generatedAt: "2026-07-13T10:00:00.000Z",
      items: [
        { updatedAt: "2026-07-13T08:00:00.000Z" },
        { updatedAt: "2026-07-13T09:30:00.000Z" },
      ] as DailyNewsReport["items"],
    };

    const freshness = resolveReportFreshness(report, "2026-07-13T12:00:00.000Z", now);

    expect(freshness.status).toBe("stale");
    expect(freshness.reportGeneratedAt).toBe("2026-07-13T10:00:00.000Z");
    expect(freshness.newestContentAt).toBe("2026-07-13T09:30:00.000Z");
    expect(freshness.lastCheckedAt).toBe("2026-07-13T10:00:00.000Z");
    expect(freshness.pageCheckedAt).toBe("2026-07-13T12:00:00.000Z");
    expect(freshness.newestContentWasInferred).toBe(true);
    expect(freshness.lastCheckedWasInferred).toBe(true);
    expect(freshness.statusWasInferred).toBe(true);
  });

  it("preserves durable degraded metadata from the API", () => {
    const report = {
      generatedAt: "2026-07-13T11:50:00.000Z",
      items: [] as DailyNewsReport["items"],
      refresh: {
        status: "degraded" as const,
        newestContentAt: "2026-07-13T11:45:00.000Z",
        lastSuccessAt: "2026-07-13T11:50:00.000Z",
        staleAfterMinutes: 45,
      },
    };

    const freshness = resolveReportFreshness(report, null, now);

    expect(freshness.status).toBe("degraded");
    expect(freshness.staleAfterMinutes).toBe(45);
    expect(freshness.newestContentWasInferred).toBe(false);
    expect(freshness.lastCheckedWasInferred).toBe(false);
    expect(freshness.statusWasInferred).toBe(false);
    expect(freshness.pipelineStatus).toBe("degraded");
  });

  it("keeps a quiet content period separate from pipeline health", () => {
    const report = {
      generatedAt: "2026-07-13T10:00:00.000Z",
      items: [] as DailyNewsReport["items"],
      refresh: {
        status: "fresh" as const,
        pipelineStatus: "healthy" as const,
        contentStatus: "quiet" as const,
        lastCheckedAt: "2026-07-13T12:00:00.000Z",
      },
    };

    const freshness = resolveReportFreshness(report, null, now);
    expect(freshness.pipelineStatus).toBe("healthy");
    expect(freshness.contentStatus).toBe("quiet");
    expect(freshness.status).not.toBe("degraded");
  });

  it("does not show fresh when durable timestamps are already over the threshold", () => {
    const report = {
      generatedAt: "2026-07-13T10:00:00.000Z",
      items: [] as DailyNewsReport["items"],
      refresh: {
        status: "fresh" as const,
        dataAsOf: "2026-07-13T10:00:00.000Z",
        lastSuccessAt: "2026-07-13T12:00:00.000Z",
        staleAfterMinutes: 30,
      },
    };

    expect(resolveReportFreshness(report, null, now).status).toBe("stale");
  });

  it("renders invalid timestamps as unknown instead of just now", () => {
    const report = {
      generatedAt: "not-a-date",
      items: [{ publishedAt: "also-not-a-date" }] as DailyNewsReport["items"],
    };

    expect(resolveReportFreshness(report, "invalid", now).status).toBe("unavailable");
    expect(formatRelativeTime("not-a-date", now)).toBe("时间未知");
  });
});
