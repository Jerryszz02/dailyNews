export type Locale = "zh-CN" | "en-US";

export type Region = "china" | "global" | "us" | "europe" | "middle-east";

export type MediaType =
  | "wire"
  | "public"
  | "commercial"
  | "business"
  | "technology"
  | "official"
  | "social";

export type Category =
  | "ai"
  | "technology"
  | "finance"
  | "international"
  | "china"
  | "policy"
  | "society"
  | "sports"
  | "entertainment"
  | "science";

export type PreferenceStrength = "not-preferred" | "preferred";

export type CandidateDisposition = "display_ready" | "degraded" | "rejected";

export type SourceAdmission = "approved" | "blocked";

export type SourcePublicationRole = "reporting" | "lead";

export interface NewsSource {
  source_id: string;
  name: string;
  countryOrRegion: Region;
  language: Locale;
  mediaType: MediaType;
  defaultWeight: number;
  credibility: number;
  sections: SourceSection[];
  mayHavePaywall: boolean;
  enabled: boolean;
  admission: SourceAdmission;
  publicationRole: SourcePublicationRole;
  allowedHosts: string[];
  allowedPathPrefixes?: string[];
  reviewedAt: string;
  reviewNote: string;
}

export interface SourceSection {
  label: string;
  url: string;
  categories: Category[];
  primaryCategory: Category;
  searchTerms?: string[];
  searchSources?: SearchSourceType[];
  requireChinese?: boolean;
}

export type SearchSourceType = "web" | "news";

export interface UserPreferences {
  topicWeights: Partial<Record<Category, PreferenceStrength>>;
  preferredSources: Record<string, number>;
  blockedKeywords: string[];
  boostedKeywords: string[];
}

export interface RawNewsItem {
  id: string;
  title: string;
  url: string;
  sourceId: string;
  sourceName: string;
  language: Locale;
  region: Region;
  categories: Category[];
  primaryCategory?: Category;
  summary: string;
  publishedAt?: string;
  updatedAt?: string;
  enrichmentUpdatedAt?: string;
  discoveredAt?: string;
  extractedAt: string;
  mayHavePaywall?: boolean;
  qualityStatus?: CandidateDisposition;
  rejectionReasons?: string[];
  translationStatus?: "translated" | "original" | "pending";
  summaryStatus?: "complete" | "pending";
  timeStatus?: "verified" | "estimated";
}

export interface NewsCluster extends RawNewsItem {
  primaryCategory: Category;
  sourceIds: string[];
  sourceNames: string[];
  relatedUrls: string[];
  primaryCategoryVotes: Category[];
  startedAt: string;
  updatedAt: string;
}

export type TrustLevel = "low" | "medium" | "high";

export interface TrustAssessment {
  score: number;
  level: TrustLevel;
  /** @deprecated Source admission is the visibility boundary; this remains true for V2 compatibility. */
  shouldShow: boolean;
  reasons: string[];
}

export interface ScoreBreakdown {
  final_score: number;
  public_importance: number;
  user_preference: number;
  timeliness: number;
  source_confidence: number;
  content_quality: number;
  ranking_reason: string;
}

export interface RankedNewsItem extends NewsCluster {
  score_breakdown: ScoreBreakdown;
  trust: TrustAssessment;
}

export type EvidenceRole = "original" | "confirmation" | "context" | "analysis" | "lead";

export type StoryStatus = "confirmed" | "developing" | "disputed" | "corrected" | "unverified";

export type ImportanceTier = "must_know" | "important" | "special_interest" | "noise";

export type EventType =
  | "policy"
  | "conflict"
  | "disaster"
  | "economy"
  | "company"
  | "product"
  | "research"
  | "culture"
  | "sports"
  | "general";

export interface StoryEvidence {
  candidateId: string;
  sourceId: string;
  sourceName: string;
  url: string;
  title: string;
  publishedAt?: string;
  role: EvidenceRole;
  independenceGroup: string;
}

export interface ImportanceFeatures {
  publicImpact: number;
  urgency: number;
  sourceSignificance: number;
  evidenceStrength: number;
  total: number;
}

