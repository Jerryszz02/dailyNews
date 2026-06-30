import type { UserPreferences } from "../types";

export const defaultPreferences: UserPreferences = {
  topicWeights: {
    ai: "high",
    technology: "high",
    finance: "medium",
    international: "medium",
    policy: "medium",
    china: "medium",
    society: "low",
    science: "medium",
    sports: "low",
    entertainment: "low",
  },
  regionMode: "balanced",
  preferredSources: {},
  blockedKeywords: [],
  boostedKeywords: ["OpenAI", "芯片", "大模型", "AI"],
};
