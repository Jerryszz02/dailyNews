import { newsSources } from "../config/sources.js";
import type {
  Category,
  CoverageSummary,
  DailyEdition,
  EventType,
  ImportanceFeatures,
  ImportanceTier,
  PublicQualitySummary,
  RankedNewsItem,
  RawNewsItem,
  StoryCard,
  StoryEvidence,
  StoryHeat,
  StorySection,
  StoryStatus,
} from "../types";
import { isAllowedSourceUrl, isApprovedSource } from "./sourceAdmission.js";
import { isNavigationCandidate } from "./articleIdentity.js";
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
export const freshCoreWindowMinutes = 120;
export const currentCoreWindowMinutes = 24 * 60;
export const selectionBeatLimit = 3;
export const selectionPublisherLimit = 3;

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
  latestStories: StoryCard[];
  topStories: StoryCard[];
  importantStories: StoryCard[];
  watchlist: StoryCard[];
  hotStories: StoryCard[];
  dailyEdition: DailyEdition;
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
      const degradationReasons = candidateDegradationReasons(item);
      const hasPublishedAt = Boolean(item.publishedAt && Number.isFinite(Date.parse(item.publishedAt)));
      accepted.push({
        ...item,
        publishedAt: hasPublishedAt ? item.publishedAt : undefined,
        qualityStatus: degradationReasons.length > 0 ? "degraded" : "display_ready",
        rejectionReasons: degradationReasons,
        translationStatus: item.translationStatus ?? (item.language === "zh-CN" ? "original" : "pending"),
        summaryStatus: item.summaryStatus ?? (
          degradationReasons.some((reason) => reason === "insufficient_summary" || reason === "template_summary")
            ? "pending"
            : "complete"
        ),
        timeStatus: item.timeStatus ?? (hasPublishedAt ? "verified" : "estimated"),
      });
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
  const stories = attachHeat(rankedItems.map((item) => toStoryCard(item, rawItems, now)), now);
  const latestStories = selectLatestStories(stories, now);
  const corePublisherCounts = new Map<string, number>();
  const topStories = selectDiverse(
    stories.filter((story) => story.tier === "must_know"),
    10,
    now,
    [
      { maxAgeMinutes: freshCoreWindowMinutes, slots: 3 },
      { maxAgeMinutes: currentCoreWindowMinutes, slots: 5 },
    ],
    corePublisherCounts,
  );
  const topIds = new Set(topStories.map((story) => story.id));
  const importantStories = selectDiverse(
    stories.filter(
      (story) => !topIds.has(story.id) && (story.tier === "must_know" || story.tier === "important"),
    ),
    30,
    now,
    [
      { maxAgeMinutes: freshCoreWindowMinutes, slots: 3 },
      { maxAgeMinutes: currentCoreWindowMinutes, slots: 15 },
    ],
    corePublisherCounts,
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
    now,
    [
      { maxAgeMinutes: freshCoreWindowMinutes, slots: 8 },
      { maxAgeMinutes: currentCoreWindowMinutes, slots: 8 },
    ],
  );
  const selectionReasons = new Map<string, StoryCard["selection"]>();
  topStories.forEach((story) => selectionReasons.set(story.id, selectionFor(story, "今日必知")));
  importantStories.forEach((story) => selectionReasons.set(story.id, selectionFor(story, "重要进展")));
  const annotatedStories = stories.map((story) => {
    const selection = selectionReasons.get(story.id);
    return selection ? { ...story, selection } : story;
  });
  const annotatedById = new Map(annotatedStories.map((story) => [story.id, story]));
  const resolvedLatestStories = latestStories.map((story) => annotatedById.get(story.id)!);
  const resolvedTopStories = topStories.map((story) => annotatedById.get(story.id)!);
  const resolvedImportantStories = importantStories.map((story) => annotatedById.get(story.id)!);
  const resolvedWatchlist = watchlist.map((story) => annotatedById.get(story.id)!);
  const hotStories = selectHotStories(annotatedStories, now);
  const dailyEdition = buildDailyEdition(annotatedStories, now);
  const sections = buildSections(annotatedStories);
  const singleSourceCount = annotatedStories.filter((story) => independentSourceCount(story) <= 1).length;
  const coreStories = [...resolvedTopStories, ...resolvedImportantStories];
  const publisherCounts = new Map<string, number>();
  for (const story of coreStories) {
    const publisher = story.evidence[0]?.sourceId ?? "unknown";
    publisherCounts.set(publisher, (publisherCounts.get(publisher) ?? 0) + 1);
  }
  const weaklySourcedCoreCount = coreStories.filter(isWeaklySourcedCore).length;

  return {
    window: reportWindow(rawItems, now),
    stories: annotatedStories,
    latestStories: resolvedLatestStories,
    topStories: resolvedTopStories,
    importantStories: resolvedImportantStories,
    watchlist: resolvedWatchlist,
    hotStories,
    dailyEdition,
    sections,
    coverage: buildCoverage(rawItems, annotatedStories, sections),
    quality: {
      candidateCount: rawItems.length + sumValues(rejectionReasons),
      acceptedCandidateCount: rawItems.length,
      rejectedCandidateCount: sumValues(rejectionReasons),
      eventCount: annotatedStories.length,
      selectedEventCount: annotatedStories.length,
      duplicateEventRate: ratio(rawItems.length - annotatedStories.length, rawItems.length),
      singleSourceShare: ratio(singleSourceCount, annotatedStories.length),
      singleIndependentSourceEventShare: ratio(singleSourceCount, annotatedStories.length),
      maxPrimaryPublisherShare: ratio(Math.max(0, ...publisherCounts.values()), coreStories.length),
      weaklySourcedCoreShare: ratio(weaklySourcedCoreCount, coreStories.length),
      rejectionReasons,
      latestEventCount: latestStories.length,
      unmappedCandidateCount: countUnmappedCandidates(rawItems, annotatedStories),
    },
  };
}

