import { compactScoreLabel, scoreLabel } from "../../lib/score-labels";

/** A strategy-specific score pill; tint is visual only and never orders different policies. */
const TIERS = [
  { min: 85, className: "bg-hot/10 text-hot ring-hot/25" },
  { min: 70, className: "bg-accent-soft text-accent ring-accent/20" },
  { min: 0, className: "text-ink-4 ring-line-soft" },
];

const STATUS_LABELS: Record<string, string> = {
  confirmed: "已确认", developing: "进展中", disputed: "有争议", corrected: "已更正", unverified: "待核实",
};
const TIER_LABELS: Record<string, string> = {
  must_know: "今日必知", important: "重要进展", special_interest: "专题关注", noise: "一般动态",
};

export function FactJudgment({ tier, status }: { tier: string | null; status: string | null }) {
  const labels = [tier && TIER_LABELS[tier], status && STATUS_LABELS[status]].filter(Boolean);
  return labels.length ? <span className="text-[11px] text-ink-4">{labels.join(" · ")}</span> : null;
}

export function ScoreLabel({ score, scoreKind, compact = false }: { score: number | null; scoreKind: "ai_attention" | "legacy_curation_total" | null; compact?: boolean }) {
  if (score === null) return null;
  const value = Math.round(score);
  const tier = TIERS.find((t) => value >= t.min)!;
  const label = scoreLabel(scoreKind);
  return (
    <span
      title={`${label} ${value}/100`}
      aria-label={`${label} ${value} 分`}
      className={`inline-flex h-[20px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 ring-1 ring-inset ${tier.className}`}
    >
      <span className="text-[11px] font-medium leading-none opacity-80">{compact ? compactScoreLabel(scoreKind) : label}</span>
      <span className="h-2.5 w-px bg-current opacity-25" aria-hidden="true" />
      <span className="mono text-[12.5px] font-bold leading-none tabular-nums">{value}</span>
    </span>
  );
}
