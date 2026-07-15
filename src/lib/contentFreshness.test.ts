import { describe, expect, it } from "vitest";
import { defaultMaxPublishedContentAgeMinutes, evaluatePublishedContentFreshness } from "./contentFreshness";

describe("published content freshness", () => {
  const referenceAt = new Date("2026-07-13T08:00:00.000Z");

  it("accepts content exactly at the 120-minute boundary", () => {
    const result = evaluatePublishedContentFreshness(
      [{ publishedAt: "2026-07-13T06:00:00.000Z" }],
      referenceAt,
    );

    expect(result.publishable).toBe(true);
    expect(result.ageMinutes).toBe(defaultMaxPublishedContentAgeMinutes);
    expect(result.newestPublishedAt).toBe("2026-07-13T06:00:00.000Z");
  });

  it("rejects content older than 120 minutes", () => {
    const result = evaluatePublishedContentFreshness(
      [{ publishedAt: "2026-07-13T05:59:59.999Z" }],
      referenceAt,
    );

    expect(result.publishable).toBe(false);
    expect(result.ageMinutes).toBeGreaterThan(defaultMaxPublishedContentAgeMinutes);
  });

  it("does not use missing, invalid, or future timestamps as fresh published content", () => {
    const result = evaluatePublishedContentFreshness(
      [{}, { publishedAt: "invalid" }, { publishedAt: "2026-07-13T08:01:00.000Z" }],
      referenceAt,
    );

    expect(result).toMatchObject({
      publishable: false,
      newestPublishedAt: null,
      ageMinutes: null,
    });
  });
});
