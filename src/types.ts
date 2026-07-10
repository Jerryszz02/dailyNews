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
  extractedAt: string;
  mayHavePaywall?: boolean;
}

export interface NewsCluster extends RawNewsItem {
  primaryCategory: Category;
  sourceIds: string[];
  sourceNames: string[];
  relatedUrls: string[];
  primaryCategoryVotes: Category[];
}

export type TrustLevel = "low" | "medium" | "high";

export interface TrustAssessment {
  score: number;
  level: TrustLevel;
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
  publishedAt?: string;
  updatedAt: string;
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
  rejectionReasons: Record<string, number>;
}

export interface StorySection {
  beat: Category;
  storyIds: string[];
}

export interface DailyNewsReport {
  version: 2;
  generatedAt: string;
  window: { from: string; to: string };
  stories: StoryCard[];
  topStories: StoryCard[];
  importantStories: StoryCard[];
  watchlist: StoryCard[];
  sections: StorySection[];
  coverage: CoverageSummary;
  quality: PublicQualitySummary;
  items: RankedNewsItem[];
  sourceCount: number;
  notes: string[];
}
