import { describe, expect, it } from "vitest";
import { defaultPreferences } from "../config/preferences";
import { firecrawlSnapshotNews } from "../data/firecrawlSnapshot";
import { buildDailyReport } from "./newsPipeline";
import { rankNews } from "./scoring";
import { compactDailyNewsReport, hydrateWebDailyNewsReport, isWebDailyNewsReport } from "./webReport";
import type { UserPreferences } from "../types";

describe("web report representation", () => {
  it("round-trips visible sections and preserves default ranking order", () => {
    const full = buildDailyReport(firecrawlSnapshotNews, defaultPreferences, new Date("2026-07-09T15:39:06.365Z"));
    const compact = compactDailyNewsReport(full);
    const hydrated = hydrateWebDailyNewsReport(compact);
    const now = new Date(full.generatedAt);
    const customPreferences: UserPreferences = {
      topicWeights: { ai: "preferred", technology: "preferred" },
      preferredSources: { xinhua: 20, the_verge: 10 },
      blockedKeywords: ["比赛"],
      boostedKeywords: ["人工智能", "芯片"],
    };

    expect(isWebDailyNewsReport(compact)).toBe(true);
    expect(compact).not.toHaveProperty("items");
    expect(compact).not.toHaveProperty("topStories");
    expect(hydrated.stories.map((story) => story.id)).toEqual(full.stories.map((story) => story.id));
    expect(hydrated.topStories.map((story) => story.id)).toEqual(full.topStories.map((story) => story.id));
    expect(hydrated.importantStories.map((story) => story.id)).toEqual(full.importantStories.map((story) => story.id));
    expect(hydrated.watchlist.map((story) => story.id)).toEqual(full.watchlist.map((story) => story.id));
    expect(rankNews(hydrated.items, defaultPreferences, now).map((item) => item.id)).toEqual(
      rankNews(full.items, defaultPreferences, now).map((item) => item.id),
    );
    expect(rankNews(hydrated.items, customPreferences, now).map((item) => item.id)).toEqual(
      rankNews(full.items, customPreferences, now).map((item) => item.id),
    );
    expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(full).length * 0.7);
  });

  it("rejects malformed web representations before hydration", () => {
    const full = buildDailyReport(firecrawlSnapshotNews, defaultPreferences, new Date("2026-07-09T15:39:06.365Z"));
    const compact = compactDailyNewsReport(full);

    expect(isWebDailyNewsReport({ ...compact, generatedAt: "invalid" })).toBe(false);
    expect(isWebDailyNewsReport({ ...compact, topStoryIds: ["missing-story"] })).toBe(false);
    expect(isWebDailyNewsReport({ ...compact, rankingMetadata: {} })).toBe(false);
  });
});
