import { describe, expect, it } from "vitest";
import type { Category, DailyNewsReport, StoryCard } from "../types";
import { coverageBeatOrder } from "./sourceCoverage";
import { verifyDailyNewsReport, type AcceptanceMetrics } from "./reportAcceptance";

const generatedAt = "2026-07-11T00:00:00.000Z";

function story(beat: Category, hour: number): StoryCard {
  const publishedAt = `2026-07-10T${String(hour).padStart(2, "0")}:00:00.000Z`;
  return {
    id: `story-${beat}-${hour}`,
    itemId: `item-${beat}-${hour}`,
    title: `${beat} 中文新闻标题`,
    whatHappened: `${beat} 板块发生一项具有公开影响的新进展。`,
    whyItMatters: "具有公共影响。",
    keyFacts: [],
    nextWatch: "关注后续进展。",
    primaryBeat: beat,
    scope: "global",
    eventType: "general",
    entities: [],
    status: "confirmed",
    tier: "important",
    publishedAt,
    updatedAt: publishedAt,
    sourceNames: ["测试来源"],
    evidence: [],
    importance: { publicImpact: 50, urgency: 50, sourceSignificance: 50, evidenceStrength: 50, total: 50 },
  };
}

function metrics(overrides: Partial<AcceptanceMetrics> = {}): AcceptanceMetrics {
  return {
    selectedSourceCount: 10,
    selectedSectionCount: 19,
    searchRequestCount: 0,
    sourcePageRequestCount: 19,
    articlePageRequestCount: 20,
    translatedUniqueEventCount: 5,
    duplicateTranslationCount: 0,
    ...overrides,
  };
}

function report(): DailyNewsReport {
  const stories = coverageBeatOrder.map((beat, index) => story(beat, 20 - index));
  return {
    version: 2,
    generatedAt,
    window: { from: "2026-07-10T10:00:00.000Z", to: "2026-07-10T20:00:00.000Z" },
    stories,
    topStories: [],
    importantStories: stories,
    watchlist: [],
    sections: coverageBeatOrder.map((beat) => ({
      beat,
      storyIds: stories.filter((entry) => entry.primaryBeat === beat).map((entry) => entry.id),
    })),
    coverage: {
      beats: coverageBeatOrder.map((beat) => ({ beat, candidateCount: 1, storyCount: 1, selectedCount: 1 })),
      coveredBeatCount: 10,
      totalBeatCount: 10,
      sourceCount: 10,
    },
    quality: {
      candidateCount: 10,
      acceptedCandidateCount: 10,
      rejectedCandidateCount: 0,
      eventCount: 10,
      selectedEventCount: 10,
      duplicateEventRate: 0,
      singleSourceShare: 1,
      rejectionReasons: {},
    },
    items: [],
    sourceCount: 10,
    notes: [],
  };
}

describe("daily report acceptance", () => {
  it("passes a complete fresh chronological report within cost limits", () => {
    expect(verifyDailyNewsReport(report(), metrics()).status).toBe("PASS");
  });

  it("fails empty categories, chronological inversions and cost overruns", () => {
    const value = report();
    value.stories = value.stories.filter((entry) => entry.primaryBeat !== "science");
    const chinaOlder = story("china", 5);
    const chinaNewer = story("china", 6);
    value.stories.push(chinaOlder, chinaNewer);
    value.sections.find((section) => section.beat === "china")!.storyIds = [chinaOlder.id, chinaNewer.id];

    const result = verifyDailyNewsReport(value, metrics({ sourcePageRequestCount: 21 }));
    expect(result.status).toBe("FAIL");
    expect(result.emptyCategories).toContain("science");
    expect(result.chronologicalInversionCount).toBe(1);
    expect(result.failures).toContain("source_discovery_requests:21");
  });

  it("reports single-source share without failing the round", () => {
    const result = verifyDailyNewsReport(report(), metrics());
    expect(result.singleSourceShare).toBe(1);
    expect(result.status).toBe("PASS");
  });

  it("fails a round that only returned fallback data", () => {
    const result = verifyDailyNewsReport(report(), metrics({ usedFallback: true }));
    expect(result.failures).toContain("fallback_data");
    expect(result.status).toBe("FAIL");
  });
});
