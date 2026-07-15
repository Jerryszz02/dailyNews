import { describe, expect, it } from "vitest";
import { evaluateFreshness, findNewestContentAt, type FreshnessReport } from "./freshness";

const report: FreshnessReport = {
  generatedAt: "2026-07-10T01:50:00.000Z",
  stories: [
    {
      publishedAt: "2026-07-10T00:30:00.000Z",
      updatedAt: "2026-07-10T00:45:00.000Z",
      evidence: [{ publishedAt: "2026-07-10T00:40:00.000Z" }],
    },
  ],
  items: [
    {
      publishedAt: "2026-07-10T00:50:00.000Z",
      extractedAt: "2026-07-10T00:55:00.000Z",
    },
  ],
};

describe("report freshness", () => {
  it("classifies a recently published report as fresh", () => {
    const result = evaluateFreshness(
      {
        report,
        lastAttemptAt: "2026-07-10T01:50:00.000Z",
        lastSuccessAt: "2026-07-10T01:50:00.000Z",
      },
      new Date("2026-07-10T02:00:00.000Z"),
    );

    expect(result).toEqual({
      status: "fresh",
      dataAsOf: "2026-07-10T01:50:00.000Z",
      newestContentAt: "2026-07-10T00:50:00.000Z",
      ageMinutes: 10,
      staleAfterMinutes: 30,
    });
  });

  it("classifies a report older than 30 minutes as stale", () => {
    const result = evaluateFreshness(
      { report, dataAsOf: "2026-07-10T01:29:00.000Z" },
      new Date("2026-07-10T02:00:00.000Z"),
    );

    expect(result.status).toBe("stale");
    expect(result.ageMinutes).toBe(31);
  });

  it("does not treat a successful refresh attempt as newer report content", () => {
    const result = evaluateFreshness(
      {
        report,
        dataAsOf: "2026-07-10T01:20:00.000Z",
        lastAttemptAt: "2026-07-10T02:00:00.000Z",
        lastSuccessAt: "2026-07-10T02:00:00.000Z",
      },
      new Date("2026-07-10T02:00:00.000Z"),
    );

    expect(result.status).toBe("stale");
    expect(result.dataAsOf).toBe("2026-07-10T01:20:00.000Z");
    expect(result.ageMinutes).toBe(40);
  });

  it("classifies a fresh report with a newer failed attempt as degraded", () => {
    const result = evaluateFreshness(
      {
        report,
        lastSuccessAt: "2026-07-10T01:50:00.000Z",
        lastAttemptAt: "2026-07-10T01:55:00.000Z",
        lastError: "upstream timeout",
      },
      new Date("2026-07-10T02:00:00.000Z"),
    );

    expect(result.status).toBe("degraded");
  });

  it("ignores an error that predates the latest successful publication", () => {
    const result = evaluateFreshness(
      {
        report,
        lastSuccessAt: "2026-07-10T01:50:00.000Z",
        lastAttemptAt: "2026-07-10T01:40:00.000Z",
        lastError: "old error",
      },
      new Date("2026-07-10T02:00:00.000Z"),
    );

    expect(result.status).toBe("fresh");
  });

  it("classifies a missing report or publication timestamp as unavailable", () => {
    expect(evaluateFreshness({}, new Date("2026-07-10T02:00:00.000Z")).status).toBe("unavailable");
    expect(
      evaluateFreshness({ report: { stories: [] } }, new Date("2026-07-10T02:00:00.000Z")).status,
    ).toBe("unavailable");
  });

  it("computes content time only from report content timestamps", () => {
    expect(findNewestContentAt(report)).toBe("2026-07-10T00:50:00.000Z");
    expect(
      evaluateFreshness({ report }, new Date("2026-07-11T12:00:00.000Z")).newestContentAt,
    ).toBe("2026-07-10T00:50:00.000Z");
  });

  it("ignores invalid content timestamps", () => {
    expect(
      findNewestContentAt({
        generatedAt: "2026-07-10T01:50:00.000Z",
        stories: [{ publishedAt: "not-a-date", updatedAt: null }],
        items: [{ publishedAt: "2026-07-10T00:10:00.000Z", extractedAt: "2026-07-10T02:00:00.000Z" }],
      }),
    ).toBe("2026-07-10T00:10:00.000Z");
  });
});
