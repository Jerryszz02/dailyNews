import { categoryImportance, highImpactKeywords, scoringWeights } from "../config/scoring.js";
import { newsSources } from "../config/sources.js";
import type { Category, NewsCluster, RankedNewsItem, ScoreBreakdown, UserPreferences } from "../types";
import { normalizeText } from "./text.js";
import { assessTrust } from "./trust.js";

const preferencePoints = {
  "not-preferred": 0,
  preferred: 30,
} as const;

const sourceById = new Map(newsSources.map((source) => [source.source_id, source]));

export function rankNews(items: NewsCluster[], preferences: UserPreferences, now = new Date()): RankedNewsItem[] {
  return items
    .map((item) => ({
      ...item,
      score_breakdown: scoreNewsItem(item, preferences, now),
      trust: assessTrust(item),
    }))
    .sort((left, right) => right.score_breakdown.final_score - left.score_breakdown.final_score);
}

export function scoreNewsItem(item: NewsCluster, preferences: UserPreferences, now = new Date()): ScoreBreakdown {
  const publicImportance = scorePublicImportance(item);
  const userPreference = scoreUserPreference(item, preferences);
  const timeliness = scoreTimeliness(item, now);
  const sourceConfidence = scoreSourceConfidence(item);
  const contentQuality = scoreContentQuality(item);

  const finalScore = Math.round(
    publicImportance * scoringWeights.public_importance +
      userPreference * scoringWeights.user_preference +
      timeliness * scoringWeights.timeliness +
      sourceConfidence * scoringWeights.source_confidence +
      contentQuality * scoringWeights.content_quality,
  );

  return {
    final_score: clamp(finalScore),
    public_importance: publicImportance,
    user_preference: userPreference,
    timeliness,
    source_confidence: sourceConfidence,
    content_quality: contentQuality,
    ranking_reason: explainRanking(item, {
      final_score: clamp(finalScore),
      public_importance: publicImportance,
      user_preference: userPreference,
      timeliness,
      source_confidence: sourceConfidence,
      content_quality: contentQuality,
      ranking_reason: "",
    }),
  };
}

function scorePublicImportance(item: NewsCluster): number {
  const categoryBase = Math.max(...item.categories.map((category) => categoryImportance[category] ?? 50), 50);
  const text = normalizeText(`${item.title} ${item.summary}`);
  const keywordBoost = highImpactKeywords.some((keyword) => text.includes(normalizeText(keyword))) ? 12 : 0;
  const multiSourceBoost = Math.min(12, Math.max(0, item.sourceIds.length - 1) * 6);
  const wireBoost = item.sourceIds.some((id) => sourceById.get(id)?.mediaType === "wire") ? 5 : 0;

  return clamp(categoryBase + keywordBoost + multiSourceBoost + wireBoost);
}

function scoreUserPreference(item: NewsCluster, preferences: UserPreferences): number {
  const text = normalizeText(`${item.title} ${item.summary}`);
  const blocked = preferences.blockedKeywords.some((keyword) => text.includes(normalizeText(keyword)));
  if (blocked) {
    return 0;
  }

  let score = 45;
  for (const category of item.categories) {
    const strength = preferences.topicWeights[category as Category];
    if (strength) {
      score += preferencePoints[strength];
    }
  }

  for (const keyword of preferences.boostedKeywords) {
    if (text.includes(normalizeText(keyword))) {
      score += 10;
    }
  }

  for (const sourceId of item.sourceIds) {
    score += preferences.preferredSources[sourceId] ?? 0;
  }

  return clamp(score);
}

function scoreTimeliness(item: NewsCluster, now: Date): number {
  if (!item.publishedAt) {
    return 45;
  }

  const ageHours = Math.max(0, (now.getTime() - Date.parse(item.publishedAt)) / 3_600_000);
  if (ageHours <= 1) return 100;
  if (ageHours <= 6) return 90;
  if (ageHours <= 12) return 78;
  if (ageHours <= 24) return 65;
  if (ageHours <= 48) return 42;
  return 20;
}

function scoreSourceConfidence(item: NewsCluster): number {
  const sourceScores = item.sourceIds.map((sourceId) => sourceById.get(sourceId)?.credibility ?? 55);
  const average = sourceScores.reduce((sum, value) => sum + value, 0) / sourceScores.length;
  const confirmationBoost = Math.min(12, Math.max(0, item.sourceIds.length - 1) * 6);
  const paywallPenalty = item.mayHavePaywall ? 5 : 0;
  return clamp(Math.round(average + confirmationBoost - paywallPenalty));
}

function scoreContentQuality(item: NewsCluster): number {
  const hasSummary = item.summary.trim().length >= 60;
  const summaryDepth = Math.min(30, Math.floor(item.summary.length / 12));
  const hasDate = item.publishedAt ? 10 : 0;
  const hasUrl = item.url ? 10 : 0;
  const paywallPenalty = item.mayHavePaywall ? 8 : 0;
  return clamp((hasSummary ? 50 : 30) + summaryDepth + hasDate + hasUrl - paywallPenalty);
}

function explainRanking(item: NewsCluster, score: ScoreBreakdown): string {
  const reasons: string[] = [];
  if (score.public_importance >= 85) reasons.push("公共影响高");
  if (score.user_preference >= 80) reasons.push("匹配你的关注偏好");
  if (score.timeliness >= 85) reasons.push("发布时间较新");
  if (item.sourceIds.length > 1) reasons.push(`${item.sourceNames.length} 个来源相互印证`);
  if (score.source_confidence >= 85) reasons.push("来源可信度高");
  return reasons.length > 0 ? reasons.join("，") + "。" : "综合公共重要性、偏好、时效性和来源可信度排序。";
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}
