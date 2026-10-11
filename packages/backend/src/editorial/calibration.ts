import type { CalibrationExample, CalibrationMetric, CalibrationPolicy, CalibrationReport, CalibrationRule } from '@aihot/contracts/calibration';
import { isCategoryKey } from '@aihot/contracts/taxonomy';
import { sql, type Db } from '../db.ts';

export const CALIBRATION_MIN_BODY_CHARS = 80;
/** Same original-material scope as the one-off blind sample; preserve SQL coalesce semantics. */
export function calibrationEligible(input: { body: string | null; xPost?: unknown; sourceKind?: string }): boolean {
  if (input.xPost != null || input.sourceKind === 'x_search') return false;
  // PostgreSQL length(text) counts Unicode characters rather than UTF-16 code units.
  let length = 0;
  for (const _character of input.body ?? '') if (++length >= CALIBRATION_MIN_BODY_CHARS) return true;
  return false;
}

const STOP = new Set('the and for with from that this have has are was were will would into about after before your their new news today said says more some than then also only not our you all can its how who what when where why 新闻 报道 表示 记者 目前 相关 进行 一个 我们 已经 可以 以及 这个 中国 今天 最新 通过 其中 他们 这些'.split(' '));
/** Identical bounded original-text features for training, holdout and runtime. */
export function calibrationTokens(title: string, body: string): Set<string> {
  const text = `${title}\n${body}`.slice(0, 12000).toLowerCase();
  const words: string[] = text.match(/\b[a-z][a-z0-9_-]{2,31}\b/g) ?? [];
  for (const segment of text.match(/[\u3400-\u9fff]+/g) ?? []) {
    for (let i = 0; i < segment.length - 1; i++) words.push(segment.slice(i, i + 2));
  }
  return new Set([...new Set(words)].filter(token => !STOP.has(token)).sort().slice(0, 512));
}

