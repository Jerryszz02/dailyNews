/**
 * Frozen deterministic Daily News editorial rules from
 * 8519831714b0d6c8183336c81e8190dceddf7843. The inputs below are the
 * former StoryCard fields; collection and publication remain outside this file.
 */
import { normalizeText } from "./text.ts";

export const legacyPolicyVersion = "daily-news:8519831714b0d6c8183336c81e8190dceddf7843";
export const freshCoreWindowMinutes = 120;
export const currentCoreWindowMinutes = 24 * 60;
export const selectionBeatLimit = 3;
export const selectionPublisherLimit = 3;

export type Category = "ai" | "technology" | "finance" | "international" | "china" | "policy" | "society" | "sports" | "entertainment" | "science";
export type EventType = "policy" | "conflict" | "disaster" | "economy" | "company" | "product" | "research" | "culture" | "sports" | "general";
export type StoryStatus = "confirmed" | "developing" | "disputed" | "corrected" | "unverified";
export type ImportanceTier = "must_know" | "important" | "special_interest" | "noise";
export type EvidenceRole = "original" | "confirmation" | "context" | "analysis" | "lead";
export interface Evidence {
  candidateId: string;
  sourceId: string;
  url: string;
  publishedAt?: string;
  role: EvidenceRole;
  independenceGroup: string;
}
export interface ImportanceFeatures {
  publicImpact: number;
  urgency: number;
  sourceSignificance: number;
  evidenceStrength: number;
  total: number;
}
export interface LegacyStory {
  id: string;
  title: string;
  summary: string;
  primaryBeat: Category;
  updatedAt: string;
  publishedAt?: string;
  evidence: Evidence[];
  sourceIds: string[];
  strongestCredibility: number;
  trustLevel: "high" | "medium" | "low";
  trustScore: number;
  urgency: number;
  sourceConfidence: number;
  status: StoryStatus;
  tier: ImportanceTier;
  eventType: EventType;
  importance: ImportanceFeatures;
}

const beatImpactBase: Record<Category, number> = {
  ai: 46, technology: 44, finance: 54, international: 55, china: 58,
  policy: 66, society: 44, sports: 26, entertainment: 22, science: 48,
};

export function scoreTimeliness(publishedAt: string | undefined, now: Date): number {
  if (!publishedAt) return 45;
  const ageHours = Math.max(0, (now.getTime() - Date.parse(publishedAt)) / 3_600_000);
  if (ageHours <= 1) return 100;
  if (ageHours <= 6) return 90;
  if (ageHours <= 12) return 78;
  if (ageHours <= 24) return 65;
  if (ageHours <= 48) return 42;
  return 20;
}

export function inferEventType(textValue: string, beat: Category): EventType {
  const text = normalizeText(textValue);
  if (/(政策|监管|法规|法律|选举|government|policy|regulation|election)/.test(text)) return "policy";
  if (/(战争|冲突|袭击|停火|war|conflict|attack|ceasefire)/.test(text)) return "conflict";
  if (/(地震|洪水|台风|火灾|灾害|earthquake|flood|storm|disaster)/.test(text)) return "disaster";
  if (/(经济|市场|利率|通胀|金融|economy|market|rate|inflation)/.test(text)) return "economy";
  if (/(研究|论文|发现|science|research|study)/.test(text)) return "research";
  if (/(发布|推出|模型|产品|launch|release|model|product)/.test(text)) return "product";
  if (beat === "sports") return "sports";
  if (beat === "entertainment") return "culture";
  if (beat === "finance") return "company";
  return "general";
}

export function storyStatus(evidence: Evidence[], trustLevel: LegacyStory["trustLevel"], strongestCredibility: number): StoryStatus {
  if (evidence.some((entry) => entry.role === "lead") && evidence.length === 1) return "unverified";
  const independentSources = new Set(evidence.map((entry) => entry.independenceGroup)).size;
  if (independentSources >= 2 || trustLevel === "high" || strongestCredibility >= 80) return "confirmed";
  return "developing";
}

export function importanceFeatures(story: Pick<LegacyStory, "title" | "summary" | "primaryBeat" | "urgency" | "sourceConfidence" | "trustScore" | "evidence">, eventType: EventType): ImportanceFeatures {
  const publicImpact = curationPublicImpact(story, eventType);
  const urgency = story.urgency;
  const sourceSignificance = story.sourceConfidence;
  const independentSources = new Set(story.evidence.map((entry) => entry.independenceGroup)).size;
  const evidenceStrength = Math.min(100, story.trustScore + Math.max(0, independentSources - 1) * 8);
  const total = clamp(publicImpact * 0.8 + urgency * 0.2);
  return { publicImpact, urgency, sourceSignificance, evidenceStrength, total };
}

export function importanceTier(importance: ImportanceFeatures, beat: Category): ImportanceTier {
  if (importance.publicImpact >= 82 && importance.total >= 76) return "must_know";
  if (importance.publicImpact >= 58 && importance.total >= 58) return "important";
  if (importance.publicImpact >= 36 && importance.total >= 40) return "special_interest";
  if ((beat === "sports" || beat === "entertainment") && importance.total >= 25) return "special_interest";
  return "noise";
}

