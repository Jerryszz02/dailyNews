import { describe, expect, it } from "vitest";
import { defaultPreferences } from "../config/preferences";
import type { Category, RankedNewsItem } from "../types";
import { selectPreferredCategoryItems, sortByHotScoreWithoutPreferences, sortByNewest } from "./newsOrdering";

function item(
  id: string,
  categories: Category[],
  publishedAt: string,
  score: Partial<RankedNewsItem["score_breakdown"]> = {},
): RankedNewsItem {
  return {
    id,
    title: id,
    url: `https://example.com/${id}`,
    sourceId: "reuters",
    sourceName: "Reuters",
    language: "en-US",
    region: "global",
    categories,
    primaryCategory: categories[0],
    summary: `${id} summary with enough detail for ranking tests.`,
    publishedAt,
    extractedAt: publishedAt,
    sourceIds: ["reuters"],
    sourceNames: ["Reuters"],
    relatedUrls: [`https://example.com/${id}`],
    primaryCategoryVotes: [categories[0]],
    score_breakdown: {
      final_score: score.final_score ?? 50,
      public_importance: score.public_importance ?? 50,
      user_preference: score.user_preference ?? 50,
      timeliness: score.timeliness ?? 50,
      source_confidence: score.source_confidence ?? 50,
      content_quality: score.content_quality ?? 50,
      ranking_reason: "",
    },
    trust: {
      score: 70,
      level: "medium",
      shouldShow: true,
      reasons: ["test"],
    },
  };
}

describe("news ordering", () => {
  it("sorts regular lists by newest published time", () => {
    const older = item("older", ["finance"], "2026-06-29T09:00:00.000Z", { final_score: 100 });
    const newer = item("newer", ["finance"], "2026-06-29T11:00:00.000Z", { final_score: 10 });

    expect(sortByNewest([older, newer]).map((news) => news.id)).toEqual(["newer", "older"]);
  });

  it("selects preferred categories and then sorts them by time", () => {
    const lowPreference = item("sports", ["sports"], "2026-06-29T12:00:00.000Z");
    const olderPreference = item("older-ai", ["ai"], "2026-06-29T08:00:00.000Z");
    const newerPreference = item("newer-finance", ["finance"], "2026-06-29T10:00:00.000Z");

    expect(selectPreferredCategoryItems([lowPreference, olderPreference, newerPreference], defaultPreferences).map((news) => news.id)).toEqual([
      "newer-finance",
      "older-ai",
    ]);
  });

  it("orders hot items without using user preference score", () => {
    const preferenceOnly = item("preference-only", ["ai"], "2026-06-29T11:00:00.000Z", {
      final_score: 100,
      public_importance: 45,
      user_preference: 100,
      timeliness: 45,
      source_confidence: 50,
      content_quality: 50,
    });
    const publicImpact = item("public-impact", ["policy"], "2026-06-29T09:00:00.000Z", {
      final_score: 80,
      public_importance: 90,
      user_preference: 20,
      timeliness: 80,
      source_confidence: 85,
      content_quality: 80,
    });

    expect(sortByHotScoreWithoutPreferences([preferenceOnly, publicImpact])[0].id).toBe("public-impact");
  });
});
