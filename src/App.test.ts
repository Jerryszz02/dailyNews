import { afterEach, describe, expect, it, vi } from "vitest";
import { formatRelativeTime, readReport, reportApiUrl, resolveReportFreshness, shouldReplaceReport, sourceLabel } from "./App";
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
  it("shares one CDN key inside a 30-second polling window and rotates at the boundary", () => {
    expect(reportApiUrl(30_001)).toBe("/api/news?view=web&window=1");
    expect(reportApiUrl(59_999)).toBe("/api/news?view=web&window=1");
    expect(reportApiUrl(60_000)).toBe("/api/news?view=web&window=2");
  });

  it("uses the fixed no-store reload key when the user explicitly reloads the report", () => {
    expect(reportApiUrl(30_001, true)).toBe("/api/news?view=web&reload=1");
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
        { publishedAt: "2026-07-13T08:00:00.000Z" },
        { publishedAt: "2026-07-13T09:30:00.000Z" },
      ] as DailyNewsReport["items"],
    };

    const freshness = resolveReportFreshness(report, "2026-07-13T12:00:00.000Z", now);

    expect(freshness.status).toBe("stale");
    expect(freshness.reportGeneratedAt).toBe("2026-07-13T10:00:00.000Z");
    expect(freshness.newestContentAt).toBe("2026-07-13T09:30:00.000Z");
    expect(freshness.lastSuccessAt).toBe("2026-07-13T10:00:00.000Z");
    expect(freshness.pageCheckedAt).toBe("2026-07-13T12:00:00.000Z");
    expect(freshness.newestContentWasInferred).toBe(true);
    expect(freshness.lastSuccessWasInferred).toBe(true);
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
    expect(freshness.lastSuccessWasInferred).toBe(false);
    expect(freshness.statusWasInferred).toBe(false);
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