export function curationPublicImpact(story: Pick<LegacyStory, "title" | "summary" | "primaryBeat">, eventType: EventType): number {
  const text = normalizeText(`${story.title} ${story.summary}`);
  let score = beatImpactBase[story.primaryBeat];
  if (/(战争|冲突|袭击|火灾|地震|洪水|台风|死亡|伤亡|停火|制裁|禁运|war|conflict|attack|earthquake|flood|deaths|ceasefire|sanction|embargo)/.test(text)) score += 25;
  if (/(全国|全球|国家级|央行|中央银行|政府发布|监管|新规|法律|利率|通胀|关税|global|nationwide|central bank|government announced|regulation|new law|interest rate|inflation|tariff)/.test(text)) score += 14;
  if (/(重大|创纪录|历史新高|首次|突破|紧急|record|all time high|first ever|breakthrough|emergency)/.test(text)) score += 8;
  if (/(生效|执行时间|批准|签署|实施|takes effect|effective date|approved|signed into law)/.test(text)) score += 6;
  if (eventType === "conflict" || eventType === "disaster") score += 10;
  else if (eventType === "policy") score += 8;
  else if (eventType === "economy") score += 6;
  else if (eventType === "research") score += 4;
  if (/(排名|盘点|评论|观点|前景预测|如何看|best chance|ranking|opinion|commentary)/.test(text)) score -= 15;
  if (/(选区|村庄|地方候选人|社区活动|constituency|local candidate)/.test(text) && eventType !== "disaster") score -= 8;
  if (story.primaryBeat === "sports" && !/(决赛|冠军|夺冠|淘汰|纪录|final|champion|title|record)/.test(text)) score -= 8;
  return clamp(score);
}

export function storyActivityTimestamp(story: Pick<LegacyStory, "updatedAt">): number {
  const updatedAt = Date.parse(story.updatedAt);
  return Number.isFinite(updatedAt) ? updatedAt : Number.NEGATIVE_INFINITY;
}

export function isStoryActiveWithin(story: Pick<LegacyStory, "updatedAt">, now: Date, maxAgeMinutes: number): boolean {
  const activityAt = storyActivityTimestamp(story);
  const ageMs = now.getTime() - activityAt;
  return Number.isFinite(activityAt) && ageMs >= 0 && ageMs <= maxAgeMinutes * 60_000;
}

interface FreshnessStage { maxAgeMinutes: number; slots: number }
export function selectDiverse(stories: LegacyStory[], limit: number, now: Date, freshnessStages: FreshnessStage[] = [], sourceCounts = new Map<string, number>()): LegacyStory[] {
  const selected: LegacyStory[] = [];
  const selectedIds = new Set<string>();
  const beatCounts = new Map<Category, number>();
  const ordered = [...stories].sort((left, right) => {
    const importanceDelta = right.importance.total - left.importance.total;
    if (importanceDelta !== 0) return importanceDelta;
    return storyActivityTimestamp(right) - storyActivityTimestamp(left);
  });
  const trySelect = (story: LegacyStory, enforceDiversity = true): boolean => {
    if (selectedIds.has(story.id)) return false;
    const primarySource = story.evidence[0]?.sourceId ?? "unknown";
    if (enforceDiversity && (beatCounts.get(story.primaryBeat) ?? 0) >= selectionBeatLimit) return false;
    if (enforceDiversity && (sourceCounts.get(primarySource) ?? 0) >= selectionPublisherLimit) return false;
    selected.push(story);
    selectedIds.add(story.id);
    beatCounts.set(story.primaryBeat, (beatCounts.get(story.primaryBeat) ?? 0) + 1);
    sourceCounts.set(primarySource, (sourceCounts.get(primarySource) ?? 0) + 1);
    return true;
  };
  for (const stage of freshnessStages) {
    for (const story of ordered) {
      if (selected.length >= Math.min(limit, stage.slots)) break;
      if (!isStoryActiveWithin(story, now, stage.maxAgeMinutes)) continue;
      trySelect(story);
    }
  }
  for (const story of ordered) {
    if (selected.length >= limit) break;
    trySelect(story);
  }
  for (const story of ordered) {
    if (selected.length >= limit) break;
    trySelect(story, false);
  }
  return selected;
}

export function selectCore(stories: LegacyStory[], now: Date): { top: LegacyStory[]; important: LegacyStory[]; watchlist: LegacyStory[] } {
  const corePublisherCounts = new Map<string, number>();
  const top = selectDiverse(stories.filter((story) => story.tier === "must_know"), 10, now, [
    { maxAgeMinutes: freshCoreWindowMinutes, slots: 3 },
    { maxAgeMinutes: currentCoreWindowMinutes, slots: 5 },
  ], corePublisherCounts);
  const topIds = new Set(top.map((story) => story.id));
  const important = selectDiverse(stories.filter((story) => !topIds.has(story.id) && (story.tier === "must_know" || story.tier === "important")), 30, now, [
    { maxAgeMinutes: freshCoreWindowMinutes, slots: 3 },
    { maxAgeMinutes: currentCoreWindowMinutes, slots: 15 },
  ], corePublisherCounts);
  const selectedIds = new Set([...top, ...important].map((story) => story.id));
  const watchlist = selectDiverse(stories.filter((story) => !selectedIds.has(story.id) && story.status !== "confirmed" && (story.status === "unverified" || story.importance.total >= 35)), 8, now, [
    { maxAgeMinutes: freshCoreWindowMinutes, slots: 8 },
    { maxAgeMinutes: currentCoreWindowMinutes, slots: 8 },
  ]);
  return { top, important, watchlist };
}

function clamp(value: number): number { return Math.max(0, Math.min(100, Math.round(value))); }
