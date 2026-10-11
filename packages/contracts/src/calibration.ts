/** A bounded, local calibration experiment. Holdout results are not production accuracy. */
export interface CalibrationRule {
  id: string;
  dimension: 'category' | 'selection';
  fromCategory: string | null;
  token: string;
  value: string | false;
  support: number;
  corrected: number;
}
export interface CalibrationPolicy {
  id: string;
  algorithm: 'token-corrections-v1';
  rules: CalibrationRule[];
}
export interface CalibrationExample {
  id: string;
  title: string;
  body: string;
  category: string | null;
  selected: boolean | null;
  goldCategory: string | null;
  goldSelected: boolean | null;
}
export interface CalibrationMetric {
  evaluated: number;
  baselineErrors: number;
  candidateErrors: number;
  corrected: number;
  regressed: number;
  baselineFalseSelects: number;
  candidateFalseSelects: number;
  baselineMisses: number;
  candidateMisses: number;
}
export interface CalibrationReport {
  train: number;
  holdout: number;
  category: CalibrationMetric;
  selectionAi: CalibrationMetric;
  selectionNonAi: CalibrationMetric;
  passed: boolean;
  reasons: string[];
  /** Diagnostic-only labels do not silently become learned rules. */
  diagnostics?: {
    excludedCategories: number;
    uncertainSelections: number;
    qualityProblems: number;
    holdoutAiRelevant: number;
    holdoutAiFalseBlocks: number;
    holdoutAiUnrecorded: number;
  };
  changes: Array<{ taskId: string; dimension: 'category' | 'selection'; before: string | boolean | null; after: string | boolean | null; correct: boolean }>;
}
export interface CalibrationCandidate {
  id: string;
  policy: CalibrationPolicy;
  report: CalibrationReport;
  createdAt: string;
}
export interface CalibrationOverview {
  batchId: string | null;
  target: 200;
  completed: number;
  total: number;
  train: number;
  holdout: number;
  candidate: CalibrationCandidate | null;
  activeCandidateId: string | null;
  frozen: boolean;
}
