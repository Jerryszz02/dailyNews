import { createHash } from "node:crypto";
import { eventPairSignals } from "../src/lib/dedupe.js";
import type { RawNewsItem } from "../src/types";

const defaultBaseUrl = "https://api.deepseek.com";
const defaultModel = "deepseek-v4-flash";
const defaultMaxCallsPerRefresh = 12;
const maxShortlistSize = 3;
const requestTimeoutMs = 4_000;
const maxCachedDecisions = 1_000;
const decisionCache = new Map<string, EventRelationDecision>();

export type EventRelation = "same_event" | "related_event" | "different_event";

export interface EventRelationDecision {
  relation: EventRelation;
  confidence: number;
  reason: string;
}

export interface SemanticDedupeResult {
  items: RawNewsItem[];
  evaluatedPairCount: number;
  modelCallCount: number;
  mergedPairCount: number;
}

interface SemanticDedupeOptions {
  candidateIds: Set<string>;
  now: Date;
  deadlineAt?: number;
  maxCalls?: number;
  decide?: (left: RawNewsItem, right: RawNewsItem) => Promise<EventRelationDecision>;
}

interface SemanticDedupeConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export function sameEventRelationMaterial(left: RawNewsItem, right: RawNewsItem): boolean {
  return left.title === right.title && left.summary === right.summary &&
    left.publishedAt === right.publishedAt &&
    (left.primaryCategory ?? left.categories[0]) === (right.primaryCategory ?? right.categories[0]);
}

export async function resolveAmbiguousEventRelations(
  items: RawNewsItem[],
  options: SemanticDedupeOptions,
): Promise<SemanticDedupeResult> {
  const config = readSemanticDedupeConfig();
  const decide = options.decide ?? (config ? ((left, right) => requestEventRelation(left, right, config)) : undefined);
  if (!decide || options.candidateIds.size === 0) return emptyResult(items);

  const deadlineAt = options.deadlineAt ?? Date.now() + requestTimeoutMs;
  const maxCalls = options.maxCalls ?? readPositiveInteger(
    "DAILY_NEWS_LLM_DEDUPE_MAX_CALLS_PER_REFRESH",
    defaultMaxCallsPerRefresh,
  );
  const mutable = new Map(items.map((item) => [item.id, { ...item }]));
  const targets = items.filter((item) => options.candidateIds.has(item.id));
  let evaluatedPairCount = 0;
  let modelCallCount = 0;
  let mergedPairCount = 0;

  for (const originalTarget of targets) {
    if (modelCallCount >= maxCalls || Date.now() >= deadlineAt) break;
    const target = mutable.get(originalTarget.id)!;
    const shortlist = items
      .filter((candidate) => candidate.id !== target.id && candidate.sourceId !== target.sourceId)
      .map((candidate) => ({ candidate, signals: eventPairSignals(target, candidate) }))
      .filter(({ signals }) => isAmbiguousPair(signals))
      .sort((left, right) => pairScore(right.signals) - pairScore(left.signals))
      .slice(0, maxShortlistSize);

    for (const { candidate: originalAnchor } of shortlist) {
      if (modelCallCount >= maxCalls || Date.now() >= deadlineAt) break;
      evaluatedPairCount += 1;
      const anchor = mutable.get(originalAnchor.id)!;
      const cacheKey = relationCacheKey(target, anchor);
      let decision = decisionCache.get(cacheKey);
      if (!decision) {
        try {
          modelCallCount += 1;
          decision = await runBeforeDeadline(() => decide(target, anchor), deadlineAt);
          cacheDecision(cacheKey, decision);
        } catch {
          continue;
        }
      }
      if (decision.relation !== "same_event" || decision.confidence < 0.8) continue;

      const semanticEventId = anchor.semanticEventId ?? target.semanticEventId ?? stableSemanticEventId(target, anchor);
      mutable.set(anchor.id, { ...anchor, semanticEventId });
      mutable.set(target.id, {
        ...target,
        semanticEventId,
        semanticRelation: {
          anchorCandidateId: anchor.id,
          confidence: boundedConfidence(decision.confidence),
          model: config?.model ?? "test-resolver",
          decidedAt: options.now.toISOString(),
        },
      });
      mergedPairCount += 1;
      break;
    }
  }

  return {
    items: items.map((item) => mutable.get(item.id) ?? item),
    evaluatedPairCount,
    modelCallCount,
    mergedPairCount,
  };
}

