import type { ReviewAnswer, ReviewTask } from "@aihot/contracts/review";

export type ReviewDraft = Partial<ReviewAnswer>;
export function reviewDraft(answer: ReviewAnswer | null | undefined): ReviewDraft {
  return answer ? { ...answer, qualityReasons: [...(answer.qualityReasons ?? [])] } : {};
}
export function reviewValidation(draft: ReviewDraft, kind: ReviewTask["kind"]): string | null {
  if (kind === "relation") return draft.relation ? null : "请选择两篇新闻的关系，拿不准也可以保存。";
  if (!draft.classification) return "请判断分类是否正确。";
  if (draft.classification === "change" && !draft.category) return "请选择修改后的分类。";
  if (!draft.quality) return "请判断标题和摘要是否忠于原文。";
  if (draft.quality === "problem" && !draft.qualityReasons?.length) return "请选择至少一种问题。";
  if (!draft.selection) return "请选择是否应该精选。";
  return null;
}
export function nextReviewIndex(tasks: Pick<ReviewTask, "id" | "status">[], currentId?: string): number {
  const current = tasks.findIndex((t) => t.id === currentId);
  for (let offset = 1; offset <= tasks.length; offset++) {
    const index = (current + offset) % tasks.length;
    if (tasks[index]?.status === "pending") return index;
  }
  for (const status of ["later", "skipped"]) {
    const index = tasks.findIndex((t) => t.status === status && t.id !== currentId);
    if (index >= 0) return index;
  }
  return Math.max(0, current);
}
