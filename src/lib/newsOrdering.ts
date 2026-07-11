import { scoringWeights } from "../config/scoring.js";
import type { RankedNewsItem, StoryCard, UserPreferences } from "../types";
import { normalizeText } from "./text.js";

export function sortByNewest(items: RankedNewsItem[]): RankedNewsItem[] {
  return [...items].sort(compareNewest);
}

export function sortStoriesByNewest(stories: StoryCard[]): StoryCard[] {
  return [...stories].sort((left, right) => {
    const timeDelta = storyTime(right) - storyTime(left);
    return timeDelta !== 0 ? timeDelta : left.id.localeCompare(right.id);
  });
}

export function sortByHotScoreWithoutPreferences(items: RankedNewsItem[]): RankedNewsItem[] {
  return [...items].sort((left, right) => {
    const scoreDelta = scoreWithoutPreference(right) - scoreWithoutPreference(left);
    return scoreDelta !== 0 ? scoreDelta : compareNewest(left, right);
  });
}

export function selectPreferredCategoryItems(items: RankedNewsItem[], preferences: UserPreferences): RankedNewsItem[] {
  return sortByNewest(items.filter((item) => isPreferredCategoryItem(item, preferences)));
}

export function scoreWithoutPreference(item: RankedNewsItem): number {
  const { score_breakdown: score } = item;
  return Math.round(
    score.public_importance * scoringWeights.public_importance +
      score.timeliness * scoringWeights.timeliness +
      score.source_confidence * scoringWeights.source_confidence +
      score.content_quality * scoringWeights.content_quality,
  );
}

function isPreferredCategoryItem(item: RankedNewsItem, preferences: UserPreferences): boolean {
  const text = normalizeText(`${item.title} ${item.summary}`);
  if (preferences.blockedKeywords.some((keyword) => text.includes(normalizeText(keyword)))) {
    return false;
  }

  return item.categories.some((category) => {
    const strength = preferences.topicWeights[category];
    return strength === "preferred";
  });
}

function compareNewest(left: RankedNewsItem, right: RankedNewsItem): number {
  const timeDelta = itemTime(right) - itemTime(left);
  return timeDelta !== 0 ? timeDelta : left.id.localeCompare(right.id);
}

function itemTime(item: RankedNewsItem): number {
  const value = Date.parse(item.publishedAt ?? item.extractedAt);
  return Number.isNaN(value) ? 0 : value;
}

function storyTime(story: StoryCard): number {
  const value = Date.parse(story.publishedAt ?? story.updatedAt);
  return Number.isNaN(value) ? 0 : value;
}