function cacheDecision(key: string, decision: EventRelationDecision): void {
  if (decisionCache.size >= maxCachedDecisions) {
    decisionCache.delete(decisionCache.keys().next().value ?? "");
  }
  decisionCache.set(key, decision);
}

function emptyResult(items: RawNewsItem[]): SemanticDedupeResult {
  return { items, evaluatedPairCount: 0, modelCallCount: 0, mergedPairCount: 0 };
}

function isAmbiguousPair(signals: ReturnType<typeof eventPairSignals>): boolean {
  if (!signals.withinWindow || !signals.sameCategory) return false;
  if (signals.titleOverlap >= 0.8 && signals.combinedOverlap >= 0.85) return false;
  return signals.titleOverlap >= 0.3 || signals.combinedOverlap >= 0.5;
}

function pairScore(signals: ReturnType<typeof eventPairSignals>): number {
  return signals.titleOverlap * 0.45 + signals.combinedOverlap * 0.55;
}

function readSemanticDedupeConfig(): SemanticDedupeConfig | undefined {
  if (process.env.DAILY_NEWS_LLM_DEDUPE_ENABLED?.trim().toLowerCase() !== "true") return undefined;
  const apiKey = process.env.DAILY_NEWS_TRANSLATION_API_KEY?.trim();
  if (!apiKey) return undefined;
  return {
    apiKey,
    baseUrl: process.env.DAILY_NEWS_TRANSLATION_BASE_URL?.trim() || defaultBaseUrl,
    model: process.env.DAILY_NEWS_TRANSLATION_MODEL?.trim() || defaultModel,
  };
}

async function requestEventRelation(
  left: RawNewsItem,
  right: RawNewsItem,
  config: SemanticDedupeConfig,
): Promise<EventRelationDecision> {
  const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        {
          role: "system",
          content:
            "判断两条报道是否描述同一现实事件。区分同一主题下的不同事件、前因后果和真正的同一事件更新。只输出 JSON：{\"relation\":\"same_event|related_event|different_event\",\"confidence\":0到1,\"reason\":\"不超过40字\"}。",
        },
        { role: "user", content: JSON.stringify([relationMaterial(left), relationMaterial(right)]) },
      ],
      temperature: 0,
      max_tokens: 160,
      response_format: { type: "json_object" },
      ...(config.baseUrl.includes("deepseek.com") ? { thinking: { type: "disabled" } } : {}),
    }),
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (!response.ok) throw new Error(`Semantic dedupe request failed with status ${response.status}`);
  const payload = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const parsed = JSON.parse(payload.choices?.[0]?.message?.content ?? "{}") as Partial<EventRelationDecision>;
  if (!isEventRelation(parsed.relation) || typeof parsed.confidence !== "number") {
    throw new Error("Semantic dedupe returned invalid JSON");
  }
  return {
    relation: parsed.relation,
    confidence: boundedConfidence(parsed.confidence),
    reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 80) : "",
  };
}

function relationMaterial(item: RawNewsItem) {
  return {
    title: item.title.slice(0, 240),
    summary: item.summary.slice(0, 800),
    category: item.primaryCategory ?? item.categories[0],
    publishedAt: item.publishedAt,
  };
}

function relationCacheKey(left: RawNewsItem, right: RawNewsItem): string {
  const values = [relationFingerprint(left), relationFingerprint(right)].sort();
  return values.join(":");
}

function relationFingerprint(item: RawNewsItem): string {
  return createHash("sha256")
    .update(JSON.stringify(relationMaterial(item)))
    .digest("hex")
    .slice(0, 20);
}

function stableSemanticEventId(left: RawNewsItem, right: RawNewsItem): string {
  return `semantic-${createHash("sha256").update([left.id, right.id].sort().join("\n")).digest("hex").slice(0, 24)}`;
}

function boundedConfidence(value: number): number {
  return Math.max(0, Math.min(1, Math.round(value * 1_000) / 1_000));
}

function isEventRelation(value: unknown): value is EventRelation {
  return value === "same_event" || value === "related_event" || value === "different_event";
}

function readPositiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

async function runBeforeDeadline<T>(task: () => Promise<T>, deadlineAt: number): Promise<T> {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) throw new Error("semantic_dedupe_deadline");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task(),
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("semantic_dedupe_deadline")), remainingMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
