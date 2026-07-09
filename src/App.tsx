import {
  CalendarDays,
  Clock3,
  Flame,
  Newspaper,
  RefreshCw,
  Search,
  Settings2,
  Star,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type React from "react";
import { defaultPreferences } from "./config/preferences";
import { newsSources } from "./config/sources";
import { firecrawlSnapshotNews } from "./data/firecrawlSnapshot";
import { buildDailyReport } from "./lib/newsPipeline";
import { selectPreferredCategoryItems, sortByHotScoreWithoutPreferences, sortByNewest } from "./lib/newsOrdering";
import { normalizeText } from "./lib/text";
import type { Category, DailyNewsReport, PreferenceStrength, RankedNewsItem, RawNewsItem, UserPreferences } from "./types";

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
  const [rawItems, setRawItems] = useState<RawNewsItem[]>([]);
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
      setRawItems(apiReport.items);
      setLastLoadedAt(new Date().toISOString());
      setLoadError("");
      setLoadState("ready");
      return;
    }

    const staticReport = await readReport("/daily-news.json");
    if (staticReport) {
      setRawItems(staticReport.items);
      setLastLoadedAt(new Date().toISOString());
      setLoadError("实时接口暂不可用，当前显示静态兜底数据。");
      setLoadState("ready");
      return;
    }

    const report = buildDailyReport(firecrawlSnapshotNews, defaultPreferences);
    setRawItems(report.items);
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

  const report = useMemo(() => buildDailyReport(rawItems, preferences), [rawItems, preferences]);
  const visibleItems = useMemo(() => {
    if (activeView === "settings") {
      return [];
    }

    const baseItems =
      activeView === "preferred"
        ? selectPreferredCategoryItems(report.items, preferences)
        : sortByNewest(report.items.filter((item) => item.primaryCategory === activeView));

    return filterBySearch(baseItems, searchQuery);
  }, [activeView, preferences, report.items, searchQuery]);
  const pageItems = visibleItems.slice(0, visibleCount);
  const groupedItems = useMemo(() => groupByDay(pageItems), [pageItems]);
  const hotItems = sortByHotScoreWithoutPreferences(report.items).slice(0, 5);
  const canShowMore = visibleItems.length > pageItems.length;

  return (
    <main className="app-shell">
      <aside className="sidebar" aria-label="主导航">
        <div className="brand">
          <span>AI</span>
          <strong>NEWS</strong>
        </div>
        <nav className="sidebar-nav">
          <NavButton active={activeView === "preferred"} icon={<Zap size={16} />} label="偏好新闻" onClick={() => setActiveView("preferred")} />
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
            <p className="eyebrow">{activeView === "preferred" ? "你的偏好" : activeView === "settings" ? "配置中心" : "分类动态"}</p>
            <h1>{viewTitle(activeView)}</h1>
            <p className="hero-subtitle">多来源抓取 · 时间排序 · 每分钟检查更新</p>
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
                  全部偏好
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
                  placeholder="搜索标题、摘要、来源..."
                  type="search"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                />
              </label>
            </section>

            <section className="hot-panel" aria-label="当前热点">
              <div className="panel-title">
                <Flame size={18} />
                <h2>当前热点</h2>
                <span>公共重要性 · 时效 · 来源综合排序</span>
              </div>
              <ol className="hot-list">
                {hotItems.map((item) => (
                  <li key={item.id}>
                    <a href={item.url} rel="noreferrer" target="_blank">
                      {item.title}
                    </a>
                    <span>
                      {formatSourceSummary(item.sourceNames)} · {trustLabel(item.trust?.level ?? "medium")} · {formatNewsAge(item)}
                    </span>
                  </li>
                ))}
              </ol>
            </section>

            {loadError ? <div className="page-note">{loadError}</div> : null}

            <section className="timeline" aria-label="新闻列表">
              {pageItems.length === 0 ? (
                <div className="empty-state">{loadState === "loading" ? "正在加载新闻..." : "没有匹配当前筛选的新闻。"}</div>
              ) : null}
              {groupedItems.map((group) => (
                <div className="day-group" key={group.day}>
                  <div className="day-label">{group.day}</div>
                  <div className="timeline-items">
                    {group.items.map((item) => (
                      <NewsCard item={item} key={item.id} />
                    ))}
                  </div>
                </div>
              ))}
            </section>

            {canShowMore ? (
              <button className="show-more" type="button" onClick={() => setVisibleCount((current) => current + visibleStep)}>
                展开更多 {Math.min(visibleStep, visibleItems.length - pageItems.length)} 条
              </button>
            ) : null}
          </>
        )}
      </section>
    </main>
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

