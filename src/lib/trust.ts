import { newsSources } from "../config/sources.js";
import type { NewsCluster, TrustAssessment, TrustLevel } from "../types";

const sourceById = new Map(newsSources.map((source) => [source.source_id, source]));

export function assessTrust(item: NewsCluster): TrustAssessment {
  const reasons: string[] = [];
  let score = 35;

  const sources = item.sourceIds.map((sourceId) => sourceById.get(sourceId));
  const averageCredibility =
    sources.reduce((sum, source) => sum + (source?.credibility ?? 45), 0) / Math.max(1, item.sourceIds.length);
  score += (averageCredibility - 50) * 0.55;

  if (sources.some((source) => source?.mediaType === "official")) {
    score += 18;
    reasons.push("官方来源");
  }
  if (sources.some((source) => source?.mediaType === "wire")) {
    score += 16;
    reasons.push("通讯社来源");
  }
  if (sources.some((source) => source?.mediaType === "social")) {
    score -= 16;
    reasons.push("社交媒体单点信息需谨慎");
  }
  if (item.sourceIds.length > 1) {
    score += Math.min(18, (item.sourceIds.length - 1) * 8);
    reasons.push("多信源相互印证");
  }
  if (item.publishedAt) {
    score += 6;
    reasons.push("包含发布时间");
  } else {
    score -= 8;
    reasons.push("缺少发布时间");
  }
  if (item.summary.trim().length >= 60) {
    score += 6;
    reasons.push("摘要信息完整");
  } else {
    score -= 8;
    reasons.push("摘要信息较少");
  }
  if (item.mayHavePaywall) {
    score -= 4;
    reasons.push("付费墙来源只使用公开元数据");
  }
  if (!item.title.trim() || !item.url.trim()) {
    score = 0;
    reasons.push("缺少标题或链接");
  }

  const roundedScore = clamp(score);
  return {
    score: roundedScore,
    level: trustLevel(roundedScore),
    shouldShow: roundedScore >= 25,
    reasons: reasons.length > 0 ? reasons : ["基础来源信息可用"],
  };
}

function trustLevel(score: number): TrustLevel {
  if (score >= 75) return "high";
  if (score >= 50) return "medium";
  return "low";
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}
