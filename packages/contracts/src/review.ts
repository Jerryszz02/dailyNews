/** Local human review. Assisted answers are never advertised as blind gold. */
export type ReviewStatus = 'pending' | 'completed' | 'skipped' | 'later';
export type ReviewQualityReason = 'fact_translation' | 'number_unit' | 'qualification' | 'attribution' | 'contamination' | 'other';
export interface ReviewAnswer {
  aiRelevance?: 'relevant' | 'irrelevant' | 'uncertain';
  classification?: 'ok' | 'change' | 'uncertain';
  category?: string;
  quality?: 'ok' | 'problem' | 'uncertain';
  qualityReasons?: ReviewQualityReason[];
  selection?: 'select' | 'reject' | 'uncertain';
  relation?: 'same_event' | 'development' | 'unrelated' | 'uncertain';
  note?: string;
}
export interface ReviewMaterial {
  articleId: string; inputRevision: number; analysisId: number; inputSignature: string | null;
  title: string; originalTitle: string; summary: string | null; bodyOriginal: string | null; bodyZh: string | null;
  url: string; sourceName: string; sourceKind: string; sourceTier: string; firstParty: boolean; language: string | null;
  publishedAt: string | null; category: string | null; selected: boolean | null; score: number | null;
  model: string | null; policyId: string | null; policyVersion: string | null;
  aiRelevanceDecision?: string | null;
  backfill: boolean; bodyStatus: string; storyTitle: string | null; factId: number | null; storyId: number | null;
}
export interface ReviewTask {
  id: string; batchId: string; position: number; kind: 'article' | 'relation'; mode: 'assisted' | 'blind'; stratum: string;
  snapshot: { article: ReviewMaterial; related?: ReviewMaterial; relationship?: 'merged' | 'unmerged'; annotationVersion?: number };
  version: number; status: ReviewStatus; answer: ReviewAnswer | null; updatedAt: string; createdAt: string;
}
export interface ReviewProgress {
  total: number; completed: number; pending: number; skipped: number; later: number;
  byCategory: Array<{ category: string; total: number; completed: number }>;
  /** Explicit judgments only; uncertain, skipped and later are separate. */
  dimensions: Record<string, Record<string, number>>;
  /** Assisted labels cannot satisfy formal acceptance without an independent blind holdout. */
  acceptance: {
    status: 'not_ready'; reason: 'blind_holdout_required';
    classificationAccuracy: null; aiFalseBlockRate: null;
    minimumBlindArticles: 200; minimumAiRelevant: 50;
  };
}
export interface ReviewBatch { id: string; label: string; mode: 'assisted' | 'blind'; createdAt: string; count: number }
export interface ReviewOverview { batches: ReviewBatch[]; progress: ReviewProgress }
export interface ReviewBatchDetail { batch: ReviewBatch; tasks: ReviewTask[]; progress: ReviewProgress }
export interface ReviewCreate { requestId: string; count?: number; label?: string }
export interface ReviewSave { requestId: string; version: number; status: Exclude<ReviewStatus, 'pending'>; answer: ReviewAnswer }
