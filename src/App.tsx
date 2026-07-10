import {
  CalendarDays,
  Clock3,
  RefreshCw,
  Search,
  Settings2,
  Star,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
type EventVariant = "lead" | "brief" | "compact" | "watch";

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
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

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

  useEffect(() => {
    if (mobileSearchOpen) searchInputRef.current?.focus();
  }, [mobileSearchOpen]);

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
  const selectView = (view: ActiveView) => {
    setActiveView(view);
    setMobileSearchOpen(false);
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="topbar-main">
          <button className="brand" type="button" onClick={() => selectView("preferred")} aria-label="返回今日简报">
            <span>AI</span>
            <strong>NEWS</strong>
          </button>

          <div className="topbar-date">
            <CalendarDays size={16} strokeWidth={1.8} />
            <span>{formatDay(report.generatedAt)}</span>
          </div>

          <label className={`search-box topbar-search ${mobileSearchOpen ? "open" : ""}`}>
            <Search size={17} strokeWidth={1.8} />
            <input
              aria-label="搜索新闻"
              placeholder="搜索事件、事实或来源"
              ref={searchInputRef}
              type="search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
            />
          </label>

          <div className="topbar-actions">
            <button
              aria-expanded={mobileSearchOpen}
              aria-label={mobileSearchOpen ? "收起搜索" : "展开搜索"}
              className="icon-button mobile-search-toggle"
              onClick={() => setMobileSearchOpen((current) => !current)}
              type="button"
            >
              <Search size={18} strokeWidth={1.8} />
            </button>
            <button
              aria-label="刷新新闻"
              className="icon-button"
              disabled={loadState === "loading"}
              onClick={() => void refreshNews()}
              title="刷新新闻"
              type="button"
            >
              <RefreshCw className={loadState === "loading" ? "spin" : ""} size={18} strokeWidth={1.8} />
            </button>
            <button
              aria-current={activeView === "settings" ? "page" : undefined}
              aria-label="偏好设置"
              className={`settings-button ${activeView === "settings" ? "active" : ""}`}
              onClick={() => selectView("settings")}
              type="button"
            >
              <Settings2 size={18} strokeWidth={1.8} />
              <span>设置</span>
            </button>
          </div>
        </div>

        <nav className="category-nav" aria-label="分类导航">
          <button
            aria-current={activeView === "preferred" ? "page" : undefined}
            className={activeView === "preferred" ? "active" : ""}
            type="button"
            onClick={() => selectView("preferred")}
          >
            今日简报
          </button>
          {categories.map((category) => (
            <button
              aria-current={activeView === category.id ? "page" : undefined}
              className={activeView === category.id ? "active" : ""}
              key={category.id}
              type="button"
              onClick={() => selectView(category.id)}
            >
              {category.label}
            </button>
          ))}
        </nav>
      </header>

      <section className="workspace">
        <header className="page-intro">
          <div>
            <h1>{viewTitle(activeView)}</h1>
            <p>{viewDescription(activeView)}</p>
          </div>
          <div className="update-status">
            <Clock3 size={15} strokeWidth={1.8} />
            <span>{lastLoadedAt ? `更新于${formatRelativeTime(lastLoadedAt)}` : "正在读取最新报告"}</span>
          </div>
        </header>

        {loadError ? <div className="page-note" role="status">{loadError}</div> : null}

        {activeView === "settings" ? (
          <PreferencesPanel preferences={preferences} setPreferences={setPreferences} />
        ) : loadState === "loading" && !loadedReport ? (
          <NewsSkeleton />
        ) : (
          activeView === "preferred" ? (
            <BriefingHome onClearSearch={() => setSearchQuery("")} preferences={preferences} query={searchQuery} report={report} />
          ) : (
            <>
              <section className="story-section category-story-section" aria-label={`${categoryLabel(activeView)}事件`}>
                <div className="section-heading">
                  <h2>全部事件</h2>
                  <p>{categoryStories.length} 个达到质量门槛的事件</p>
                </div>
                {pageStories.length === 0 ? (
                  <EmptyState
                    action={searchQuery ? "清除搜索" : undefined}
                    message={searchQuery ? "没有事件匹配当前搜索条件。" : "该栏目暂时没有达到质量门槛的事件。"}
                    onAction={searchQuery ? () => setSearchQuery("") : undefined}
                    title={searchQuery ? "没有搜索结果" : "暂无合格事件"}
                  />
                ) : (
                  <div className="story-list">
                    {pageStories.map((story) => <EventCard key={story.id} story={story} variant="compact" />)}
                  </div>
                )}
              </section>

              {canShowMore ? (
                <button className="show-more" type="button" onClick={() => setVisibleCount((current) => current + visibleStep)}>
                  再看 {Math.min(visibleStep, categoryStories.length - pageStories.length)} 个事件
                </button>
              ) : null}
            </>
          )
        )}
      </section>
    </main>
  );
}

