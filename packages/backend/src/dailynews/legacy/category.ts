/** Frozen choosePrimaryCategory vote and keyword order from src/lib/dedupe.ts at 85198317. */
import { normalizeText } from "./text.ts";
import type { Category } from "./curation.ts";

const categoryPriority: Category[] = ["sports", "ai", "technology", "finance", "policy", "china", "international", "science", "society", "entertainment"];
const categoryKeywords: Record<Category, string[]> = {
  ai: ["ai", "artificial intelligence", "openai", "anthropic", "claude", "chatgpt", "大模型", "人工智能", "模型"],
  technology: ["technology", "tech", "startup", "software", "chip", "semiconductor", "科技", "芯片", "软件"],
  finance: ["market", "stock", "bank", "finance", "economy", "inflation", "财经", "金融", "市场", "经济"],
  international: ["world", "global", "war", "conflict", "diplomacy", "国际", "全球", "战争", "冲突"],
  china: ["china", "chinese", "beijing", "中国", "国内", "北京"],
  policy: ["policy", "regulation", "government", "election", "law", "政策", "监管", "政府", "选举"],
  society: ["society", "city", "education", "health", "社会", "教育", "健康", "城市"],
  sports: ["nba", "fifa", "fiba", "basketball", "football", "soccer", "sport", "体育", "篮球", "足球"],
  entertainment: ["film", "movie", "tv", "music", "entertainment", "电影", "影视", "娱乐", "音乐"],
  science: ["science", "research", "study", "space", "physics", "科学", "研究", "太空"],
};

export function choosePrimaryCategory(input: { title: string; summary: string; categories: Category[]; primaryCategoryVotes: Category[] }): Category {
  const scores = new Map<Category, number>();
  for (const category of input.categories) scores.set(category, 1);
  for (const category of input.primaryCategoryVotes) scores.set(category, (scores.get(category) ?? 0) + 8);
  const text = normalizeText(`${input.title} ${input.summary}`);
  for (const category of input.categories) {
    const keywordHits = categoryKeywords[category].filter((keyword) => text.includes(normalizeText(keyword))).length;
    scores.set(category, (scores.get(category) ?? 0) + keywordHits * 3);
  }
  return [...scores.entries()].sort((left, right) => {
    const scoreDelta = right[1] - left[1];
    if (scoreDelta !== 0) return scoreDelta;
    return categoryPriority.indexOf(left[0]) - categoryPriority.indexOf(right[0]);
  })[0]?.[0] ?? input.categories[0] ?? "society";
}