function selectionFor(story: StoryCard, section: "今日必知" | "重要进展"): NonNullable<StoryCard["selection"]> {
  const criteria = [
    `公共影响 ${story.importance.publicImpact}/100`,
    `时效 ${story.importance.urgency}/100`,
    `${story.evidence.length} 条证据`,
    story.status === "confirmed" ? "事实已确认" : "事实仍在发展",
  ];
  return {
    selected: true,
    reason: `${section}：${story.whyItMatters}`,
    criteria,
  };
}

function attachHeat(stories: StoryCard[], now: Date): StoryCard[] {
  return stories.map((story) => ({ ...story, heat: storyHeat(story, now) }));
}

function storyHeat(story: StoryCard, now: Date): StoryHeat {
  const roleWeight: Record<StoryEvidence["role"], number> = {
    original: 1,
    confirmation: 0.9,
    context: 0.65,
    analysis: 0.5,
    lead: 0.25,
  };
  const newestPerIndependentSource = new Map<string, StoryEvidence>();
  for (const evidence of story.evidence) {
    const current = newestPerIndependentSource.get(evidence.independenceGroup);
    if (!current || evidenceTimestamp(evidence) > evidenceTimestamp(current)) {
      newestPerIndependentSource.set(evidence.independenceGroup, evidence);
    }
  }
  const evidenceSignals = [...newestPerIndependentSource.values()];
  const weightedSignals = evidenceSignals.reduce((total, evidence) => {
    const ageHours = Math.max(0, (now.getTime() - evidenceTimestamp(evidence)) / 3_600_000);
    return total + roleWeight[evidence.role] * Math.pow(0.5, ageHours / 24);
  }, 0);
  const recentSignals = evidenceSignals.filter((evidence) => now.getTime() - evidenceTimestamp(evidence) <= 3 * 3_600_000).length;
  const earlierSignals = evidenceSignals.filter((evidence) => {
    const age = now.getTime() - evidenceTimestamp(evidence);
    return age > 3 * 3_600_000 && age <= 24 * 3_600_000;
  }).length;
  const discussionSignals = evidenceSignals.filter((evidence) => evidence.role === "lead").length;
  const evidenceScore = clamp((1 - Math.exp(-weightedSignals / 1.8)) * 100);
  const velocityScore = clamp((recentSignals / Math.max(1, earlierSignals + 1)) * 45);
  const discussionScore = clamp((1 - Math.exp(-discussionSignals / 2)) * 100);
  const score = clamp(evidenceScore * 0.55 + velocityScore * 0.3 + discussionScore * 0.15);
  const newestAgeHours = Math.max(0, (now.getTime() - storyActivityTimestamp(story)) / 3_600_000);
  const trend = velocityScore >= 65 && recentSignals >= 3
    ? "surging"
    : velocityScore >= 35 && recentSignals >= 2
      ? "rising"
      : newestAgeHours <= 2
        ? "new"
        : "steady";

  return {
    score,
    evidenceScore,
    velocityScore,
    discussionScore,
    trend,
    coverageConfidence:
      story.timeStatus === "estimated" || story.evidence.some((evidence) => !evidence.publishedAt)
        ? "limited"
        : "verified",
  };
}