export interface StoryCard {
  id: string;
  itemId: string;
  title: string;
  whatHappened: string;
  whyItMatters: string;
  keyFacts: string[];
  nextWatch: string;
  primaryBeat: Category;
  scope: Region;
  eventType: EventType;
  entities: string[];
  status: StoryStatus;
  tier: ImportanceTier;
  startedAt?: string;
  publishedAt?: string;
  updatedAt: string;
  translationStatus?: "translated" | "original" | "pending";
  summaryStatus?: "complete" | "pending";
  timeStatus?: "verified" | "estimated";
  sourceNames: string[];
  evidence: StoryEvidence[];
  importance: ImportanceFeatures;
}

export interface CoverageBeatSummary {
  beat: Category;
  candidateCount: number;
  storyCount: number;
  selectedCount: number;
}

export interface CoverageSummary {
  beats: CoverageBeatSummary[];
  coveredBeatCount: number;
  totalBeatCount: number;
  sourceCount: number;
}

export interface PublicQualitySummary {
  candidateCount: number;
  acceptedCandidateCount: number;
  rejectedCandidateCount: number;
  eventCount: number;
  selectedEventCount: number;
  duplicateEventRate: number;
  singleSourceShare: number;
  singleIndependentSourceEventShare: number;
  maxPrimaryPublisherShare: number;
  weaklySourcedCoreShare: number;
  rejectionReasons: Record<string, number>;
  latestEventCount?: number;
  unmappedCandidateCount?: number;
}

export interface StorySection {
  beat: Category;
  storyIds: string[];
}

export type ReportRefreshStatus = "fresh" | "stale" | "degraded" | "unavailable";

export type ReportServingMode = "durable" | "bundled" | "browser-cache";
export type PipelineStatus = "running" | "healthy" | "degraded" | "failed";
export type ContentStatus = "current" | "quiet" | "stale" | "unknown";
export type CoverageStatus = "current" | "stale" | "incomplete" | "unavailable";
export type RefreshOutcomeCode =
  | "published"
  | "unchanged"
  | "partial"
  | "busy"
  | "duplicate"
  | "rejected"
  | "failed";

export interface ReportRefreshMetadata {
  reportId?: string | null;
  intervalMinutes?: number;
  status?: ReportRefreshStatus;
  dataAsOf?: string | null;
  newestContentAt?: string | null;
  lastAttemptAt?: string | null;
  lastSuccessAt?: string | null;
  staleAfterMinutes?: number;
  lastError?: string | null;
  servingMode?: ReportServingMode;
  pipelineStatus?: PipelineStatus;
  contentStatus?: ContentStatus;
  coverageStatus?: CoverageStatus;
  lastCheckedAt?: string | null;
  lastFullSweepAt?: string | null;
  lastPublishedAt?: string | null;
  publicationStateAt?: string | null;
  lastOutcomeCode?: RefreshOutcomeCode | null;
  activeRunId?: string | null;
}

export interface DailyNewsReport {
  version: 2;
  generatedAt: string;
  window: { from: string; to: string };
  stories: StoryCard[];
  latestStories?: StoryCard[];
  topStories: StoryCard[];
  importantStories: StoryCard[];
  watchlist: StoryCard[];
  sections: StorySection[];
  coverage: CoverageSummary;
  quality: PublicQualitySummary;
  items: RankedNewsItem[];
  sourceCount: number;
  notes: string[];
  refresh?: ReportRefreshMetadata;
}

export interface WebReportRankingMetadata {
  categories: Category[];
  mayHavePaywall?: boolean;
}

export type WebDailyNewsReport = Omit<
  DailyNewsReport,
  "items" | "latestStories" | "topStories" | "importantStories" | "watchlist"
> & {
  webView: 1;
  latestStoryIds?: string[];
  topStoryIds: string[];
  importantStoryIds: string[];
  watchlistIds: string[];
  rankingMetadata: Record<string, WebReportRankingMetadata>;
};
