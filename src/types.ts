export type Locale = "zh-CN" | "en-US";

export type Region = "china" | "global" | "us" | "europe" | "middle-east";

export type MediaType =
  | "wire"
  | "public"
  | "commercial"
  | "business"
  | "technology";

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

export type PreferenceStrength = "low" | "medium" | "high";

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
}

export interface UserPreferences {
  topicWeights: Partial<Record<Category, PreferenceStrength>>;
  regionMode: "zh-first" | "global-first" | "balanced";
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
  summary: string;
  publishedAt?: string;
  extractedAt: string;
  mayHavePaywall?: boolean;
}

export interface NewsCluster extends RawNewsItem {
  sourceIds: string[];
  sourceNames: string[];
  relatedUrls: string[];
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
}

export interface DailyNewsReport {
  generatedAt: string;
  items: RankedNewsItem[];
  sourceCount: number;
  notes: string[];
}
