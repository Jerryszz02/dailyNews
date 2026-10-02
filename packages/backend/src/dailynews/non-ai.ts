import {
  importanceFeatures, importanceTier, inferEventType, legacyPolicyVersion,
  scoreTimeliness, selectCore, storyStatus, type Category, type Evidence,
  type ImportanceFeatures, type ImportanceTier, type LegacyStory, type StoryStatus,
} from "./legacy/curation.ts";
import { choosePrimaryCategory } from "./legacy/category.ts";
import { hostnameFromUrl } from "./legacy/text.ts";

export type NonAiCategory = Exclude<Category, "ai">;
export const nonAiPolicyVersion = `${legacyPolicyVersion}:adapter-v1`;
export interface NonAiEvidenceInput {
  articleId: string;
  legacySourceId: string;
  url: string;
  title: string;
  summary: string;
  primaryCategory: Category;
  categories?: Category[];
  publishedAt?: string;
  updatedAt?: string;
  discoveredAt?: string;
  extractedAt?: string;
  sourceName?: string;
  sourceCredibility: number;
  mediaType?: "official" | "wire" | "social" | "other";
  signalRole?: "first_party" | "reporting" | "analysis" | "discussion";
  /** Relationship to this fact; mentions and composites cannot represent it. */
  association?: "primary" | "mention" | "composite";
  /** Publication gate result supplied by the caller; false excludes only representation. */
  eligibleForPublication?: boolean;
  mayHavePaywall?: boolean;
}
export interface NonAiFactInput {
  factId: string;
  primaryCategory: NonAiCategory;
  evidence: NonAiEvidenceInput[];
  /** Optional event text from a curator; otherwise first evidence title and longest summary. */
  title?: string;
  summary?: string;
  /** Existing fact start and activity times take precedence over derived article dates. */
  publishedAt?: string;
  updatedAt?: string;
}
export interface NonAiFactDecision {
  factId: string;
  primaryCategory: NonAiCategory;
  policyId: "daily-news-non-ai";
  policyVersion: string;
  importance: ImportanceFeatures;
  scoreKind: "legacy_curation_total";
  score: number;
  tier: ImportanceTier;
  status: StoryStatus;
  representativeArticleId: string | null;
  representativeCandidates: string[];
  selected: boolean;
  collection: "top" | "important" | "watchlist" | null;
  nextReevaluationAt: string | null;
}
export interface NonAiEvaluation {
  facts: NonAiFactDecision[];
  topIds: string[];
  importantIds: string[];
  watchlistIds: string[];
  nextReevaluationAt: string | null;
}

export function chooseFactCategory(evidence: Pick<NonAiEvidenceInput, "title" | "summary" | "primaryCategory" | "categories">[]): Category {
  const first = evidence[0];
  if (!first) throw new Error("Cannot classify a fact without evidence");
  const categories = [...new Set(evidence.flatMap((item) => item.categories ?? [item.primaryCategory]))];
  return choosePrimaryCategory({
    title: first.title,
    summary: evidence.reduce((longest, item) => item.summary.length > longest.length ? item.summary : longest, first.summary),
    categories,
    primaryCategoryVotes: evidence.map((item) => item.primaryCategory),
  });
}

export function evaluateNonAiFacts(inputs: NonAiFactInput[], now: Date): NonAiEvaluation {
  if (!Number.isFinite(now.getTime())) throw new Error("now must be a valid Date");
  const seen = new Set<string>();
  const stories = inputs.map((input) => {
    if (seen.has(input.factId)) throw new Error(`Duplicate fact id: ${input.factId}`);
    seen.add(input.factId);
    if ((input.primaryCategory as Category) === "ai") throw new Error("AI facts require the AI policy");
    if (!input.evidence.length) throw new Error(`Fact ${input.factId} has no evidence`);
    return toLegacyStory(input, now);
  });
  const core = selectCore(stories, now);
  const topIds = core.top.map((story) => story.id);
  const importantIds = core.important.map((story) => story.id);
  const watchlistIds = core.watchlist.map((story) => story.id);
  const topSet = new Set(topIds), importantSet = new Set(importantIds), watchlistSet = new Set(watchlistIds);
  const facts = inputs.map((input, index): NonAiFactDecision => {
    const story = stories[index]!;
    const collection = topSet.has(story.id) ? "top" : importantSet.has(story.id) ? "important" : watchlistSet.has(story.id) ? "watchlist" : null;
    const representativeCandidates = representativeOrder(input.evidence);
    return {
      factId: input.factId, primaryCategory: input.primaryCategory,
      policyId: "daily-news-non-ai", policyVersion: nonAiPolicyVersion,
      importance: story.importance, scoreKind: "legacy_curation_total", score: story.importance.total,
      tier: story.tier, status: story.status,
      representativeArticleId: representativeCandidates[0] ?? null, representativeCandidates,
      selected: (collection === "top" || collection === "important") && representativeCandidates.length > 0, collection,
      nextReevaluationAt: nextReevaluationAt(input, now),
    };
  });
  const next = facts.map((fact) => fact.nextReevaluationAt).filter((value): value is string => value !== null).sort()[0] ?? null;
  return { facts, topIds, importantIds, watchlistIds, nextReevaluationAt: next };
}

