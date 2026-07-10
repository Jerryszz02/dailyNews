import {
  CalendarDays,
  CircleAlert,
  Clock3,
  Eye,
  Newspaper,
  RefreshCw,
  Search,
  Settings2,
  Star,
  Target,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type React from "react";
import { defaultPreferences } from "./config/preferences";
import { newsSources } from "./config/sources";
import { firecrawlSnapshotNews } from "./data/firecrawlSnapshot";
import { buildDailyReport } from "./lib/newsPipeline";
import { rankNews } from "./lib/scoring";
import { normalizeText } from "./lib/text";
import type { Category, DailyNewsReport, PreferenceStrength, RawNewsItem, StoryCard, UserPreferences } from "./types";

const categories: { id: Category; label: string }[] = [
  { id: "ai", label: "AI" },
  { id: "technology", label: "科技" },
  { id: "finance", label: "财经" },
  { id: "international", label: "国际" },
  { id: "china", label: "国内" },
  { id: "policy", label: "政策" },
  { id: "society", label: "社会" },
  { id: "science", label: "科学" },
  { id: "sports", label: "体育" },
  { id: "entertainment", label: "娱乐" },
];

const strengthOptions: { value: PreferenceStrength; label: string }[] = [
  { value: "not-preferred", label: "不偏好" },
  { value: "preferred", label: "偏好" },
];

type ActiveView = "preferred" | "settings" | Category;
type LoadState = "idle" | "loading" | "ready" | "error";

const initialVisibleCount = 18;
const visibleStep = 18;
const preferencesStorageKey = "daily-news-preferences";
const refreshIntervalMs = 60_000;

export function App() {
  const [loadedReport, setLoadedReport] = useState<DailyNewsReport | null>(null);
  const [preferences, setPreferences] = useState<UserPreferences>(() => loadStoredPreferences());
  const [activeView, setActiveView] = useState<ActiveView>("preferred");
  const [searchQuery, setSearchQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(initialVisibleCount);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [lastLoadedAt, setLastLoadedAt] = useState<string | null>(null);
  const [loadError, setLoadError] = useState("");

  const refreshNews = useCallback(async () => {
    setLoadState((current) => (current === "ready" ? current : "loading"));

    const apiReport = await readReport("/api/news");
    if (apiReport) {
      setLoadedReport(apiReport);
      setLastLoadedAt(new Date().toISOString());
      setLoadError("");
      setLoadState("ready");
      return;
    }

    const staticReport = await readReport("/daily-news.json");
    if (staticReport) {
      setLoadedReport(staticReport);
      setLastLoadedAt(new Date().toISOString());
      setLoadError("实时接口暂不可用，当前显示静态兜底数据。");
      setLoadState("ready");
      return;
    }

    const report = buildDailyReport(firecrawlSnapshotNews, defaultPreferences);
    setLoadedReport(report);
    setLastLoadedAt(new Date().toISOString());
    setLoadError("实时接口和静态新闻都暂不可用，当前显示本地兜底数据。");
    setLoadState("error");
  }, []);

  useEffect(() => {
    void refreshNews();
    const timer = window.setInterval(() => {
      void refreshNews();
    }, refreshIntervalMs);
    return () => window.clearInterval(timer);
  }, [refreshNews]);

  useEffect(() => {
    localStorage.setItem(preferencesStorageKey, JSON.stringify(preferences));
  }, [preferences]);

  useEffect(() => {
    setVisibleCount(initialVisibleCount);
  }, [activeView, searchQuery, preferences]);

  const fallbackReport = useMemo(() => buildDailyReport(firecrawlSnapshotNews, defaultPreferences), []);
  const report = loadedReport ?? fallbackReport;
  const personalizedOrder = useMemo(
    () => new Map(rankNews(report.items, preferences).map((item, index) => [item.id, index])),
    [preferences, report.items],
  );
  const categoryStories = useMemo(() => {
    if (activeView === "preferred" || activeView === "settings") return [];
    return filterStories(
      report.stories
        .filter((story) => story.primaryBeat === activeView)
        .sort(
          (left, right) =>
            (personalizedOrder.get(left.itemId) ?? Number.MAX_SAFE_INTEGER) -
            (personalizedOrder.get(right.itemId) ?? Number.MAX_SAFE_INTEGER),
        ),
      searchQuery,
    );
  }, [activeView, personalizedOrder, report.stories, searchQuery]);
  const pageStories = categoryStories.slice(0, visibleCount);
  const canShowMore = categoryStories.length > pageStories.length;

  return (
    <main className="app-shell">
      <aside className="sidebar" aria-label="主导航">
        <div className="brand">
          <span>AI</span>
          <strong>NEWS</strong>
        </div>
        <nav className="sidebar-nav">
          <NavButton active={activeView === "preferred"} icon={<Zap size={16} />} label="今日简报" onClick={() => setActiveView("preferred")} />
          {categories.map((category) => (
            <NavButton
              active={activeView === category.id}
              icon={<Newspaper size={16} />}
              key={category.id}
              label={category.label}
              onClick={() => setActiveView(category.id)}
            />
          ))}
          <NavButton active={activeView === "settings"} icon={<Settings2 size={16} />} label="设置" onClick={() => setActiveView("settings")} />
        </nav>
      </aside>

      <section className="workspace">
        <header className="hero-panel">
          <div>
            <p className="eyebrow">{activeView === "preferred" ? "每日总览" : activeView === "settings" ? "配置中心" : "分类动态"}</p>
            <h1>{viewTitle(activeView)}</h1>
            <p className="hero-subtitle">事件级聚合 · 多来源证据 · 重要性分层</p>
          </div>
          <div className="status-panel">
            <div>
              <CalendarDays size={16} />
              <span>{formatDay(report.generatedAt)}</span>
            </div>
            <div>
              <Clock3 size={16} />
              <span>{lastLoadedAt ? formatRelativeTime(lastLoadedAt) : "等待加载"}</span>
            </div>
            <button className="icon-button" disabled={loadState === "loading"} onClick={() => void refreshNews()} title="刷新新闻" type="button">
              <RefreshCw className={loadState === "loading" ? "spin" : ""} size={17} />
            </button>
          </div>
        </header>

        {activeView === "settings" ? (
          <PreferencesPanel preferences={preferences} setPreferences={setPreferences} />
        ) : (
          <>
            <section className="filters-panel" aria-label="筛选">
              <div className="section-tabs" role="tablist">
                <button className={activeView === "preferred" ? "active" : ""} type="button" onClick={() => setActiveView("preferred")}>
                  今日简报
                </button>
                {categories.map((category) => (
                  <button
                    className={activeView === category.id ? "active" : ""}
                    key={category.id}
                    type="button"
                    onClick={() => setActiveView(category.id)}
                  >
                    {category.label}
                  </button>
                ))}
              </div>
              <label className="search-box">
                <Search size={17} />
                <input
                  placeholder="搜索事件、事实、来源..."
                  type="search"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                />
              </label>
            </section>

            {loadError ? <div className="page-note">{loadError}</div> : null}

            {activeView === "preferred" ? (
              <BriefingHome preferences={preferences} query={searchQuery} report={report} />
            ) : (
              <>
                <section className="story-section category-story-section" aria-label={`${categoryLabel(activeView)}事件`}>
                  <div className="story-section-heading">
                    <div>
                      <p className="eyebrow">分类深读</p>
                      <h2>{categoryLabel(activeView)}</h2>
                    </div>
                    <span>{categoryStories.length} 个达到质量门槛的事件</span>
                  </div>
                  {pageStories.length === 0 ? (
                    <div className="empty-state">{loadState === "loading" ? "正在加载新闻..." : "该栏目暂无达到质量门槛的事件。"}</div>
                  ) : null}
                  <div className="story-grid">
                    {pageStories.map((story) => <EventCard key={story.id} story={story} variant="compact" />)}
                  </div>
                </section>

                {canShowMore ? (
                  <button className="show-more" type="button" onClick={() => setVisibleCount((current) => current + visibleStep)}>
                    展开更多 {Math.min(visibleStep, categoryStories.length - pageStories.length)} 个事件
                  </button>
                ) : null}
              </>
            )}
          </>
        )}
      </section>
    </main>
  );
}

function BriefingHome({ report, preferences, query }: { report: DailyNewsReport; preferences: UserPreferences; query: string }) {
  const itemOrder = new Map(rankNews(report.items, preferences).map((item, index) => [item.id, index]));
  const topStories = filterStories(report.topStories, query);
  const importantStories = filterStories(
    [...report.importantStories].sort(
      (left, right) => (itemOrder.get(left.itemId) ?? Number.MAX_SAFE_INTEGER) - (itemOrder.get(right.itemId) ?? Number.MAX_SAFE_INTEGER),
    ),
    query,
  );
  const watchlist = filterStories(report.watchlist, query);
  const visibleStoryCount = topStories.length + importantStories.length + watchlist.length;

  return (
    <div className="briefing-home">
      <section className="briefing-summary" aria-label="日报质量概览">
        <div>
          <span>本期事件</span>
          <strong>{report.quality.eventCount}</strong>
        </div>
        <div>
          <span>覆盖栏目</span>
          <strong>{report.coverage.coveredBeatCount}/{report.coverage.totalBeatCount}</strong>
        </div>
        <div>
          <span>独立来源</span>
          <strong>{report.sourceCount}</strong>
        </div>
        <p>同一事件只出现一次；未确认线索不会进入核心简报。</p>
      </section>

      {visibleStoryCount === 0 ? <div className="empty-state">没有匹配当前搜索的事件。</div> : null}

      {topStories.length > 0 ? (
        <section className="story-section must-know-section" aria-labelledby="must-know-title">
          <div className="story-section-heading">
            <div>
              <p className="eyebrow">先读这些</p>
              <h2 id="must-know-title">今日必知</h2>
            </div>
            <span>{topStories.length} 个高影响事件</span>
          </div>
          <ol className="story-pulse">
            {topStories.map((story, index) => (
              <li key={story.id}>
                <span className="pulse-index">{String(index + 1).padStart(2, "0")}</span>
                <EventCard story={story} variant="lead" />
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {importantStories.length > 0 ? (
        <section className="story-section" aria-labelledby="important-title">
          <div className="story-section-heading">
            <div>
              <p className="eyebrow">值得掌握</p>
              <h2 id="important-title">重要进展</h2>
            </div>
            <span>偏好只调整本层顺序</span>
          </div>
          <div className="story-grid">
            {importantStories.map((story) => <EventCard key={story.id} story={story} variant="compact" />)}
          </div>
        </section>
      ) : null}

      {watchlist.length > 0 ? (
        <section className="story-section watch-section" aria-labelledby="watch-title">
          <div className="story-section-heading">
            <div>
              <p className="eyebrow">事实仍在变化</p>
              <h2 id="watch-title">持续关注</h2>
            </div>
            <span>不确定性已明确标记</span>
          </div>
          <div className="watch-list">
            {watchlist.map((story) => <EventCard key={story.id} story={story} variant="watch" />)}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function EventCard({ story, variant }: { story: StoryCard; variant: "lead" | "compact" | "watch" }) {
  const primaryEvidence = story.evidence[0];
  const facts = story.keyFacts.filter((fact) => normalizeText(fact) !== normalizeText(story.whatHappened)).slice(0, 2);

  return (
    <article className={`event-card ${variant}`}>
      <div className="event-meta">
        <span className={`event-status ${story.status}`}>{storyStatusLabel(story.status)}</span>
        <span>{categoryLabel(story.primaryBeat)}</span>
        <span>{story.evidence.length} 个证据来源</span>
        <span>{formatStoryAge(story)}</span>
      </div>
      <h3>
        <a href={primaryEvidence?.url} rel="noreferrer" target="_blank">{story.title}</a>
      </h3>
      <p className="event-summary">{story.whatHappened}</p>
      {facts.length > 0 && variant === "lead" ? (
        <ul className="fact-list">{facts.map((fact) => <li key={fact}>{fact}</li>)}</ul>
      ) : null}
      <div className="event-explanation">
        <Target size={15} />
        <span>{story.whyItMatters}</span>
      </div>
      {variant !== "compact" ? (
        <div className="event-next">
          {variant === "watch" ? <CircleAlert size={15} /> : <Eye size={15} />}
          <span>{story.nextWatch}</span>
        </div>
      ) : null}
      <footer>
        <span>{story.sourceNames.map(sourceLabel).join(" / ")}</span>
        {primaryEvidence ? <a href={primaryEvidence.url} rel="noreferrer" target="_blank">查看原文</a> : null}
      </footer>
    </article>
  );
}

function NavButton({ active, icon, label, onClick }: { active: boolean; icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button className={active ? "active" : ""} type="button" onClick={onClick}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

function PreferencesPanel({
  preferences,
  setPreferences,
}: {
  preferences: UserPreferences;
  setPreferences: React.Dispatch<React.SetStateAction<UserPreferences>>;
}) {
  return (
    <section className="preferences-panel" aria-label="偏好设置">
      <div className="panel-heading">
        <Settings2 size={20} />
        <h2>偏好</h2>
      </div>

      <div className="topic-list">
        {categories.map((category) => (
          <div className="topic-row" key={category.id}>
            <span>{category.label}</span>
            <div className="segmented">
              {strengthOptions.map((option) => (
                <button
                  className={(preferences.topicWeights[category.id] ?? "not-preferred") === option.value ? "active" : ""}
                  key={option.value}
                  type="button"
                  onClick={() =>
                    setPreferences((current) => ({
                      ...current,
                      topicWeights: {
                        ...current.topicWeights,
                        [category.id]: option.value,
                      },
                    }))
                  }
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="source-summary">
        <div>
          <Star size={18} />
          <span>{newsSources.filter((source) => source.enabled).length} 个启用来源</span>
        </div>
      </div>
    </section>
  );
}

async function readReport(url: string): Promise<DailyNewsReport | null> {
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) return null;
    const report = (await response.json()) as Partial<DailyNewsReport>;
    if (!Array.isArray(report.items) || report.items.length === 0 || typeof report.generatedAt !== "string") return null;
    if (
      report.version === 2 &&
      Array.isArray(report.stories) &&
      Array.isArray(report.topStories) &&
      Array.isArray(report.importantStories) &&
      Array.isArray(report.watchlist) &&
      Array.isArray(report.sections) &&
      report.coverage &&
      report.quality
    ) {
      return report as DailyNewsReport;
    }
    const generatedAt = Date.parse(report.generatedAt);
    return buildDailyReport(
      report.items as RawNewsItem[],
      defaultPreferences,
      Number.isFinite(generatedAt) ? new Date(generatedAt) : new Date(),
    );
  } catch {
    return null;
  }
}

function filterStories(stories: StoryCard[], query: string): StoryCard[] {
  const normalized = normalizeText(query);
  if (!normalized) return stories;
  return stories.filter((story) =>
    normalizeText(
      `${story.title} ${story.whatHappened} ${story.whyItMatters} ${story.sourceNames.join(" ")} ${story.primaryBeat} ${story.eventType}`,
    ).includes(normalized),
  );
}

function viewTitle(view: ActiveView): string {
  if (view === "preferred") return "今日简报";
  if (view === "settings") return "偏好设置";
  return `${categoryLabel(view)}动态`;
}

function categoryLabel(category: Category): string {
  return categories.find((item) => item.id === category)?.label ?? category;
}

export function sourceLabel(sourceName: string): string {
  const sourceLabels: Record<string, string> = {
    "Al Jazeera": "半岛电视台",
    Anthropic: "Anthropic 官方动态",
    "Associated Press": "美联社",
    "Ars Technica": "科技媒体 Ars Technica",
    BBC: "英国广播公司",
    Bloomberg: "彭博社",
    CNBC: "美国消费者新闻与商业频道",
    CNN: "美国有线电视新闻网",
    ESPN: "ESPN 体育",
    "Google AI": "Google AI 官方动态",
    "Google DeepMind": "Google DeepMind 官方动态",
    "Hugging Face": "Hugging Face 官方动态",
    "Meta AI": "Meta AI 官方动态",
    "Microsoft AI": "Microsoft AI 官方动态",
    "NVIDIA AI": "NVIDIA AI 官方动态",
    NPR: "美国国家公共广播电台",
    OpenAI: "OpenAI 官方动态",
    Reuters: "路透社",
    "Shams Charania": "沙姆斯·查拉尼亚",
    TechCrunch: "科技媒体 TechCrunch",
    "MIT Technology Review": "麻省理工科技评论",
    "The Guardian": "卫报",
    "The Verge": "科技媒体 The Verge",
    "OpenAI X": "OpenAI 社交动态",
    "Anthropic X": "Anthropic 社交动态",
    "Google DeepMind X": "Google DeepMind 社交动态",
    "Sam Altman X": "Sam Altman 社交动态",
    "Greg Brockman X": "Greg Brockman 社交动态",
    "Andrej Karpathy X": "Andrej Karpathy 社交动态",
    Wired: "连线",
  };

  return sourceLabels[sourceName] ?? sourceName;
}

function storyStatusLabel(status: StoryCard["status"]): string {
  if (status === "confirmed") return "已确认";
  if (status === "developing") return "发展中";
  if (status === "disputed") return "存在争议";
  if (status === "corrected") return "已更正";
  return "待核验";
}

function formatStoryAge(story: StoryCard): string {
  return formatRelativeTime(story.updatedAt || story.publishedAt || new Date().toISOString());
}

function formatDay(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date(value));
}

function formatRelativeTime(value: string): string {
  const ageMs = Date.now() - Date.parse(value);
  if (!Number.isFinite(ageMs)) return "刚刚";
  const minutes = Math.max(0, Math.round(ageMs / 60_000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  return `${Math.round(hours / 24)}天前`;
}

function loadStoredPreferences(): UserPreferences {
  try {
    const stored = localStorage.getItem(preferencesStorageKey);
    if (!stored) {
      return defaultPreferences;
    }

    const parsed = JSON.parse(stored) as Partial<UserPreferences>;
    return {
      ...defaultPreferences,
      ...parsed,
      topicWeights: normalizeTopicWeights(parsed.topicWeights),
      preferredSources: parsed.preferredSources ?? defaultPreferences.preferredSources,
      blockedKeywords: parsed.blockedKeywords ?? defaultPreferences.blockedKeywords,
      boostedKeywords: parsed.boostedKeywords ?? defaultPreferences.boostedKeywords,
    };
  } catch {
    return defaultPreferences;
  }
}

function normalizeTopicWeights(topicWeights: Partial<Record<Category, unknown>> | undefined): Partial<Record<Category, PreferenceStrength>> {
  const normalized: Partial<Record<Category, PreferenceStrength>> = {};
  for (const category of categories) {
    normalized[category.id] = normalizePreferenceStrength(topicWeights?.[category.id] ?? defaultPreferences.topicWeights[category.id]);
  }
  return normalized;
}

function normalizePreferenceStrength(value: unknown): PreferenceStrength {
  return value === "preferred" || value === "medium" || value === "high" ? "preferred" : "not-preferred";
}