function evidenceTimestamp(evidence: StoryEvidence): number {
  const timestamp = Date.parse(evidence.publishedAt ?? "");
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function selectHotStories(stories: StoryCard[], now: Date): StoryCard[] {
  return stories
    .filter((story) => {
      const ageMs = now.getTime() - storyActivityTimestamp(story);
      return ageMs >= 0 && ageMs <= 48 * 3_600_000 && (story.heat?.score ?? 0) >= 30;
    })
    .sort((left, right) => {
      const heatDelta = (right.heat?.score ?? 0) - (left.heat?.score ?? 0);
      return heatDelta || storyActivityTimestamp(right) - storyActivityTimestamp(left);
    })
    .slice(0, 20);
}

function buildDailyEdition(stories: StoryCard[], now: Date): DailyEdition {
  const cutoffAt = latestChinaMorningCutoff(now);
  const from = new Date(cutoffAt.getTime() - 24 * 3_600_000);
  const candidates = stories
    .filter((story) => {
      const timestamp = storyActivityTimestamp(story);
      return timestamp >= from.getTime() && timestamp < cutoffAt.getTime() && story.tier !== "noise";
    })
    .sort((left, right) => {
      const importanceDelta = right.importance.total - left.importance.total;
      return importanceDelta || storyActivityTimestamp(right) - storyActivityTimestamp(left);
    });
  const selected: StoryCard[] = [];
  const selectedIds = new Set<string>();
  for (const beat of allBeats) {
    const story = candidates.find((candidate) => candidate.primaryBeat === beat && !selectedIds.has(candidate.id));
    if (!story) continue;
    selected.push(story);
    selectedIds.add(story.id);
  }
  for (const story of candidates) {
    if (selected.length >= 24) break;
    if (selectedIds.has(story.id)) continue;
    selected.push(story);
    selectedIds.add(story.id);
  }
  const ordered = selected.sort((left, right) => storyActivityTimestamp(right) - storyActivityTimestamp(left));
  const editionDate = chinaDateKey(cutoffAt);
  return {
    id: `daily-${editionDate}`,
    editionDate,
    generatedAt: cutoffAt.toISOString(),
    cutoffAt: cutoffAt.toISOString(),
    window: { from: from.toISOString(), to: cutoffAt.toISOString() },
    storyIds: ordered.map((story) => story.id),
    stories: structuredClone(ordered),
    sections: allBeats.map((beat) => ({
      beat,
      storyIds: ordered.filter((story) => story.primaryBeat === beat).map((story) => story.id),
    })),
    readTimeMinutes: Math.ceil(ordered.length * 1.2),
  };
}

function latestChinaMorningCutoff(now: Date): Date {
  const chinaOffsetMs = 8 * 3_600_000;
  const chinaNow = new Date(now.getTime() + chinaOffsetMs);
  let cutoffMs = Date.UTC(chinaNow.getUTCFullYear(), chinaNow.getUTCMonth(), chinaNow.getUTCDate(), 0, 0, 0, 0);
  if (now.getTime() < cutoffMs) cutoffMs -= 24 * 3_600_000;
  return new Date(cutoffMs);
}

function chinaDateKey(cutoffAt: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(cutoffAt);
}

function candidateRejectionReason(item: RawNewsItem): string | undefined {
  if (!item.title.trim() || !item.url.trim()) return "missing_identity";
  try {
    const url = new URL(item.url);
    if (!/^https?:$/.test(url.protocol) || !url.hostname) return "invalid_url";
    if (isNavigationCandidate(item.title, item.url)) return "navigation_page";
  } catch {
    return "invalid_url";
  }
  const source = sourceById.get(item.sourceId);
  if (!source || !isApprovedSource(source)) return "unapproved_source";
  if (!isAllowedSourceUrl(source, item.url)) return "source_url_out_of_scope";
  if (isExplicitPromotion(`${item.title} ${item.summary}`)) return "promotional";
  return undefined;
}

function isExplicitPromotion(value: string): boolean {
  return /\b(sponsored|advertorial)\b/i.test(value) ||
    /(赞助内容|商业推广|广告合作|广告链接|推广链接|优惠券|折扣码|购物导购)/.test(value) ||
    /(立即|点击|扫码|限时|下单|购买|领取|抢购).{0,12}(优惠|折扣|购买|下单|领取|咨询|活动)/.test(value);
}

function candidateDegradationReasons(item: RawNewsItem): string[] {
  const reasons: string[] = [];
  if (!item.publishedAt || !Number.isFinite(Date.parse(item.publishedAt))) reasons.push("missing_published_at");
  if (!item.summary.trim() || normalizeText(item.summary) === normalizeText(item.title)) reasons.push("insufficient_summary");
  if (/相关报道聚焦.+具体背景.+以原文披露为准/.test(item.summary)) reasons.push("template_summary");
  return reasons;
}

function toStoryCard(item: RankedNewsItem, rawItems: RawNewsItem[], now: Date): StoryCard {
  const evidenceItems = rawItems.filter((candidate) => item.relatedUrls.includes(candidate.url));
  const evidence = evidenceItems.map(toEvidence);
  const status = storyStatus(item, evidence);
  const eventType = inferEventType(`${item.title} ${item.summary}`, item.primaryCategory);
  const importance = importanceFeatures(item, evidence, eventType);
  const entities = extractEntities(item.title);

  return {
    id: stableEventId(item, evidenceItems),
    itemId: item.id,
    title: item.title,
    whatHappened: item.summary.trim() || "摘要待补全，请以来源原文为准。",
    whyItMatters: explainImportance(importance, status, evidence),
    keyFacts: keyFacts(evidenceItems),
    nextWatch: nextWatch(eventType, status),
    primaryBeat: item.primaryCategory,
    scope: item.region,
    eventType,
    entities,
    status,
    tier: importanceTier(importance, item.primaryCategory),
    startedAt: item.startedAt,
    publishedAt: item.publishedAt,
    updatedAt: item.updatedAt,
    translationStatus: item.translationStatus,
    summaryStatus: item.summaryStatus,
    timeStatus: item.timeStatus,
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
      source?.signalRole === "first_party"
        ? "original"
        : source?.signalRole === "reporting"
          ? "confirmation"
          : source?.signalRole === "discussion"
            ? "lead"
            : source?.signalRole === "analysis"
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
  const total = clamp(publicImpact * 0.8 + urgency * 0.2);
  return { publicImpact, urgency, sourceSignificance, evidenceStrength, total };
}

function importanceTier(
  importance: ImportanceFeatures,
  beat: Category,
): ImportanceTier {
  if (importance.publicImpact >= 82 && importance.total >= 76) return "must_know";
  if (importance.publicImpact >= 58 && importance.total >= 58) return "important";
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

function stableEventId(item: RankedNewsItem, evidenceItems: RawNewsItem[]): string {
  const anchorUrl = [...evidenceItems]
    .sort((left, right) => {
      const timeDelta = candidateAnchorTimestamp(left) - candidateAnchorTimestamp(right);
      return timeDelta || canonicalEventUrl(left.url).localeCompare(canonicalEventUrl(right.url));
    })[0]?.url ?? item.url;
  const identity = `${item.primaryCategory}|${canonicalEventUrl(anchorUrl)}`;
  let hash = 2166136261;
  for (let index = 0; index < identity.length; index += 1) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `event-${(hash >>> 0).toString(36)}`;
}

function candidateAnchorTimestamp(item: RawNewsItem): number {
  for (const value of [item.publishedAt, item.discoveredAt, item.extractedAt]) {
    const timestamp = Date.parse(value ?? "");
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return Number.POSITIVE_INFINITY;
}

function canonicalEventUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_.+|fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    url.hostname = url.hostname.toLowerCase();
    return url.toString().replace(/\/$/, "");
  } catch {
    return value;
  }
}

interface FreshnessStage {
  maxAgeMinutes: number;
  slots: number;
}

function selectDiverse(
  stories: StoryCard[],
  limit: number,
  now: Date,
  freshnessStages: FreshnessStage[] = [],
  sourceCounts = new Map<string, number>(),
): StoryCard[] {
  const selected: StoryCard[] = [];
  const selectedIds = new Set<string>();
  const beatCounts = new Map<Category, number>();
  const ordered = [...stories].sort((left, right) => {
    const importanceDelta = right.importance.total - left.importance.total;
    if (importanceDelta !== 0) return importanceDelta;
    return storyActivityTimestamp(right) - storyActivityTimestamp(left);
  });

  const trySelect = (story: StoryCard, enforceDiversity = true): boolean => {
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

export function storyActivityTimestamp(story: Pick<StoryCard, "publishedAt" | "updatedAt" | "evidence">): number {
  const updatedAt = Date.parse(story.updatedAt);
  return Number.isFinite(updatedAt) ? updatedAt : Number.NEGATIVE_INFINITY;
}

export function isStoryActiveWithin(
  story: Pick<StoryCard, "publishedAt" | "updatedAt" | "evidence">,
  now: Date,
  maxAgeMinutes: number,
): boolean {
  const activityAt = storyActivityTimestamp(story);
  const ageMs = now.getTime() - activityAt;
  return Number.isFinite(activityAt) && ageMs >= 0 && ageMs <= maxAgeMinutes * 60_000;
}

export function orderStoriesByActivity(stories: StoryCard[]): StoryCard[] {
  return [...stories].sort((left, right) => {
    const activityDelta = storyActivityTimestamp(right) - storyActivityTimestamp(left);
    return activityDelta || left.id.localeCompare(right.id);
  });
}

export function selectLatestStories(stories: StoryCard[], now: Date): StoryCard[] {
  const current = stories.filter((story) => isStoryActiveWithin(story, now, currentCoreWindowMinutes));
  return orderStoriesByActivity(
    current.length > 0
      ? current
      : stories.filter((story) => isStoryActiveWithin(story, now, 72 * 60)),
  );
}

function independentSourceCount(story: StoryCard): number {
  return new Set(story.evidence.map((evidence) => evidence.independenceGroup)).size;
}

function isWeaklySourcedCore(story: StoryCard): boolean {
  if (independentSourceCount(story) >= 2) return false;
  return !story.evidence.some(
    (evidence) => evidence.role === "original" && (sourceById.get(evidence.sourceId)?.credibility ?? 0) >= 80,
  );
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
    .flatMap((item) => [item.publishedAt, item.updatedAt, item.discoveredAt, item.extractedAt])
    .map((value) => Date.parse(value ?? ""))
    .filter((value) => Number.isFinite(value));
  return {
    from: timestamps.length > 0 ? new Date(Math.min(...timestamps)).toISOString() : now.toISOString(),
    to: timestamps.length > 0 ? new Date(Math.max(...timestamps)).toISOString() : now.toISOString(),
  };
}

function countUnmappedCandidates(items: RawNewsItem[], stories: StoryCard[]): number {
  const mappedCandidateIds = new Set(stories.flatMap((story) => story.evidence.map((evidence) => evidence.candidateId)));
  return items.filter((item) => !mappedCandidateIds.has(item.id)).length;
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
