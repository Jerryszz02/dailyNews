import type { FeedItemSummary } from "@aihot/contracts/site";
import { CATEGORY_KEYS, type CategoryKey } from "@aihot/contracts/taxonomy";
import { beijingDate } from "@aihot/contracts/time";

export const LEGACY_PREFERENCES_KEY = "daily-news-preferences";
export const PREFERENCES_KEY = "daily-news-preferences-v2";

export interface PersonalPreferences {
  version: 2;
  topicWeights: Partial<Record<CategoryKey, "preferred" | "not-preferred">>;
  preferredSources: Record<string, number>;
  blockedKeywords: string[];
  boostedKeywords: string[];
}

const DEFAULT_WEIGHTS: PersonalPreferences["topicWeights"] = {
  ai: "preferred", technology: "preferred", finance: "preferred", international: "preferred", policy: "preferred",
  china: "preferred", society: "not-preferred", science: "preferred", sports: "not-preferred", entertainment: "not-preferred",
};
export const DEFAULT_PREFERENCES: PersonalPreferences = {
  version: 2, topicWeights: DEFAULT_WEIGHTS, preferredSources: {}, blockedKeywords: [],
  boostedKeywords: ["OpenAI", "芯片", "大模型", "AI"],
};

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function keywords(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  const seen = new Set<string>();
  for (const raw of value.slice(0, 100)) {
    if (typeof raw !== "string") continue;
    const word = raw.trim().slice(0, 60);
    if (word) seen.add(word);
    if (seen.size >= 30) break;
  }
  return [...seen];
}

/** The old browser stored exactly these four preference fields; accept only bounded, known values. */
export function normalizePreferences(value: unknown): PersonalPreferences {
  const raw = object(value);
  const oldWeights = object(raw.topicWeights);
  const topicWeights = Object.fromEntries(CATEGORY_KEYS.map((key) => [key,
    oldWeights[key] === "preferred" || oldWeights[key] === "medium" || oldWeights[key] === "high" ? "preferred"
      : oldWeights[key] === "not-preferred" ? "not-preferred" : DEFAULT_WEIGHTS[key],
  ])) as PersonalPreferences["topicWeights"];
  const preferredSources: Record<string, number> = {};
  for (const [key, value] of Object.entries(object(raw.preferredSources)).slice(0, 200)) {
    if (key !== "__proto__" && key !== "constructor" && key !== "prototype" && /^[\w.-]{1,100}$/.test(key)
      && typeof value === "number" && Number.isFinite(value)) {
      preferredSources[key] = Math.max(-100, Math.min(100, value));
    }
  }
  return {
    version: 2, topicWeights, preferredSources,
    blockedKeywords: keywords(raw.blockedKeywords, DEFAULT_PREFERENCES.blockedKeywords),
    boostedKeywords: keywords(raw.boostedKeywords, DEFAULT_PREFERENCES.boostedKeywords),
  };
}

function parse(raw: string | null): unknown {
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}

/** Write the versioned value once; never overwrite it from the legacy key on later visits. */
export function readPersonalPreferences(storage: Pick<Storage, "getItem" | "setItem">): PersonalPreferences {
  try {
    const current = storage.getItem(PREFERENCES_KEY);
    if (current !== null) return normalizePreferences(parse(current));
    const normalized = normalizePreferences(parse(storage.getItem(LEGACY_PREFERENCES_KEY)));
    try { storage.setItem(PREFERENCES_KEY, JSON.stringify(normalized)); } catch { /* private mode: keep in memory */ }
    return normalized;
  } catch {
    return normalizePreferences(null);
  }
}

export function savePersonalPreferences(storage: Pick<Storage, "setItem">, value: PersonalPreferences): PersonalPreferences {
  const normalized = normalizePreferences(value);
  try { storage.setItem(PREFERENCES_KEY, JSON.stringify(normalized)); } catch { /* ephemeral preference */ }
  return normalized;
}

/** Consecutive UI events must compose against the latest saved value, before React re-renders. */
export function commitPersonalPreferences(
  current: { current: PersonalPreferences },
  update: (value: PersonalPreferences) => PersonalPreferences,
  storage: Pick<Storage, "setItem"> | null,
): PersonalPreferences {
  const next = update(current.current);
  const saved = storage ? savePersonalPreferences(storage, next) : normalizePreferences(next);
  current.current = saved;
  return saved;
}

function textOf(item: FeedItemSummary): string {
  return `${item.title} ${item.summary ?? ""}`.toLocaleLowerCase();
}

function preferenceScore(item: FeedItemSummary, preferences: PersonalPreferences): number {
  const text = textOf(item);
  const sourceId = item.source.legacySourceId ?? item.source.id;
  return (preferences.preferredSources[sourceId] ?? preferences.preferredSources[item.source.id] ?? 0)
    + preferences.boostedKeywords.filter((word) => text.includes(word.toLocaleLowerCase())).length * 10
    - (preferences.blockedKeywords.some((word) => text.includes(word.toLocaleLowerCase())) ? 100 : 0);
}

/** Personal view only. Never use public AI/non-AI scores to compare items or change public membership. */
export function personalOrder<T extends FeedItemSummary>(items: readonly T[], preferences: PersonalPreferences): T[] {
  return items.filter((item) => item.category && preferences.topicWeights[item.category] === "preferred")
    .sort((a, b) => beijingDate(b.timelineAt).localeCompare(beijingDate(a.timelineAt))
      || preferenceScore(b, preferences) - preferenceScore(a, preferences)
      || Date.parse(b.publishedAt ?? b.timelineAt) - Date.parse(a.publishedAt ?? a.timelineAt)
      || a.id.localeCompare(b.id));
}
