import type { ReviewAnswer, ReviewTask } from "@aihot/contracts/review";

export type ReviewDraft = Partial<ReviewAnswer>;
export function reviewDraft(answer: ReviewAnswer | null | undefined): ReviewDraft {
  return answer ? { ...answer, qualityReasons: [...(answer.qualityReasons ?? [])] } : {};
}
export function reviewValidation(draft: ReviewDraft, kind: ReviewTask["kind"], annotationVersion = 1): string | null {
  if (kind === "relation") {
    if (draft.aiRelevance !== undefined) return "关系任务不能填写 AI 相关性。";
    return draft.relation ? null : "请选择两篇新闻的关系，拿不准也可以保存。";
  }
  if (annotationVersion >= 2 && !draft.aiRelevance) return "请独立判断新闻是否与 AI 相关，拿不准也可以保存。";
  if (annotationVersion >= 3 && draft.classification === "ok") return "请直接选择新闻分类，拿不准也可以保存。";
  if (!draft.classification) return annotationVersion >= 3 ? "请直接选择新闻分类。" : "请判断分类是否正确。";
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
