import type { Category } from "../types";

export const scoringWeights = {
  public_importance: 0.5,
  user_preference: 0.2,
  timeliness: 0.15,
  source_confidence: 0.1,
  content_quality: 0.05,
} as const;

export const categoryImportance: Record<Category, number> = {
  ai: 78,
  technology: 72,
  finance: 76,
  international: 82,
  china: 80,
  policy: 84,
  society: 62,
  sports: 45,
  entertainment: 40,
  science: 70,
};

export const highImpactKeywords = [
  "war",
  "conflict",
  "election",
  "sanction",
  "rate cut",
  "rate hike",
  "inflation",
  "ai model",
  "semiconductor",
  "cyberattack",
  "regulation",
  "earthquake",
  "战争",
  "冲突",
  "选举",
  "制裁",
  "降息",
  "加息",
  "通胀",
  "大模型",
  "芯片",
  "网络攻击",
  "监管",
  "地震",
];
