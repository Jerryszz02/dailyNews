import { describe, expect, it } from "vitest";
import { defaultPreferences } from "../config/preferences";
import type { NewsCluster, RawNewsItem } from "../types";
import { clusterNews } from "./dedupe";
import { buildDailyReport } from "./newsPipeline";
import { scoreNewsItem } from "./scoring";

const now = new Date("2026-06-29T12:00:00.000Z");

function cluster(item: RawNewsItem): NewsCluster {
  return {
    ...item,
    sourceIds: [item.sourceId],
    sourceNames: [item.sourceName],
    relatedUrls: [item.url],
  };
}

describe("scoring", () => {
  it("keeps public importance ahead of pure preference boosts", () => {
    const majorPolicy = cluster({
      id: "major-policy",
      title: "Global central banks announce emergency rate cut after market stress",
      url: "https://example.com/major-policy",
      sourceId: "reuters",
      sourceName: "Reuters",
      language: "en-US",
      region: "global",
      categories: ["finance", "international", "policy"],
      summary: "Major central banks coordinated an emergency rate cut after market stress, with broad implications for currencies, bonds and households.",
      publishedAt: "2026-06-29T10:00:00.000Z",
      extractedAt: now.toISOString(),
    });

    const nicheAi = cluster({
      id: "niche-ai",
      title: "AI startup launches a small meeting notes assistant",
      url: "https://example.com/niche-ai",
      sourceId: "techcrunch",
      sourceName: "TechCrunch",
      language: "en-US",
      region: "us",
      categories: ["ai", "technology"],
      summary: "A startup launched a narrow productivity feature for meeting notes and internal document search.",
      publishedAt: "2026-06-29T11:30:00.000Z",
      extractedAt: now.toISOString(),
    });

    const majorScore = scoreNewsItem(majorPolicy, defaultPreferences, now).final_score;
    const aiScore = scoreNewsItem(nicheAi, defaultPreferences, now).final_score;

    expect(majorScore).toBeGreaterThan(aiScore);
  });

  it("moves preferred technology stories upward when public importance is close", () => {
    const report = buildDailyReport(
      [
        {
          id: "tech",
          title: "AI model regulation proposal affects enterprise deployments",
          url: "https://example.com/tech",
          sourceId: "techcrunch",
          sourceName: "TechCrunch",
          language: "en-US",
          region: "us",
          categories: ["ai", "technology", "policy"],
          summary: "A new proposal could change enterprise AI deployment requirements and compliance timelines.",
          publishedAt: "2026-06-29T09:00:00.000Z",
          extractedAt: now.toISOString(),
        },
        {
          id: "society",
          title: "City announces new transit schedule for summer",
          url: "https://example.com/transit",
          sourceId: "bbc",
          sourceName: "BBC",
          language: "en-US",
          region: "global",
          categories: ["society", "international"],
          summary: "A large city announced a summer transit schedule, affecting local commuters and visitors.",
          publishedAt: "2026-06-29T09:00:00.000Z",
          extractedAt: now.toISOString(),
        },
      ],
      defaultPreferences,
      now,
    );

    expect(report.items[0].id).toBe("tech");
  });

  it("reacts to changed topic preferences", () => {
    const rawItems: RawNewsItem[] = [
      {
        id: "ai",
        title: "AI model platform launches a new coding workflow",
        url: "https://example.com/ai",
        sourceId: "techcrunch",
        sourceName: "TechCrunch",
        language: "en-US",
        region: "us",
        categories: ["ai", "technology"],
        summary: "A new AI model platform focuses on coding agents, workflow automation and software development.",
        publishedAt: "2026-06-29T09:00:00.000Z",
        extractedAt: now.toISOString(),
      },
      {
        id: "finance",
        title: "Central bank rules change enterprise financing plans",
        url: "https://example.com/finance",
        sourceId: "bloomberg",
        sourceName: "Bloomberg",
        language: "en-US",
        region: "global",
        categories: ["finance", "policy"],
        summary: "New central bank rules changed financing plans for enterprise technology investments and debt markets.",
        publishedAt: "2026-06-29T09:00:00.000Z",
        extractedAt: now.toISOString(),
      },
    ];

    const defaultReport = buildDailyReport(rawItems, defaultPreferences, now);
    const sportsReport = buildDailyReport(
      rawItems,
      {
        ...defaultPreferences,
        topicWeights: {
          ...defaultPreferences.topicWeights,
          ai: "low",
          technology: "low",
          finance: "high",
          policy: "high",
        },
        boostedKeywords: [],
      },
      now,
    );

    expect(defaultReport.items[0].id).toBe("ai");
    expect(sportsReport.items[0].id).toBe("finance");
  });
});

describe("dedupe", () => {
  it("clusters the same event from multiple sources", () => {
    const items: RawNewsItem[] = [
      {
        id: "one",
        title: "Advanced AI chip supply chain regulation intensifies",
        url: "https://example.com/one",
        sourceId: "reuters",
        sourceName: "Reuters",
        language: "en-US",
        region: "global",
        categories: ["ai", "technology", "policy"],
        summary: "Governments are increasing regulation of advanced AI chip supply chains and cloud computing access.",
        publishedAt: now.toISOString(),
        extractedAt: now.toISOString(),
      },
      {
        id: "two",
        title: "Advanced AI chip supply chain rules intensify",
        url: "https://example.com/two",
        sourceId: "bbc",
        sourceName: "BBC",
        language: "en-US",
        region: "global",
        categories: ["ai", "technology", "international"],
        summary: "New rules target advanced AI chip supply chains and related computing infrastructure.",
        publishedAt: now.toISOString(),
        extractedAt: now.toISOString(),
      },
    ];

    const clusters = clusterNews(items);

    expect(clusters).toHaveLength(1);
    expect(clusters[0].sourceNames).toEqual(["Reuters", "BBC"]);
    expect(clusters[0].relatedUrls).toHaveLength(2);
  });
});