export function trainCalibration(examples: CalibrationExample[], id: string): CalibrationPolicy {
  const unique = [...new Map(examples.map(example => [example.id, example])).values()];
  const buckets = new Map<string, { dimension: 'category' | 'selection'; category: string | null; token: string; examples: CalibrationExample[] }>();
  for (const example of unique) for (const token of calibrationTokens(example.title, example.body)) {
    for (const dimension of ['category', 'selection'] as const) {
      if (dimension === 'category' ? !isCategoryKey(example.goldCategory) : !isCategoryKey(example.category) || typeof example.goldSelected !== 'boolean' || typeof example.selected !== 'boolean') continue;
      const key = JSON.stringify([dimension, example.category, token]);
      const bucket = buckets.get(key) ?? { dimension, category: example.category, token, examples: [] };
      bucket.examples.push(example);
      buckets.set(key, bucket);
    }
  }
  const candidates: Omit<CalibrationRule, 'id'>[] = [];
  for (const bucket of buckets.values()) {
    const labels = new Set(bucket.examples.map(example => bucket.dimension === 'category' ? example.goldCategory : example.goldSelected));
    const value = [...labels][0];
    if (bucket.examples.length < 3 || labels.size !== 1 || (bucket.dimension === 'selection' ? value !== false : !isCategoryKey(value))) continue;
    const corrected = bucket.examples.filter(example => (bucket.dimension === 'category' ? example.category : example.selected) !== value).length;
    if (corrected < 2) continue;
    candidates.push({ dimension: bucket.dimension, fromCategory: bucket.category, token: bucket.token, value: value as string | false, support: bucket.examples.length, corrected });
  }
  candidates.sort((a, b) => b.corrected - a.corrected || b.support - a.support || JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return { id, algorithm: 'token-corrections-v1', rules: candidates.slice(0, 48).map((rule, i) => ({ id: `${id}:${i + 1}`, ...rule })) };
}

export function predictCalibration(policy: CalibrationPolicy | null, input: { title: string; body: string; category: string | null; selected: boolean | null; xPost?: unknown; sourceKind?: string }) {
  if (!policy?.rules.length || !calibrationEligible(input)) return { category: input.category, selected: input.selected, ruleIds: [] as string[] };
  const tokens = calibrationTokens(input.title, input.body);
  const matches = (policy?.rules ?? []).filter(rule => rule.fromCategory === input.category && tokens.has(rule.token));
  let category = input.category;
  let selected = input.selected;
  const ruleIds: string[] = [];
  const categories = matches.filter(rule => rule.dimension === 'category' && isCategoryKey(rule.value));
  if (new Set(categories.map(rule => rule.value)).size === 1) {
    category = categories[0]!.value as string;
    ruleIds.push(...categories.map(rule => rule.id));
  }
  const selection = matches.filter(rule => rule.dimension === 'selection' && rule.value === false);
  if (selected === true && selection.length && sameCalibrationFamily(input.category, category)) {
    selected = false;
    ruleIds.push(...selection.map(rule => rule.id));
  }
  return { category, selected, ruleIds };
}

/** Selection evidence belongs to the original AI or deterministic non-AI route. */
export function sameCalibrationFamily(before: string | null, after: string | null): boolean {
  return isCategoryKey(before) && isCategoryKey(after) && (before === 'ai') === (after === 'ai');
}

const emptyMetric = (): CalibrationMetric => ({ evaluated: 0, baselineErrors: 0, candidateErrors: 0, corrected: 0, regressed: 0, baselineFalseSelects: 0, candidateFalseSelects: 0, baselineMisses: 0, candidateMisses: 0 });
export function evaluateCalibration(policy: CalibrationPolicy, trainCount: number, holdoutExamples: CalibrationExample[]): CalibrationReport {
  const report: CalibrationReport = { train: trainCount, holdout: holdoutExamples.length, category: emptyMetric(), selectionAi: emptyMetric(), selectionNonAi: emptyMetric(), passed: false, reasons: [], changes: [] };
  for (const example of holdoutExamples) {
    const prediction = predictCalibration(policy, example);
    for (const dimension of ['category', 'selection'] as const) {
      const gold = dimension === 'category' ? example.goldCategory : example.goldSelected;
      const before = dimension === 'category' ? example.category : example.selected;
      const after = dimension === 'category' ? prediction.category : prediction.selected;
      if (dimension === 'category' ? !isCategoryKey(gold) : typeof gold !== 'boolean' || typeof before !== 'boolean' || !isCategoryKey(example.category)) continue;
      const metric = dimension === 'category' ? report.category : example.category === 'ai' ? report.selectionAi : report.selectionNonAi;
      metric.evaluated++;
      metric.baselineErrors += Number(before !== gold);
      metric.candidateErrors += Number(after !== gold);
      metric.corrected += Number(before !== gold && after === gold);
      metric.regressed += Number(before === gold && after !== gold);
      if (dimension === 'selection') {
        metric.baselineFalseSelects += Number(before === true && gold === false);
        metric.candidateFalseSelects += Number(after === true && gold === false);
        metric.baselineMisses += Number(before === false && gold === true);
        metric.candidateMisses += Number(after === false && gold === true);
      }
      if (before !== after) report.changes.push({ taskId: example.id, dimension, before, after, correct: after === gold });
    }
  }
  if (trainCount !== 160 || holdoutExamples.length !== 40 || new Set(holdoutExamples.map(example => example.id)).size !== 40) report.reasons.push('需要固定的 160 条训练与 40 条独立留出样本');
  if (!policy.rules.length) report.reasons.push('没有满足训练证据门槛的纠正规则');
  if (report.category.evaluated < 30 || report.selectionAi.evaluated + report.selectionNonAi.evaluated < 30) report.reasons.push('分类和精选各需至少 30 条有效留出标签');
  for (const [name, metric] of [['分类', report.category], ['AI 精选', report.selectionAi], ['非 AI 精选', report.selectionNonAi]] as const) {
    if (metric.regressed) report.reasons.push(`${name}出现 ${metric.regressed} 条回退`);
    const included = policy.rules.some(rule => name === '分类' ? rule.dimension === 'category'
      : rule.dimension === 'selection' && (rule.fromCategory === 'ai') === (name === 'AI 精选'));
    if (included && metric.corrected < 2) report.reasons.push(`${name}规则至少需纠正 2 条留出错误`);
  }
  if (!report.category.corrected && !report.selectionAi.corrected && !report.selectionNonAi.corrected) report.reasons.push('留出集没有可验证的改善');
  report.reasons.unshift('仅验证固定基线的本地纠错层，不代表端到端模型质量');
  report.passed = report.reasons.length === 1;
  return report;
}

export async function loadActiveCalibration(db: Db = sql): Promise<CalibrationPolicy | null> {
  const [row] = await db<{ policy: CalibrationPolicy; report: CalibrationReport }[]>`
    SELECT c.policy, c.report FROM review_calibration_state s
    JOIN review_calibration_candidates c ON c.id = s.active_candidate_id WHERE s.id = 1`;
  return row?.report.passed && row.policy.algorithm === 'token-corrections-v1' && row.policy.rules.length ? row.policy : null;
}
