import { newsSources } from "../config/sources.js";
import type {
  Category,
  CoverageSummary,
  EventType,
  ImportanceFeatures,
  ImportanceTier,
  PublicQualitySummary,
  RankedNewsItem,
  RawNewsItem,
  StoryCard,
  StoryEvidence,
  StorySection,
  StoryStatus,
} from "../types";
import { hostnameFromUrl, normalizeText, tokenize } from "./text.js";

const allBeats: Category[] = [
  "ai",
  "technology",
  "finance",
  "international",
  "china",
  "policy",
  "society",
  "sports",
  "entertainment",
  "science",
];

const sourceById = new Map(newsSources.map((source) => [source.source_id, source]));

const beatImpactBase: Record<Category, number> = {
  ai: 46,
  technology: 44,
  finance: 54,
  international: 55,
  china: 58,
  policy: 66,
  society: 44,
  sports: 26,
  entertainment: 22,
  science: 48,
};

export interface QualityGateResult {
  accepted: RawNewsItem[];
  rejectionReasons: Record<string, number>;
}

export interface CurationFields {
  window: { from: string; to: string };
  stories: StoryCard[];
  topStories: StoryCard[];
  importantStories: StoryCard[];
  watchlist: StoryCard[];
  sections: StorySection[];
  coverage: CoverageSummary;
  quality: PublicQualitySummary;
}

export function applyCandidateQualityGate(items: RawNewsItem[]): QualityGateResult {
  const accepted: RawNewsItem[] = [];
  const rejectionReasons: Record<string, number> = {};

  for (const item of items) {
    const reason = candidateRejectionReason(item);
    if (!reason) {
      accepted.push(item);
      continue;
    }
    rejectionReasons[reason] = (rejectionReasons[reason] ?? 0) + 1;
  }

  return { accepted, rejectionReasons };
}

export function buildCurationFields(
  rawItems: RawNewsItem[],
  rankedItems: RankedNewsItem[],
  rejectionReasons: Record<string, number>,
  now: Date,
): CurationFields {
  const stories = rankedItems.map((item) => toStoryCard(item, rawItems, now));
  const formalStories = stories.filter((story) => story.tier !== "noise");
  const topStories = selectDiverse(
    formalStories.filter((story) => story.tier === "must_know" && story.status === "confirmed"),
    10,
  );
  const topIds = new Set(topStories.map((story) => story.id));
  const importantStories = selectDiverse(
    formalStories.filter(
      (story) =>
        !topIds.has(story.id) &&
        story.status === "confirmed" &&
        (story.tier === "must_know" || story.tier === "important"),
    ),
    30,
  );
  const selectedIds = new Set([...topStories, ...importantStories].map((story) => story.id));
  const watchlist = selectDiverse(
    stories.filter(
      (story) =>
        !selectedIds.has(story.id) &&
        story.status !== "confirmed" &&
        (story.status === "unverified" || story.importance.total >= 35),
    ),
    8,
  );
  const sections = buildSections(formalStories);
  const singleSourceCount = formalStories.filter((story) => story.evidence.length === 1).length;

  return {
    window: reportWindow(rawItems, now),
    stories: formalStories,
    topStories,
    importantStories,
    watchlist,
    sections,
    coverage: buildCoverage(rawItems, formalStories, sections),
    quality: {
      candidateCount: rawItems.length + sumValues(rejectionReasons),
      acceptedCandidateCount: rawItems.length,
      rejectedCandidateCount: sumValues(rejectionReasons),
      eventCount: stories.length,
      selectedEventCount: formalStories.length,
      duplicateEventRate: ratio(rawItems.length - stories.length, rawItems.length),
      singleSourceShare: ratio(singleSourceCount, formalStories.length),
      rejectionReasons,
    },
  };
}

