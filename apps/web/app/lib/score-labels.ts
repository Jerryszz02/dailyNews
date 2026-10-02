export function scoreLabel(kind: "ai_attention" | "legacy_curation_total" | null): string {
  return kind === "ai_attention" ? "AI 注意力" : kind === "legacy_curation_total" ? "公共重要性" : "评分";
}

export function compactScoreLabel(kind: "ai_attention" | "legacy_curation_total" | null): string {
  return kind === "ai_attention" ? "AI 关注" : kind === "legacy_curation_total" ? "重要性" : "评分";
}
