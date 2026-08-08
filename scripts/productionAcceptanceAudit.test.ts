import { describe, expect, it } from "vitest";
import { summarizePublicReport } from "./productionAcceptanceAudit";

const now = "2026-08-03T12:00:00.000Z";

function story(id: string, updatedAt: string) {
  return {
    id,
    updatedAt,
    evidence: [{ candidateId: `candidate-${id}` }],
  };
}

describe("production acceptance audit summaries", () => {
  it("detects a missing event in the explicit 24-hour latest list", () => {
    const recentA = story("recent-a", "2026-08-03T11:00:00.000Z");
    const recentB = story("recent-b", "2026-08-02T13:00:00.000Z");
    const older = story("older", "2026-08-01T13:00:00.000Z");

    expect(
      summarizePublicReport(
        {
          stories: [recentA, recentB, older],
          latestStories: [recentA],
          quality: { acceptedCandidateCount: 3, unmappedCandidateCount: 0 },
        },
        now,
      ),
    ).toEqual({
      latest: {
        eligible24h: 2,
        visible24h: 1,
        missing24h: 1,
        recall: 0.5,
        duplicateIds: 0,
        fallbackWindowHours: 24,
        eligibleFallback: 0,
        visibleFallback: 0,
        missingFallback: 0,
      },
      unmappedCandidateCount: 0,
    });
  });

  it("derives latest and candidate mapping for an older V2 report", () => {
    const recent = story("recent", "2026-08-03T11:00:00.000Z");

    expect(
      summarizePublicReport(
        {
          stories: [recent],
          quality: { acceptedCandidateCount: 1 },
        },
        now,
      ),
    ).toEqual({
      latest: {
        eligible24h: 1,
        visible24h: 1,
        missing24h: 0,
        recall: 1,
        duplicateIds: 0,
        fallbackWindowHours: 24,
        eligibleFallback: 0,
        visibleFallback: 0,
        missingFallback: 0,
      },
      unmappedCandidateCount: 0,
    });
  });

  it("uses the 72-hour fallback only when the 24-hour window is empty", () => {
    const older = story("older", "2026-08-01T13:00:00.000Z");

    expect(
      summarizePublicReport(
        {
          stories: [older],
          quality: { acceptedCandidateCount: 1 },
        },
        now,
      ).latest,
    ).toMatchObject({
      eligible24h: 0,
      visible24h: 0,
      missing24h: 0,
      recall: 1,
      fallbackWindowHours: 72,
      eligibleFallback: 1,
      visibleFallback: 1,
      missingFallback: 0,
    });
  });

  it("does not let declared quality metadata hide an unmapped candidate", () => {
    const recent = story("recent", "2026-08-03T11:00:00.000Z");

    expect(
      summarizePublicReport(
        {
          stories: [recent],
          latestStories: [recent],
          quality: { acceptedCandidateCount: 2, unmappedCandidateCount: 0 },
        },
        now,
      ).unmappedCandidateCount,
    ).toBe(1);
  });

  it("detects a missing 72-hour fallback event", () => {
    const older = story("older", "2026-08-01T13:00:00.000Z");

    expect(
      summarizePublicReport(
        {
          stories: [older],
          latestStories: [],
          quality: { acceptedCandidateCount: 1 },
        },
        now,
      ).latest.missingFallback,
    ).toBe(1);
  });
});
