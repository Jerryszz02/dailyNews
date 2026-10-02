import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { chooseFactCategory, evaluateNonAiFacts, type NonAiFactInput } from "../packages/backend/src/dailynews/non-ai.ts";

const golden = JSON.parse(readFileSync(new URL("../reference/baselines/legacy-golden.json", import.meta.url), "utf8")) as {
  baseline: string; now: string; inputs: NonAiFactInput[];
  expected: { facts: Array<{ factId: string; importance: unknown; tier: string; status: string }>; topIds: string[]; importantIds: string[]; watchlistIds: string[] };
};

test("nine non-AI beats match frozen legacy curation, status, and three editorial sets", () => {
  assert.equal(golden.baseline, "8519831714b0d6c8183336c81e8190dceddf7843");
  const actual = evaluateNonAiFacts(golden.inputs, new Date(golden.now));
  assert.deepEqual(actual.facts.map(({ factId, importance, tier, status }) => ({ factId, importance, tier, status })), golden.expected.facts);
  assert.deepEqual(actual.topIds, golden.expected.topIds);
  assert.deepEqual(actual.importantIds, golden.expected.importantIds);
  assert.deepEqual(actual.watchlistIds, golden.expected.watchlistIds);
  assert.equal(actual.topIds.length, 10);
  assert.equal(actual.importantIds.length, 30);
  assert.equal(actual.watchlistIds.length, 8);
  assert.ok(golden.inputs.some((input) => input.evidence.length === 2 && input.evidence[0]?.legacySourceId === input.evidence[1]?.legacySourceId));
  assert.equal(actual.facts.find((fact) => fact.factId === "lead")?.status, "unverified");
});

test("legacy category vote chooses one primary category for a cross-beat fact", () => {
  assert.equal(chooseFactCategory([
    { title: "全国经济政策公布", summary: "经济政策调整", primaryCategory: "finance", categories: ["finance", "policy"] },
    { title: "全国经济政策公布", summary: "经济政策调整", primaryCategory: "policy", categories: ["policy", "finance"] },
  ]), "finance");
});

test("evidence from one hostname and split legacy source IDs does not double count confirmation", () => {
  const input: NonAiFactInput = { factId: "host", primaryCategory: "sports", evidence: [
    { articleId: "one", legacySourceId: "column-a", url: "https://www.example.com/one", title: "地方球队交易消息", summary: "单点线索", primaryCategory: "sports", sourceCredibility: 40, signalRole: "discussion" },
    { articleId: "two", legacySourceId: "column-b", url: "https://example.com/two", title: "地方球队交易消息", summary: "单点线索", primaryCategory: "sports", sourceCredibility: 40, signalRole: "discussion" },
  ] };
  const result = evaluateNonAiFacts([input], new Date(golden.now));
  assert.equal(result.facts[0]?.status, "developing");
  assert.equal(result.facts[0]?.importance.evidenceStrength, 22);
});

test("a mention or composite article cannot become the selected representative", () => {
  const input = golden.inputs.find((fact) => fact.factId === "policy")!;
  const withMention = { ...input, evidence: [
    { ...input.evidence[0]!, articleId: "mention", association: "mention" as const, sourceCredibility: 100 },
    { ...input.evidence[0]!, articleId: "original", association: "primary" as const },
  ] };
  const selected = evaluateNonAiFacts([withMention], new Date(golden.now)).facts[0]!;
  assert.equal(selected.representativeArticleId, "original");
  assert.deepEqual(selected.representativeCandidates, ["original"]);
  const noRepresentative = evaluateNonAiFacts([{ ...input, evidence: [{ ...input.evidence[0]!, association: "composite" }] }], new Date(golden.now)).facts[0]!;
  assert.equal(noRepresentative.representativeArticleId, null);
  assert.equal(noRepresentative.selected, false);
  const unpublished = evaluateNonAiFacts([{ ...input, evidence: [{ ...input.evidence[0]!, eligibleForPublication: false }] }], new Date(golden.now)).facts[0]!;
  assert.equal(unpublished.representativeArticleId, null);
  assert.equal(unpublished.selected, false);
});

test("personal preference metadata cannot affect public decisions and recomputation time is explicit", () => {
  const now = new Date(golden.now);
  const first = evaluateNonAiFacts(golden.inputs, now);
  const withOppositePreferences = golden.inputs.map((input) => ({
    ...input,
    preferences: { topicWeights: { [input.primaryCategory]: "not-preferred" }, blockedKeywords: [input.evidence[0]?.title ?? ""] },
  }));
  assert.deepEqual(evaluateNonAiFacts(withOppositePreferences, now), first);
  assert.equal(first.facts.find((fact) => fact.factId === "technology")?.nextReevaluationAt, new Date(now.getTime() + 30 * 60_000 + 1).toISOString());
  assert.equal(first.facts.find((fact) => fact.factId === "old-impact")?.nextReevaluationAt, new Date(now.getTime() + 1).toISOString());
});
