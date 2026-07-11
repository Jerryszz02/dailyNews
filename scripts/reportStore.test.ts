import { describe, expect, it } from "vitest";
import type { DailyNewsReport } from "../src/types";
import { expandLegacyItems, InMemoryNewsReportStore, passesPublishGate, readBundledReport } from "./reportStore";

describe("last-known-good report store", () => {
  it("upgrades the checked-in report to V2 when necessary", () => {
    const report = readBundledReport();
    expect(report.version).toBe(2);
    expect(report.items.length).toBeGreaterThan(0);
    expect(report.sections.flatMap((section) => section.storyIds).every((id) => report.stories.some((story) => story.id === id))).toBe(true);
  });

  it("keeps the previous report when a candidate fails the publish gate", () => {
    const current = readBundledReport();
    const store = new InMemoryNewsReportStore(current);
    const invalid = { ...current, items: [], topStories: [], importantStories: [], watchlist: [] } as DailyNewsReport;

    expect(passesPublishGate(invalid)).toBe(false);
    expect(store.publish(invalid)).toBe(false);
    expect(store.readLatest()).toBe(current);
  });

  it("restores individual evidence rows from a legacy cluster", () => {
    const current = readBundledReport();
    const item = current.items[0];
    const expanded = expandLegacyItems([
      {
        ...item,
        sourceIds: ["xinhua", "ap"],
        sourceNames: ["新华网", "Associated Press"],
        relatedUrls: ["https://www.news.cn/a", "https://apnews.com/a"],
      },
    ]);

    expect(expanded.map((entry) => entry.sourceId)).toEqual(["xinhua", "ap"]);
    expect(expanded.map((entry) => entry.url)).toEqual(["https://www.news.cn/a", "https://apnews.com/a"]);
  });

  it("rejects a refresh that loses all candidates for a previously covered core beat", () => {
    const current = readBundledReport();
    const regressed = {
      ...current,
      generatedAt: new Date(Date.parse(current.generatedAt) + 60_000).toISOString(),
      coverage: {
        ...current.coverage,
        beats: current.coverage.beats.map((beat) =>
          beat.beat === "finance" ? { ...beat, candidateCount: 0, storyCount: 0, selectedCount: 0 } : beat,
        ),
      },
    };

    expect(passesPublishGate(regressed, current)).toBe(false);
  });

  it("allows a compact event report to replace a larger article-era report when coverage is preserved", () => {
    const current = readBundledReport();
    const compact = {
      ...current,
      sourceCount: 10,
      quality: { ...current.quality, selectedEventCount: 10 },
      coverage: {
        ...current.coverage,
        beats: current.coverage.beats.map((beat) => ({ ...beat, candidateCount: Math.max(1, beat.candidateCount) })),
      },
    };

    expect(passesPublishGate(compact, current)).toBe(true);
  });
});