function BriefingHome({
  report,
  preferences,
  query,
  onClearSearch,
}: {
  report: DailyNewsReport;
  preferences: UserPreferences;
  query: string;
  onClearSearch: () => void;
}) {
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
  const leadStory = topStories[0];
  const supportingStories = topStories.slice(1);

  return (
    <div className="briefing-home">
      <section className="briefing-summary" aria-label="日报质量概览">
        <dl>
          <div>
            <dt>本期事件</dt>
            <dd>{report.quality.eventCount}</dd>
          </div>
          <div>
            <dt>覆盖栏目</dt>
            <dd>{report.coverage.coveredBeatCount}/{report.coverage.totalBeatCount}</dd>
          </div>
          <div>
            <dt>独立来源</dt>
            <dd>{report.sourceCount}</dd>
          </div>
        </dl>
        <p>事件已去重，未确认线索不会进入核心简报。</p>
      </section>

      {visibleStoryCount === 0 ? (
        <EmptyState
          action={query ? "清除搜索" : undefined}
          message={query ? "试试更短的关键词，或清除搜索查看完整简报。" : "当前报告没有达到展示门槛的事件。"}
          onAction={query ? onClearSearch : undefined}
          title={query ? "没有搜索结果" : "暂无合格事件"}
        />
      ) : null}

      {topStories.length > 0 ? (
        <section className="story-section must-know-section" aria-labelledby="must-know-title">
          <div className="section-heading">
            <h2 id="must-know-title">今日必知</h2>
            <p>{topStories.length} 个高影响事件</p>
          </div>
          <div className={`must-know-layout ${supportingStories.length === 0 ? "single" : ""}`}>
            {leadStory ? <EventCard story={leadStory} variant="lead" /> : null}
            {supportingStories.length > 0 ? (
              <ol className="briefing-list" start={2}>
                {supportingStories.map((story, index) => (
                  <li key={story.id}>
                    <span className="story-rank">{index + 2}</span>
                    <EventCard story={story} variant="brief" />
                  </li>
                ))}
              </ol>
            ) : null}
          </div>
        </section>
      ) : null}

      {importantStories.length > 0 ? (
        <section className="story-section" aria-labelledby="important-title">
          <div className="section-heading">
            <h2 id="important-title">重要进展</h2>
            <p>按照你的偏好调整顺序</p>
          </div>
          <div className="story-list">
            {importantStories.map((story) => <EventCard key={story.id} story={story} variant="compact" />)}
          </div>
        </section>
      ) : null}

      {watchlist.length > 0 ? (
        <section className="story-section watch-section" aria-labelledby="watch-title">
          <div className="section-heading">
            <h2 id="watch-title">持续关注</h2>
            <p>事实仍在变化</p>
          </div>
          <div className="story-list">
            {watchlist.map((story) => <EventCard key={story.id} story={story} variant="watch" />)}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function EventCard({ story, variant }: { story: StoryCard; variant: EventVariant }) {
  const primaryEvidence = story.evidence[0];
  const facts = story.keyFacts.filter((fact) => normalizeText(fact) !== normalizeText(story.whatHappened)).slice(0, 2);
  const hasDetails = facts.length > 0 || Boolean(story.nextWatch);

  return (
    <article className={`event-card ${variant}`}>
      <div className="event-meta">
        <span className={`event-status ${story.status}`}>{storyStatusLabel(story.status)}</span>
        <span>{categoryLabel(story.primaryBeat)}</span>
        <span>{formatStoryAge(story)}</span>
      </div>
      <h3>
        <a href={primaryEvidence?.url} rel="noreferrer" target="_blank">{story.title}</a>
      </h3>
      <p className="event-summary">{story.whatHappened}</p>
      <div className="event-explanation">
        <strong>为什么重要</strong>
        <span>{story.whyItMatters}</span>
      </div>
      {hasDetails ? (
        <details className="event-details">
          <summary>查看详情</summary>
          {facts.length > 0 ? <ul className="fact-list">{facts.map((fact) => <li key={fact}>{fact}</li>)}</ul> : null}
          {story.nextWatch ? <p><strong>后续关注：</strong>{story.nextWatch}</p> : null}
        </details>
      ) : null}
      <footer>
        <span>{story.evidence.length} 个来源：{story.sourceNames.map(sourceLabel).join(" / ")}</span>
        {primaryEvidence ? <a href={primaryEvidence.url} rel="noreferrer" target="_blank">查看原文</a> : null}
      </footer>
    </article>
  );
}

function NewsSkeleton() {
  return (
    <section className="loading-state" aria-label="正在加载新闻" aria-live="polite">
      <div className="skeleton-summary" />
      <div className="skeleton-heading" />
      {[0, 1, 2].map((item) => (
        <div className="skeleton-story" key={item}>
          <span />
          <strong />
          <p />
        </div>
      ))}
    </section>
  );
}

function EmptyState({
  title,
  message,
  action,
  onAction,
}: {
  title: string;
  message: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <div className="empty-state" role="status">
      <h2>{title}</h2>
      <p>{message}</p>
      {action && onAction ? <button type="button" onClick={onAction}>{action}</button> : null}
    </div>
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

function viewDescription(view: ActiveView): string {
  if (view === "preferred") return "先读高影响事件，再浏览重要进展与持续关注。";
  if (view === "settings") return "偏好只影响重要进展和分类页的顺序。";
  return `查看${categoryLabel(view)}栏目中达到质量门槛的事件。`;
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
