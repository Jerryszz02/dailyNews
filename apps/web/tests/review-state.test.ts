import assert from "node:assert/strict";
import { test } from "node:test";
import { nextReviewIndex, reviewDraft, reviewValidation } from "../app/features/admin/review-state.ts";

test("new tasks never preselect answers and dimensions are required independently", () => {
  assert.deepEqual(reviewDraft(null), {});
  assert.ok(reviewValidation({}, "article"));
  assert.ok(reviewValidation({ classification: "ok" }, "article"));
  assert.ok(reviewValidation({ classification: "ok", quality: "ok" }, "article"));
  assert.equal(reviewValidation({ classification: "uncertain", quality: "uncertain", selection: "uncertain" }, "article"), null);
});
test("classification changes and quality problems require their own detail", () => {
  const answer = { classification: "change", quality: "problem", selection: "reject" } as const;
  assert.ok(reviewValidation(answer, "article"));
  assert.ok(reviewValidation({ ...answer, category: "science" }, "article"));
  assert.equal(reviewValidation({ ...answer, category: "science", qualityReasons: ["number_unit"] }, "article"), null);
});
test("version 2 requires explicit AI relevance independently of category and selection", () => {
  const answer = { classification: "ok", quality: "ok", selection: "select" } as const;
  assert.ok(reviewValidation(answer, "article", 2));
  assert.ok(reviewValidation({ ...answer, category: "ai" }, "article", 2));
  for (const aiRelevance of ["relevant", "irrelevant", "uncertain"] as const) {
    assert.equal(reviewValidation({ ...answer, aiRelevance }, "article", 2), null);
    assert.equal(reviewValidation({ ...answer, selection: "reject", aiRelevance }, "article", 2), null);
  }
  assert.ok(reviewValidation({ aiRelevance: "relevant" }, "article", 2), "other dimensions remain required");
});
test("legacy answers remain valid without relevance and drafts never infer it from selection", () => {
  const answer = { classification: "ok", quality: "ok", selection: "reject" } as const;
  assert.equal(reviewValidation(answer, "article"), null);
  assert.equal(reviewValidation(answer, "article", 1), null);
  assert.equal(reviewDraft(answer).aiRelevance, undefined);
  assert.equal(reviewDraft({ ...answer, selection: "select" }).aiRelevance, undefined);
  assert.equal(reviewDraft({ ...answer, aiRelevance: "relevant" }).aiRelevance, "relevant");
  assert.equal(reviewValidation({ ...answer, aiRelevance: "irrelevant" }, "article", 1), null);
  assert.deepEqual(answer, { classification: "ok", quality: "ok", selection: "reject" });
});
test("relation tasks require only relationship and saved arrays are not mutated", () => {
  assert.ok(reviewValidation({}, "relation"));
  assert.equal(reviewValidation({ relation: "uncertain" }, "relation"), null);
  assert.equal(reviewValidation({ relation: "same_event" }, "relation", 2), null);
  for (const aiRelevance of ["relevant", "irrelevant", "uncertain"] as const) {
    assert.ok(reviewValidation({ relation: "same_event", aiRelevance }, "relation", 2));
    assert.ok(reviewValidation({ relation: "same_event", aiRelevance }, "relation", 1));
  }
  const original = { qualityReasons: ["other" as const] };
  const draft = reviewDraft(original);
  draft.qualityReasons!.push("number_unit");
  assert.deepEqual(original.qualityReasons, ["other"]);
});
test("continue resumes pending tasks then revisits later and skipped without treating them complete", () => {
  const tasks = [{ id: "a", status: "completed" }, { id: "b", status: "later" }, { id: "c", status: "pending" }, { id: "d", status: "skipped" }] as const;
  assert.equal(nextReviewIndex([...tasks]), 2);
  assert.equal(nextReviewIndex([...tasks], "c"), 2);
  const saved = tasks.map((t) => t.id === "c" ? { ...t, status: "completed" as const } : t);
  assert.equal(nextReviewIndex(saved, "c"), 1);
  assert.equal(nextReviewIndex([]), 0);
});

test("blind version 3 requires a direct category or uncertainty and preserves independent dimensions", () => {
  const answer = { classification: "ok", quality: "ok", selection: "select", aiRelevance: "relevant" } as const;
  assert.ok(reviewValidation(answer, "article", 3));
  assert.ok(reviewValidation({ ...answer, classification: "change" }, "article", 3));
  for (const category of ["ai", "science", "unrelated", "insufficient"]) {
    assert.equal(reviewValidation({ ...answer, classification: "change", category }, "article", 3), null);
  }
  assert.equal(reviewValidation({ ...answer, classification: "uncertain" }, "article", 3), null);
  assert.ok(reviewValidation({ classification: "change", category: "ai", quality: "ok", selection: "select" }, "article", 3));
  assert.ok(reviewValidation({ classification: "change", category: "ai", quality: "ok", aiRelevance: "relevant" }, "article", 3));
});
