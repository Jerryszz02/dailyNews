import type { UserPreferences } from "../types";

export const defaultPreferences: UserPreferences = {
  topicWeights: {
    ai: "preferred",
    technology: "preferred",
    finance: "preferred",
    international: "preferred",
    policy: "preferred",
    china: "preferred",
    society: "not-preferred",
    science: "preferred",
    sports: "not-preferred",
    entertainment: "not-preferred",
  },
  preferredSources: {},
  blockedKeywords: [],
  boostedKeywords: ["OpenAI", "芯片", "大模型", "AI"],
};
