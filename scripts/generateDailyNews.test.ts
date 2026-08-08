import { describe, expect, it } from "vitest";
import { generatedReportPublicationError } from "./generateDailyNews";
import { readBundledReport } from "./reportStore";

describe("generateDailyNews publication boundary", () => {
  it("allows a structurally valid live report even when its newest content is older than 120 minutes", () => {
    const previousReport = readBundledReport();
    const newestPublishedAt = Math.max(
      ...previousReport.items.map((item) => Date.parse(item.publishedAt ?? item.updatedAt)),
    );
    const report = {
      ...previousReport,
      generatedAt: new Date(newestPublishedAt + 121 * 60_000).toISOString(),
    };

    expect(Date.parse(report.generatedAt) - newestPublishedAt).toBeGreaterThan(120 * 60_000);
    expect(generatedReportPublicationError(report, true, previousReport)).toBeNull();
  });

  it("keeps the last-known-good report when collection has no publishable live candidate", () => {
    const previousReport = readBundledReport();

    expect(generatedReportPublicationError(previousReport, false, previousReport)).toBe(
      "Live collection returned no publishable items; kept the existing report.",
    );
  });

  it("still rejects a live report that violates structural invariants", () => {
    const previousReport = readBundledReport();
    const invalidReport = { ...previousReport, stories: [] };

    expect(generatedReportPublicationError(invalidReport, true, previousReport)).toBe(
      "Generated report did not pass the publish gate.",
    );
  });
});