function toLegacyStory(input: NonAiFactInput, now: Date): LegacyStory {
  const first = input.evidence[0]!;
  const sourceIds = [...new Set(input.evidence.map((item) => item.legacySourceId))];
  const sourceInfo = sourceIds.map((id) => input.evidence.find((item) => item.legacySourceId === id)!);
  const title = input.title ?? first.title;
  const summary = input.summary ?? input.evidence.reduce((longest, item) => item.summary.length > longest.length ? item.summary : longest, first.summary);
  const publishedAt = input.publishedAt ?? earliestDate(input.evidence.map((item) => item.publishedAt));
  const updatedAt = input.updatedAt ?? latestDate(input.evidence.map((item) => item.updatedAt ?? item.publishedAt ?? item.discoveredAt ?? item.extractedAt)) ?? "1970-01-01T00:00:00.000Z";
  const evidence: Evidence[] = input.evidence.map((item) => ({
    candidateId: item.articleId, sourceId: item.legacySourceId, url: item.url,
    publishedAt: item.publishedAt,
    role: item.signalRole === "first_party" ? "original" : item.signalRole === "reporting" ? "confirmation" : item.signalRole === "discussion" ? "lead" : item.signalRole === "analysis" ? "analysis" : "context",
    independenceGroup: hostnameFromUrl(item.url) || item.legacySourceId,
  }));
  const avgCredibility = sourceInfo.reduce((sum, item) => sum + item.sourceCredibility, 0) / Math.max(1, sourceIds.length);
  let trustScore = 35 + (avgCredibility - 50) * 0.55;
  if (sourceInfo.some((item) => item.mediaType === "official")) trustScore += 18;
  if (sourceInfo.some((item) => item.mediaType === "wire")) trustScore += 16;
  if (sourceInfo.some((item) => item.mediaType === "social")) trustScore -= 16;
  if (sourceIds.length > 1) trustScore += Math.min(18, (sourceIds.length - 1) * 8);
  trustScore += publishedAt ? 6 : -8;
  trustScore += informationLength(summary) >= 60 ? 6 : -8;
  if (first.mayHavePaywall) trustScore -= 4;
  if (!title.trim() || !first.url.trim()) trustScore = 0;
  trustScore = clamp(trustScore);
  const trustLevel = trustScore >= 75 ? "high" : trustScore >= 50 ? "medium" : "low";
  const urgency = scoreTimeliness(publishedAt, now);
  const sourceConfidence = clamp(60 + Math.min(12, Math.max(0, sourceIds.length - 1) * 6));
  const eventType = inferEventType(`${title} ${summary}`, input.primaryCategory);
  const status = storyStatus(evidence, trustLevel, Math.max(...sourceIds.map((id) => sourceInfo.find((item) => item.legacySourceId === id)?.sourceCredibility ?? 0), 0));
  const importance = importanceFeatures({ title, summary, primaryBeat: input.primaryCategory, urgency, sourceConfidence, trustScore, evidence }, eventType);
  return { id: input.factId, title, summary, primaryBeat: input.primaryCategory, publishedAt, updatedAt, evidence, sourceIds,
    strongestCredibility: Math.max(...sourceInfo.map((item) => item.sourceCredibility), 0), trustLevel, trustScore,
    urgency, sourceConfidence, status, eventType, importance, tier: importanceTier(importance, input.primaryCategory) };
}

function representativeOrder(items: NonAiEvidenceInput[]): string[] {
  const roleRank = { first_party: 0, reporting: 1, analysis: 3, discussion: 4 } as const;
  return items.filter((item) => item.eligibleForPublication !== false && (!item.association || item.association === "primary")).sort((left, right) => {
    const rank = (left.signalRole ? roleRank[left.signalRole] : 2) - (right.signalRole ? roleRank[right.signalRole] : 2);
    return rank || right.sourceCredibility - left.sourceCredibility || left.articleId.localeCompare(right.articleId);
  }).map((item) => item.articleId);
}

function nextReevaluationAt(input: NonAiFactInput, now: Date): string | null {
  const boundaries: number[] = [];
  const publication = input.publishedAt ?? earliestDate(input.evidence.map((item) => item.publishedAt));
  if (publication) {
    const at = Date.parse(publication);
    if (Number.isFinite(at)) for (const hours of [1, 6, 12, 24, 48]) boundaries.push(at + hours * 3_600_000 + 1);
  }
  const updated = input.updatedAt ?? latestDate(input.evidence.map((item) => item.updatedAt ?? item.publishedAt ?? item.discoveredAt ?? item.extractedAt));
  if (updated) {
    const at = Date.parse(updated);
    if (Number.isFinite(at)) for (const hours of [2, 24, 72]) boundaries.push(at + hours * 3_600_000 + 1);
  }
  const next = boundaries.filter((at) => at > now.getTime()).sort((a, b) => a - b)[0];
  return next === undefined ? null : new Date(next).toISOString();
}
function earliestDate(values: Array<string | undefined>): string | undefined {
  const dates = values.filter((value): value is string => value !== undefined && Number.isFinite(Date.parse(value)));
  return dates.sort((a, b) => Date.parse(a) - Date.parse(b))[0];
}
function latestDate(values: Array<string | undefined>): string | undefined {
  const dates = values.filter((value): value is string => value !== undefined && Number.isFinite(Date.parse(value)));
  return dates.sort((a, b) => Date.parse(b) - Date.parse(a))[0];
}
function informationLength(value: string): number {
  const compact = value.replace(/\s+/g, "");
  const hanCount = (compact.match(/[\u3400-\u9fff]/g) ?? []).length;
  return compact.length + hanCount;
}
function clamp(value: number): number { return Math.max(0, Math.min(100, Math.round(value))); }
