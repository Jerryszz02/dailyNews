import { describe, expect, it } from "vitest";
import { firecrawlSnapshotNews } from "../src/data/firecrawlSnapshot";
import { selectLatestStories } from "../src/lib/curation";
import type { DailyNewsReport } from "../src/types";
import {
  expandLegacyItems,
  InMemoryNewsReportStore,
  passesPublishGate,
  readBundledReport,
  validateReportInvariants,
} from "./reportStore";
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

  it("does not block a structurally valid refresh when a core beat is temporarily quiet", () => {
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

    expect(passesPublishGate(regressed, current)).toBe(true);
  });

  it("does not use relative event counts as a publication gate", () => {
    const current = readBundledReport();
    const regressed = {
      ...current,
      quality: {
        ...current.quality,
        selectedEventCount: Math.max(10, Math.floor(current.quality.selectedEventCount * 0.5)),
      },
    };

    expect(passesPublishGate(regressed, current)).toBe(true);
  });

  it("does not require fresh events to appear in a curated core section", () => {
    const current = readBundledReport();
    const staleAt = new Date(Date.parse(current.generatedAt) - 121 * 60_000).toISOString();
    const staleStory = (story: DailyNewsReport["stories"][number]) => ({
      ...story,
      startedAt: staleAt,
      publishedAt: staleAt,
      updatedAt: staleAt,
      evidence: story.evidence.map((evidence) => ({ ...evidence, publishedAt: staleAt })),
    });
    const template = current.stories[0];
    const freshCore = {
      ...template,
      primaryBeat: "science" as const,
      status: "confirmed" as const,
      tier: "important" as const,
      updatedAt: current.generatedAt,
      evidence: template.evidence.map((evidence) => ({
        ...evidence,
        publishedAt: current.generatedAt,
      })),
    };
    const stories = [freshCore, ...current.stories.slice(1).map(staleStory)];
    const storyById = new Map(stories.map((story) => [story.id, story]));
    const latestStories = selectLatestStories(stories, new Date(current.generatedAt));
    const regressed = {
      ...current,
      stories,
      latestStories,
      topStories: current.topStories.filter((story) => story.id !== template.id).map((story) => storyById.get(story.id)!),
      importantStories: current.importantStories.filter((story) => story.id !== template.id).map((story) => storyById.get(story.id)!),
      watchlist: current.watchlist.filter((story) => story.id !== template.id).map((story) => storyById.get(story.id)!),
      quality: { ...current.quality, latestEventCount: latestStories.length },
    };

    expect(passesPublishGate(regressed)).toBe(true);
  });

  it("rejects a report with a dangling selected story reference", () => {
    const current = readBundledReport();
    const dangling = { ...current.stories[0], id: "missing-story" };
    expect(passesPublishGate({ ...current, latestStories: [dangling] })).toBe(false);
  });

  it("reports invalid event time, source URL, and duplicate candidate mappings", () => {
    const current = readBundledReport();
    const first = current.stories[0]!;
    const second = current.stories[1]!;
    const invalid = {
      ...current,
      stories: current.stories.map((story, index) => {
        if (index === 0) {
          return {
            ...story,
            startedAt: new Date(Date.parse(story.updatedAt) + 60_000).toISOString(),
            evidence: story.evidence.map((evidence, evidenceIndex) =>
              evidenceIndex === 0 ? { ...evidence, url: "https://example.com/out-of-scope" } : evidence),
          };
        }
        if (index === 1 && first.evidence[0]) {
          return {
            ...story,
            evidence: story.evidence.map((evidence, evidenceIndex) =>
              evidenceIndex === 0 ? { ...evidence, candidateId: first.evidence[0].candidateId } : evidence),
          };
        }
        return story;
      }),
    };

    expect(second).toBeDefined();
    expect(validateReportInvariants(invalid)).toEqual(expect.arrayContaining([
      "invalid_story_time_relation",
      "evidence_url_out_of_scope",
      "duplicate_or_missing_candidate_mapping",
    ]));
  });

  it("allows a fresh core event that is excluded by the publisher diversity limit", () => {
    const current = readBundledReport();
    const staleAt = new Date(Date.parse(current.generatedAt) - 121 * 60_000).toISOString();
    const staleStory = (story: DailyNewsReport["stories"][number]) => ({
      ...story,
      startedAt: staleAt,
      publishedAt: staleAt,
      updatedAt: staleAt,
      evidence: story.evidence.map((evidence) => ({ ...evidence, publishedAt: staleAt })),
    });
    const withPublisher = (story: DailyNewsReport["stories"][number]) => ({
      ...staleStory(story),
      evidence: story.evidence.map((evidence) => ({
        ...evidence,
        sourceId: "xinhua",
        sourceName: "新华网",
        url: `https://www.news.cn/test/${evidence.candidateId}`,
        publishedAt: staleAt,
      })),
    });
    const template = current.stories[0];
    const freshCore = {
      ...template,
      status: "confirmed" as const,
      tier: "important" as const,
      updatedAt: current.generatedAt,
      evidence: template.evidence.map((evidence) => ({
        ...evidence,
        publishedAt: current.generatedAt,
      })),
    };
    const saturatedStoryIds = new Set(
      current.topStories.filter((story) => story.id !== template.id).slice(0, 3).map((story) => story.id),
    );
    const stories = [
      freshCore,
      ...current.stories.slice(1).map((story) =>
        saturatedStoryIds.has(story.id) ? withPublisher(story) : staleStory(story)),
    ];
    const storyById = new Map(stories.map((story) => [story.id, story]));
    const latestStories = selectLatestStories(stories, new Date(current.generatedAt));
    const report = {
      ...current,
      stories,
      latestStories,
      topStories: current.topStories
        .filter((story) => story.id !== template.id)
        .map((story) => storyById.get(story.id)!),
      importantStories: current.importantStories
        .filter((story) => story.id !== template.id)
        .map((story) => storyById.get(story.id)!),
      watchlist: current.watchlist.filter((story) => story.id !== template.id).map((story) => storyById.get(story.id)!),
      sourceCount: new Set(stories.flatMap((story) => story.evidence.map((evidence) => evidence.sourceId))).size,
      quality: { ...current.quality, latestEventCount: latestStories.length },
    };

    expect(passesPublishGate(report)).toBe(true);
  });

  it("does not force a fresh developing event into the confirmed core", () => {
    const current = readBundledReport();
    const template = current.stories[0];
    const developing = {
      ...template,
      status: "developing" as const,
      tier: "important" as const,
      updatedAt: current.generatedAt,
      evidence: template.evidence.map((evidence) => ({ ...evidence, publishedAt: current.generatedAt })),
    };
    const stories = [developing, ...current.stories.slice(1)];
    const report = {
      ...current,
      stories,
      latestStories: selectLatestStories(stories, new Date(current.generatedAt)),
      topStories: current.topStories.filter((story) => story.id !== template.id),
      importantStories: current.importantStories.filter((story) => story.id !== template.id),
      watchlist: [...current.watchlist.filter((story) => story.id !== template.id), developing],
    };

    expect(passesPublishGate(report)).toBe(true);
  });

  it("uses event updatedAt rather than evidence publication time for refresh metadata", () => {
    const current = readBundledReport();
    const updatedAt = new Date(Date.parse(current.generatedAt) + 60_000).toISOString();
    const evidenceTime = new Date(Date.parse(current.generatedAt) + 120_000).toISOString();
    const report = {
      ...current,
      stories: current.stories.map((story, index) =>
        index === 0
          ? {
              ...story,
              updatedAt,
              evidence: story.evidence.map((evidence) => ({ ...evidence, publishedAt: evidenceTime })),
            }
          : story,
      ),
    };

    expect(newestContentTimestamp(report)).toBe(updatedAt);
  });
});
