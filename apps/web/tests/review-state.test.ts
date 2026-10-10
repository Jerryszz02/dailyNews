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
test("relation tasks require only relationship and saved arrays are not mutated", () => {
  assert.ok(reviewValidation({}, "relation"));
  assert.equal(reviewValidation({ relation: "uncertain" }, "relation"), null);
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
