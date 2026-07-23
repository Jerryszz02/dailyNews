import { describe, expect, it } from "vitest";
import { firecrawlSnapshotNews } from "../src/data/firecrawlSnapshot";
import type { DailyNewsReport } from "../src/types";
import { expandLegacyItems, InMemoryNewsReportStore, passesPublishGate, readBundledReport } from "./reportStore";
import { newestContentTimestamp } from "./newsStore";

describe("last-known-good report store", () => {
  it("upgrades the checked-in report to V2 when necessary", () => {
    const report = readBundledReport();
    expect(report.version).toBe(2);
    expect(report.items.length).toBeGreaterThan(0);
    expect(report.sections.flatMap((section) => section.storyIds).every((id) => report.stories.some((story) => story.id === id))).toBe(true);
  });

  it("uses the snapshot timestamp when the public report is missing or damaged", () => {
    const expectedGeneratedAt = new Date(
      Math.max(
        ...firecrawlSnapshotNews.flatMap((item) =>
          [item.publishedAt, item.extractedAt]
            .map((value) => Date.parse(value ?? ""))
            .filter(Number.isFinite),
        ),
      ),
    ).toISOString();

    const missing = readBundledReport(new URL("../public/missing-daily-news.json", import.meta.url));
    const damaged = readBundledReport(new URL("../src/data/firecrawlSnapshot.ts", import.meta.url));

    expect(missing.generatedAt).toBe(expectedGeneratedAt);
    expect(damaged.generatedAt).toBe(expectedGeneratedAt);
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

  it("still rejects an event-count regression when the candidate pool did not shrink", () => {
    const current = readBundledReport();
    const regressed = {
      ...current,
      quality: {
        ...current.quality,
        selectedEventCount: Math.max(10, Math.floor(current.quality.selectedEventCount * 0.5)),
      },
    };

    expect(passesPublishGate(regressed, current)).toBe(false);
  });

  it("scales the event-count comparison when a bounded candidate pool stays dense", () => {
    const current = readBundledReport();
    const candidateCount = Math.max(1, Math.floor(current.quality.candidateCount * 0.5));
    const contracted = {
      ...current,
      quality: {
        ...current.quality,
        candidateCount,
        acceptedCandidateCount: candidateCount,
        rejectedCandidateCount: 0,
        selectedEventCount: Math.max(10, Math.floor(current.quality.selectedEventCount * 0.4)),
      },
    };

    expect(passesPublishGate(contracted, current)).toBe(true);
  });

  it("rejects a report that omits an available fresh confirmed core event", () => {
    const current = readBundledReport();
    const staleAt = new Date(Date.parse(current.generatedAt) - 121 * 60_000).toISOString();
    const staleStory = (story: DailyNewsReport["stories"][number]) => ({
      ...story,
      publishedAt: staleAt,
      updatedAt: staleAt,
      evidence: story.evidence.map((evidence) => ({ ...evidence, publishedAt: staleAt })),
    });
    const template = current.stories[0];
    const freshCore = {
      ...template,
      id: "fresh-core-regression",
      itemId: "fresh-core-regression",
      primaryBeat: "science" as const,
      status: "confirmed" as const,
      tier: "important" as const,
      updatedAt: current.generatedAt,
      evidence: template.evidence.map((evidence) => ({
        ...evidence,
        sourceId: "fresh-core-source",
        publishedAt: current.generatedAt,
      })),
    };
    const regressed = {
      ...current,
      stories: [...current.stories.map(staleStory), freshCore],
      topStories: current.topStories.map(staleStory).filter((story) => story.primaryBeat !== "science"),
      importantStories: current.importantStories.map(staleStory).filter((story) => story.primaryBeat !== "science"),
    };

    expect(passesPublishGate(regressed)).toBe(false);
  });

  it("allows a fresh core event that is excluded by the publisher diversity limit", () => {
    const current = readBundledReport();
    const staleAt = new Date(Date.parse(current.generatedAt) - 121 * 60_000).toISOString();
    const staleStory = (story: DailyNewsReport["stories"][number]) => ({
      ...story,
      publishedAt: staleAt,
      updatedAt: staleAt,
      evidence: story.evidence.map((evidence) => ({ ...evidence, publishedAt: staleAt })),
    });
    const withPublisher = (story: DailyNewsReport["stories"][number]) => ({
      ...staleStory(story),
      evidence: story.evidence.map((evidence) => ({
        ...evidence,
        sourceId: "saturated-publisher",
        publishedAt: staleAt,
      })),
    });
    const template = current.stories[0];
    const freshCore = {
      ...template,
      id: "fresh-core-diversity-limit",
      itemId: "fresh-core-diversity-limit",
      status: "confirmed" as const,
      tier: "important" as const,
      updatedAt: current.generatedAt,
      evidence: template.evidence.map((evidence) => ({
        ...evidence,
        sourceId: "saturated-publisher",
        publishedAt: current.generatedAt,
      })),
    };
    const report = {
      ...current,
      stories: [...current.stories.map(staleStory), freshCore],
      topStories: current.topStories.map((story, index) => (index < 3 ? withPublisher(story) : staleStory(story))),
      importantStories: current.importantStories.map(staleStory),
    };

    expect(passesPublishGate(report)).toBe(true);
  });

  it("does not force a fresh developing event into the confirmed core", () => {
    const current = readBundledReport();
    const template = current.stories[0];
    const developing = {
      ...template,
      id: "fresh-developing-event",
      itemId: "fresh-developing-event",
      status: "developing" as const,
      tier: "important" as const,
      updatedAt: current.generatedAt,
      evidence: template.evidence.map((evidence) => ({ ...evidence, publishedAt: current.generatedAt })),
    };
    const report = {
      ...current,
      stories: [...current.stories, developing],
      watchlist: [...current.watchlist, developing],
    };

    expect(passesPublishGate(report)).toBe(true);
  });

  it("uses the newest evidence timestamp for public refresh metadata", () => {
    const current = readBundledReport();
    const evidenceTime = new Date(Date.parse(current.generatedAt) + 60_000).toISOString();
    const report = {
      ...current,
      stories: current.stories.map((story, index) =>
        index === 0
          ? {
              ...story,
              updatedAt: evidenceTime,
              evidence: story.evidence.map((evidence) => ({ ...evidence, publishedAt: evidenceTime })),
            }
          : story,
      ),
    };

    expect(newestContentTimestamp(report)).toBe(evidenceTime);
  });
});
