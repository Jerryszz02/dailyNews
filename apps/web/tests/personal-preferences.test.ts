import assert from "node:assert/strict";
import { test } from "node:test";
import type { FeedItemSummary } from "@aihot/contracts/site";
import { CATEGORY_KEYS } from "@aihot/contracts/taxonomy";
import {
  LEGACY_PREFERENCES_KEY, PREFERENCES_KEY, commitPersonalPreferences, normalizePreferences, personalOrder, readPersonalPreferences,
} from "../app/lib/personal-preferences.ts";
import { compactScoreLabel, scoreLabel } from "../app/lib/score-labels.ts";

function storage(initial: Record<string, string>) {
  const values = new Map(Object.entries(initial));
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

function item(id: string, category: FeedItemSummary["category"], title: string, at: string, legacySourceId: string | null): FeedItemSummary {
  return {
    id, title, summary: null, reason: null, publishedAt: at, timelineAt: at, category, tags: [], score: 99,
    scoreKind: category === "ai" ? "ai_attention" : "legacy_curation_total", importanceTier: null, factStatus: null,
    selected: false, channel: "news", source: { id: `section-${id}`, legacySourceId, name: "测试来源" }, x: null,
  };
}

test("legacy browser preferences convert once to a bounded versioned value", () => {
  assert.equal(CATEGORY_KEYS.length, 10);
  const old = { topicWeights: { ai: "high", sports: "not-preferred", unknown: "preferred" },
    preferredSources: { xinhua: 25, invalid: "large", huge: 999 }, blockedKeywords: ["谣言", "谣言", ""], boostedKeywords: ["芯片"] };
  const store = storage({ [LEGACY_PREFERENCES_KEY]: JSON.stringify(old) });
  const first = readPersonalPreferences(store);
  assert.equal(first.version, 2);
  assert.equal(first.topicWeights.ai, "preferred");
  assert.equal(first.topicWeights.sports, "not-preferred");
  assert.deepEqual(Object.keys(first.topicWeights).sort(), [...CATEGORY_KEYS].sort());
  assert.equal(first.preferredSources.xinhua, 25);
  assert.equal(first.preferredSources.huge, 100);
  assert.deepEqual(first.blockedKeywords, ["谣言"]);
  assert.ok(store.values.has(PREFERENCES_KEY));
  store.values.set(LEGACY_PREFERENCES_KEY, JSON.stringify({ topicWeights: { ai: "not-preferred" } }));
  assert.deepEqual(readPersonalPreferences(store), first, "later edits to the legacy key cannot overwrite v2");
  assert.equal(normalizePreferences({ preferredSources: { x: Infinity } }).preferredSources.x, undefined);
});

test("consecutive preference edits compose before the next render", () => {
  const store = storage({});
  const latest = { current: normalizePreferences(null) };
  commitPersonalPreferences(latest, (current) => ({ ...current, blockedKeywords: ["谣言"] }), store);
  commitPersonalPreferences(latest, (current) => ({ ...current,
    topicWeights: { ...current.topicWeights, sports: "preferred" },
  }), store);
  assert.deepEqual(latest.current.blockedKeywords, ["谣言"]);
  assert.equal(latest.current.topicWeights.sports, "preferred");
  assert.deepEqual(readPersonalPreferences(store), latest.current, "both edits persist even without a React re-render");
});

test("personal order filters preferred categories, demotes blocked words, and never compares public scores", () => {
  const preferences = normalizePreferences({ topicWeights: { policy: "preferred", ai: "preferred", sports: "not-preferred" },
    preferredSources: { xinhua: 20 }, blockedKeywords: ["谣言"], boostedKeywords: ["芯片"] });
  const at = "2026-10-03T02:00:00Z";
  const items = [
    item("blocked", "policy", "芯片谣言", at, "xinhua"),
    item("sport", "sports", "比赛", at, null),
    item("boosted", "ai", "芯片发布", at, "xinhua"),
    item("plain", "policy", "政策生效", at, null),
  ];
  const ordered = personalOrder(items, preferences);
  assert.deepEqual(ordered.map((entry) => entry.id), ["boosted", "plain", "blocked"]);
  assert.equal(items.length, 4, "the public list remains untouched");
  assert.equal(ordered.at(-1)?.id, "blocked", "blocked words lower priority instead of removing the item");
  const sameScores = items.map((entry) => ({ ...entry, score: 0 }));
  assert.deepEqual(personalOrder(sameScores, preferences).map((entry) => entry.id), ordered.map((entry) => entry.id));
});

test("public score labels keep AI attention and non-AI importance distinct", () => {
  assert.equal(scoreLabel("ai_attention"), "AI 注意力");
  assert.equal(scoreLabel("legacy_curation_total"), "公共重要性");
  assert.equal(scoreLabel(null), "评分");
  assert.equal(compactScoreLabel("ai_attention"), "AI 关注");
  assert.equal(compactScoreLabel("legacy_curation_total"), "重要性");
});