function NewsCard({ item }: { item: RankedNewsItem }) {
  const hasPublishedAt = Boolean(item.publishedAt);

  return (
    <article className="news-card">
      <div className={`time-cell${hasPublishedAt ? "" : " unknown"}`}>{formatNewsTime(item)}</div>
      <div className="news-body">
        <div className="news-meta">
          <span>{item.sourceNames.map(sourceLabel).join(" / ")}</span>
          <strong>{item.score_breakdown.final_score}</strong>
          <span className={`trust-pill ${item.trust?.level ?? "medium"}`}>{trustLabel(item.trust?.level ?? "medium")}</span>
        </div>
        <h2>
          <a href={item.url} rel="noreferrer" target="_blank">
            {item.title}
          </a>
        </h2>
        <p>{item.summary}</p>
        <div className="tags">
          <span className="primary">{categoryLabel(item.primaryCategory)}</span>
          {item.categories.map((category) => (
            category === item.primaryCategory ? null : <span key={category}>{categoryLabel(category)}</span>
          ))}
        </div>
        <div className="trust-reason">{(item.trust?.reasons ?? []).join("，")}</div>
        <div className="reason">{item.score_breakdown.ranking_reason}</div>
      </div>
    </article>
  );
}

async function readReport(url: string): Promise<DailyNewsReport | null> {
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) return null;
    const report = (await response.json()) as Partial<DailyNewsReport>;
    return Array.isArray(report.items) && report.items.length > 0 && typeof report.generatedAt === "string"
      ? (report as DailyNewsReport)
      : null;
  } catch {
    return null;
  }
}

function filterBySearch(items: RankedNewsItem[], query: string): RankedNewsItem[] {
  const normalized = normalizeText(query);
  if (!normalized) return items;
  return items.filter((item) =>
    normalizeText(
      `${item.title} ${item.summary} ${item.sourceNames.join(" ")} ${item.primaryCategory} ${item.categories.join(" ")} ${trustLabel(item.trust?.level ?? "medium")}`,
    ).includes(normalized),
  );
}

function groupByDay(items: RankedNewsItem[]): { day: string; items: RankedNewsItem[] }[] {
  const groups = new Map<string, RankedNewsItem[]>();
  for (const item of items) {
    const day = formatDayShort(item.publishedAt ?? item.extractedAt);
    groups.set(day, [...(groups.get(day) ?? []), item]);
  }
  return Array.from(groups, ([day, groupItems]) => ({ day, items: groupItems }));
}

function viewTitle(view: ActiveView): string {
  if (view === "preferred") return "偏好新闻";
  if (view === "settings") return "偏好设置";
  return `${categoryLabel(view)}动态`;
}

function categoryLabel(category: Category): string {
  return categories.find((item) => item.id === category)?.label ?? category;
}

function sourceLabel(sourceName: string): string {
  const sourceLabels: Record<string, string> = {
    "Associated Press": "美联社",
    BBC: "英国广播公司",
    Bloomberg: "彭博社",
    CNBC: "美国消费者新闻与商业频道",
    Reuters: "路透社",
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

function formatSourceSummary(sourceNames: string[]): string {
  const labels = sourceNames.map(sourceLabel);
  if (labels.length <= 1) return labels[0] ?? "来源待确认";
  return `${labels.length} 个聚合信源`;
}

function trustLabel(level: RankedNewsItem["trust"]["level"]): string {
  if (level === "high") return "高可信";
  if (level === "medium") return "中可信";
  return "低可信";
}

function formatDay(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date(value));
}

function formatDayShort(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
  }).format(new Date(value));
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatNewsTime(item: RankedNewsItem): string {
  return item.publishedAt ? formatTime(item.publishedAt) : "待确认";
}

function formatNewsAge(item: RankedNewsItem): string {
  return item.publishedAt ? formatRelativeTime(item.publishedAt) : "发布时间待确认";
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