function candidateRejectionReason(item: RawNewsItem): string | undefined {
  if (!item.title.trim() || !item.url.trim()) return "missing_identity";
  if (!/^https?:\/\//i.test(item.url)) return "invalid_url";
  if (!item.publishedAt || !Number.isFinite(Date.parse(item.publishedAt))) return "missing_published_at";
  if (!item.summary.trim() || normalizeText(item.summary) === normalizeText(item.title)) return "insufficient_summary";
  if (/相关报道聚焦.+具体背景.+以原文披露为准/.test(item.summary)) return "template_summary";
  if (/(广告|推广|优惠|折扣|导购|sponsored|advertorial)/i.test(`${item.title} ${item.summary}`)) return "promotional";
  return undefined;
}

function toStoryCard(item: RankedNewsItem, rawItems: RawNewsItem[], now: Date): StoryCard {
  const evidenceItems = rawItems.filter((candidate) => item.relatedUrls.includes(candidate.url));
  const evidence = evidenceItems.map(toEvidence);
  const status = storyStatus(item, evidence);
  const eventType = inferEventType(`${item.title} ${item.summary}`, item.primaryCategory);
  const importance = importanceFeatures(item, evidence, eventType);
  const entities = extractEntities(item.title);

  return {
    id: stableEventId(item, entities),
    itemId: item.id,
    title: item.title,
    whatHappened: item.summary,
    whyItMatters: explainImportance(importance, status, evidence),
    keyFacts: keyFacts(evidenceItems),
    nextWatch: nextWatch(eventType, status),
    primaryBeat: item.primaryCategory,
    scope: item.region,
    eventType,
    entities,
    status,
    tier: importanceTier(importance, item.trust.level, item.primaryCategory),
    publishedAt: item.publishedAt,
    updatedAt: latestDate(evidenceItems.map((candidate) => candidate.publishedAt ?? candidate.extractedAt), now),
    sourceNames: item.sourceNames,
    evidence,
    importance,
  };
}

function toEvidence(item: RawNewsItem): StoryEvidence {
  const source = sourceById.get(item.sourceId);
  return {
    candidateId: item.id,
    sourceId: item.sourceId,
    sourceName: item.sourceName,
    url: item.url,
    title: item.title,
    publishedAt: item.publishedAt,
    role:
      source?.mediaType === "official"
        ? "original"
        : source?.mediaType === "wire"
          ? "confirmation"
          : source?.mediaType === "social"
            ? "lead"
            : source?.mediaType === "technology" || source?.mediaType === "business"
              ? "analysis"
              : "context",
    independenceGroup: hostnameFromUrl(item.url).replace(/^www\./, "") || item.sourceId,
  };
}

function storyStatus(item: RankedNewsItem, evidence: StoryEvidence[]): StoryStatus {
  if (evidence.some((entry) => entry.role === "lead") && evidence.length === 1) return "unverified";
  const independentSources = new Set(evidence.map((entry) => entry.independenceGroup)).size;
  const strongestCredibility = Math.max(...item.sourceIds.map((id) => sourceById.get(id)?.credibility ?? 0), 0);
  if (independentSources >= 2 || item.trust.level === "high" || strongestCredibility >= 80) return "confirmed";
  return "developing";
}

function importanceFeatures(item: RankedNewsItem, evidence: StoryEvidence[], eventType: EventType): ImportanceFeatures {
  const publicImpact = curationPublicImpact(item, evidence, eventType);
  const urgency = item.score_breakdown.timeliness;
  const sourceSignificance = item.score_breakdown.source_confidence;
  const independentSources = new Set(evidence.map((entry) => entry.independenceGroup)).size;
  const evidenceStrength = Math.min(100, item.trust.score + Math.max(0, independentSources - 1) * 8);
  const total = clamp(publicImpact * 0.65 + urgency * 0.1 + sourceSignificance * 0.1 + evidenceStrength * 0.15);
  return { publicImpact, urgency, sourceSignificance, evidenceStrength, total };
}

function importanceTier(
  importance: ImportanceFeatures,
  trustLevel: RankedNewsItem["trust"]["level"],
  beat: Category,
): ImportanceTier {
  if (importance.publicImpact >= 82 && importance.total >= 76 && trustLevel !== "low") return "must_know";
  if (importance.publicImpact >= 58 && importance.total >= 58 && trustLevel !== "low") return "important";
  if (importance.publicImpact >= 36 && importance.total >= 40) return "special_interest";
  if ((beat === "sports" || beat === "entertainment") && importance.total >= 25) return "special_interest";
  return "noise";
}

function curationPublicImpact(item: RankedNewsItem, evidence: StoryEvidence[], eventType: EventType): number {
  const text = normalizeText(`${item.title} ${item.summary}`);
  let score = beatImpactBase[item.primaryCategory];

  if (/(战争|冲突|袭击|火灾|地震|洪水|台风|死亡|伤亡|停火|制裁|禁运|war|conflict|attack|earthquake|flood|deaths|ceasefire|sanction|embargo)/.test(text)) score += 25;
  if (/(全国|全球|国家级|央行|中央银行|政府发布|监管|新规|法律|利率|通胀|关税|global|nationwide|central bank|government announced|regulation|new law|interest rate|inflation|tariff)/.test(text)) score += 14;
  if (/(重大|创纪录|历史新高|首次|突破|紧急|record|all time high|first ever|breakthrough|emergency)/.test(text)) score += 8;
  if (/(生效|执行时间|批准|签署|实施|takes effect|effective date|approved|signed into law)/.test(text)) score += 6;

  if (eventType === "conflict" || eventType === "disaster") score += 10;
  else if (eventType === "policy") score += 8;
  else if (eventType === "economy") score += 6;
  else if (eventType === "research") score += 4;

  const independentSources = new Set(evidence.map((entry) => entry.independenceGroup)).size;
  score += Math.min(10, Math.max(0, independentSources - 1) * 5);

  if (/(排名|盘点|评论|观点|前景预测|如何看|best chance|ranking|opinion|commentary)/.test(text)) score -= 15;
  if (/(选区|村庄|地方候选人|社区活动|constituency|local candidate)/.test(text) && eventType !== "disaster") score -= 8;
  if (item.primaryCategory === "sports" && !/(决赛|冠军|夺冠|淘汰|纪录|final|champion|title|record)/.test(text)) score -= 8;

  return clamp(score);
}

function explainImportance(importance: ImportanceFeatures, status: StoryStatus, evidence: StoryEvidence[]): string {
  const evidenceText =
    evidence.length >= 2
      ? `${evidence.length} 个独立页面提供交叉证据`
      : status === "confirmed"
        ? "来源达到确认门槛"
        : "仍需更多独立来源确认";
  return `公共影响 ${importance.publicImpact}/100，${evidenceText}；本层级不使用个人偏好权重。`;
}

function inferEventType(textValue: string, beat: Category): EventType {
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

function extractEntities(title: string): string[] {
  const ignored = new Set(["news", "latest", "update", "report", "报道", "消息", "最新", "宣布", "发布"]);
  const tokens = tokenize(title)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !ignored.has(token) && !/^\d+$/.test(token));
  return Array.from(new Set(tokens)).slice(0, 8);
}

function keyFacts(items: RawNewsItem[]): string[] {
  const facts: string[] = [];
  for (const item of items) {
    const fact = item.summary.trim().replace(/\s+/g, " ");
    const normalizedFact = normalizeText(fact);
    if (
      !fact ||
      facts.some((existing) => {
        const normalizedExisting = normalizeText(existing);
        return normalizedExisting === normalizedFact || normalizedExisting.startsWith(normalizedFact) || normalizedFact.startsWith(normalizedExisting);
      })
    ) continue;
    facts.push(fact.length > 180 ? `${fact.slice(0, 178)}…` : fact);
    if (facts.length >= 3) break;
  }
  return facts;
}

function nextWatch(eventType: EventType, status: StoryStatus): string {
  if (status === "unverified") return "等待独立可靠来源或官方信息确认。";
  if (status === "developing") return "关注后续权威更新与关键事实是否发生变化。";
  if (eventType === "policy") return "关注正式文本、执行时间与落地范围。";
  if (eventType === "conflict" || eventType === "disaster") return "关注权威机构更新的影响范围与处置进展。";
  if (eventType === "economy" || eventType === "company") return "关注后续数据、市场反馈与实际影响。";
  if (eventType === "product" || eventType === "research") return "关注可用范围、复现结果与后续验证。";
  return "关注事件是否出现实质性后续进展。";
}

function stableEventId(item: RankedNewsItem, entities: string[]): string {
  const day = (item.publishedAt ?? item.extractedAt).slice(0, 10);
  const identity = `${item.primaryCategory}|${day}|${entities.slice(0, 5).join("|") || normalizeText(item.title)}`;
  let hash = 2166136261;
  for (let index = 0; index < identity.length; index += 1) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `event-${(hash >>> 0).toString(36)}`;
}

function selectDiverse(stories: StoryCard[], limit: number): StoryCard[] {
  const selected: StoryCard[] = [];
  const beatCounts = new Map<Category, number>();
  const sourceCounts = new Map<string, number>();
  const ordered = [...stories].sort((left, right) => right.importance.total - left.importance.total);

  for (const story of ordered) {
    const primarySource = story.evidence[0]?.sourceId ?? "unknown";
    if ((beatCounts.get(story.primaryBeat) ?? 0) >= 3) continue;
    if ((sourceCounts.get(primarySource) ?? 0) >= 3) continue;
    selected.push(story);
    beatCounts.set(story.primaryBeat, (beatCounts.get(story.primaryBeat) ?? 0) + 1);
    sourceCounts.set(primarySource, (sourceCounts.get(primarySource) ?? 0) + 1);
    if (selected.length >= limit) break;
  }

  return selected;
}

function buildSections(stories: StoryCard[]): StorySection[] {
  return allBeats.map((beat) => ({
    beat,
    storyIds: stories.filter((story) => story.primaryBeat === beat).map((story) => story.id),
  }));
}

function buildCoverage(rawItems: RawNewsItem[], stories: StoryCard[], sections: StorySection[]): CoverageSummary {
  const beats = allBeats.map((beat) => {
    const storyCount = stories.filter((story) => story.primaryBeat === beat).length;
    return {
      beat,
      candidateCount: rawItems.filter((item) => (item.primaryCategory ?? item.categories[0]) === beat).length,
      storyCount,
      selectedCount: sections.find((section) => section.beat === beat)?.storyIds.length ?? 0,
    };
  });
  return {
    beats,
    coveredBeatCount: beats.filter((beat) => beat.storyCount > 0).length,
    totalBeatCount: beats.length,
    sourceCount: new Set(rawItems.map((item) => item.sourceId)).size,
  };
}

function reportWindow(items: RawNewsItem[], now: Date): { from: string; to: string } {
  const timestamps = items
    .map((item) => Date.parse(item.publishedAt ?? ""))
    .filter((value) => Number.isFinite(value));
  return {
    from: timestamps.length > 0 ? new Date(Math.min(...timestamps)).toISOString() : now.toISOString(),
    to: timestamps.length > 0 ? new Date(Math.max(...timestamps)).toISOString() : now.toISOString(),
  };
}

function latestDate(values: string[], fallback: Date): string {
  const timestamps = values.map(Date.parse).filter((value) => Number.isFinite(value));
  return timestamps.length > 0 ? new Date(Math.max(...timestamps)).toISOString() : fallback.toISOString();
}

function sumValues(value: Record<string, number>): number {
  return Object.values(value).reduce((total, count) => total + count, 0);
}

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((Math.max(0, numerator) / denominator) * 1_000) / 1_000;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}
