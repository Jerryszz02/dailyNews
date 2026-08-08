import {
  CircleAlert,
  Eye,
  Newspaper,
  RefreshCw,
  Search,
  Settings2,
  Star,
  Target,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { defaultPreferences } from "./config/preferences";
import { newsSources } from "./config/sources";
import { firecrawlSnapshotNews } from "./data/firecrawlSnapshot";
import { buildDailyReport } from "./lib/newsPipeline";
import { orderStoriesByActivity, storyActivityTimestamp } from "./lib/curation";
import { rankNews } from "./lib/scoring";
import { normalizeText } from "./lib/text";
import { hydrateWebDailyNewsReport, isWebDailyNewsReport } from "./lib/webReport";
import type {
  Category,
  DailyNewsReport,
  PreferenceStrength,
  RawNewsItem,
  ReportRefreshMetadata,
  ReportRefreshStatus,
  StoryCard,
  UserPreferences,
} from "./types";

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
const initialLatestVisibleCount = 20;
const latestVisibleStep = 20;
const preferencesStorageKey = "daily-news-preferences";
const refreshIntervalMs = 30_000;
const reportRequestTimeoutMs = 8_000;
const defaultStaleAfterMinutes = 30;
const snapshotFallbackReport = buildDailyReport(
  firecrawlSnapshotNews,
  defaultPreferences,
  snapshotReferenceDate(firecrawlSnapshotNews),
);

export interface ReportFreshnessView {
  status: ReportRefreshStatus;
  reportGeneratedAt: string | null;
  lastPublishedAt: string | null;
  newestContentAt: string | null;
  lastCheckedAt: string | null;
  pageCheckedAt: string | null;
  staleAfterMinutes: number;
  newestContentWasInferred: boolean;
  lastCheckedWasInferred: boolean;
  statusWasInferred: boolean;
  servingMode: NonNullable<ReportRefreshMetadata["servingMode"]>;
  pipelineStatus: NonNullable<ReportRefreshMetadata["pipelineStatus"]>;
  contentStatus: NonNullable<ReportRefreshMetadata["contentStatus"]>;
  coverageStatus: NonNullable<ReportRefreshMetadata["coverageStatus"]>;
}

export function App() {
  const [loadedReport, setLoadedReport] = useState<DailyNewsReport | null>(null);
  const [serviceRefresh, setServiceRefresh] = useState<ReportRefreshMetadata | null>(null);
  const [preferences, setPreferences] = useState<UserPreferences>(() => loadStoredPreferences());
  const [activeView, setActiveView] = useState<ActiveView>("preferred");
  const [searchQuery, setSearchQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(initialVisibleCount);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [pageCheckedAt, setPageCheckedAt] = useState<string | null>(null);
  const [loadError, setLoadError] = useState("");
  const refreshInFlight = useRef(false);
  const loadedReportRef = useRef<DailyNewsReport | null>(null);

  const refreshNews = useCallback(async (bypassCache = false) => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    setLoadState("loading");

    try {
      const apiReport = await readReport(reportApiUrl(Date.now(), bypassCache));
      if (apiReport) {
        setServiceRefresh(apiReport.refresh ?? null);
        if (shouldReplaceReport(loadedReportRef.current, apiReport)) {
          loadedReportRef.current = apiReport;
          setLoadedReport(apiReport);
        }
        setPageCheckedAt(new Date().toISOString());
        setLoadError("");
        setLoadState("ready");
        return;
      }

      if (loadedReportRef.current) {
        setServiceRefresh((current) => ({
          ...current,
          servingMode: "browser-cache",
          pipelineStatus: "degraded",
          lastError: "public_api_unavailable",
        }));
        setPageCheckedAt(new Date().toISOString());
        setLoadError("实时接口暂不可用，继续显示最近成功读取的报告。");
        setLoadState("error");
        return;
      }

      const staticReport = await readReport("/daily-news.json");
      if (staticReport) {
        loadedReportRef.current = staticReport;
        setLoadedReport(staticReport);
        setServiceRefresh({
          ...staticReport.refresh,
          servingMode: "bundled",
          pipelineStatus: "degraded",
          contentStatus: staticReport.refresh?.contentStatus ?? "stale",
          lastError: "public_api_unavailable",
        });
        setPageCheckedAt(new Date().toISOString());
        setLoadError("实时接口暂不可用，当前显示静态兜底数据。");
        setLoadState("ready");
        return;
      }

      loadedReportRef.current = snapshotFallbackReport;
      setLoadedReport(snapshotFallbackReport);
      setServiceRefresh({
        ...snapshotFallbackReport.refresh,
        servingMode: "bundled",
        pipelineStatus: "failed",
        contentStatus: "stale",
        lastError: "public_api_unavailable",
      });
      setPageCheckedAt(new Date().toISOString());
      setLoadError("实时接口和静态新闻都暂不可用，当前显示本地兜底数据。");
      setLoadState("error");
    } finally {
      refreshInFlight.current = false;
    }
  }, []);

  useEffect(() => {
    void refreshNews();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible" && navigator.onLine) void refreshNews();
    }, refreshIntervalMs);
    const refreshWhenAvailable = () => {
      if (document.visibilityState === "visible" && navigator.onLine) void refreshNews();
    };
    document.addEventListener("visibilitychange", refreshWhenAvailable);
    window.addEventListener("online", refreshWhenAvailable);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshWhenAvailable);
      window.removeEventListener("online", refreshWhenAvailable);
    };
  }, [refreshNews]);

  useEffect(() => {
    localStorage.setItem(preferencesStorageKey, JSON.stringify(preferences));
  }, [preferences]);

  useEffect(() => {
    setVisibleCount(initialVisibleCount);
  }, [activeView, searchQuery, preferences]);

  const fallbackReport = snapshotFallbackReport;
  const report = loadedReport ?? fallbackReport;
  const freshness = resolveReportFreshness(report, pageCheckedAt, Date.now(), serviceRefresh);
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
            <dl className="freshness-grid">
              <FreshnessTime label="报告发布" value={freshness.lastPublishedAt} />
              <FreshnessTime label="最新新闻" value={freshness.newestContentAt} wasInferred={freshness.newestContentWasInferred} />
              <FreshnessTime label="最近检查" value={freshness.lastCheckedAt} wasInferred={freshness.lastCheckedWasInferred} />
              <FreshnessTime label="页面检查" value={freshness.pageCheckedAt} />
            </dl>
            <div className="status-semantics" aria-label="新闻服务状态">
              <span>服务：{pipelineStatusLabel(freshness.pipelineStatus)}</span>
              <span>采集：{coverageStatusLabel(freshness.coverageStatus)}</span>
              <span>内容：{contentStatusLabel(freshness.contentStatus)}</span>
            </div>
            <button
              className="reload-button"
              disabled={loadState === "loading"}
              onClick={() => void refreshNews(true)}
              title="只重新读取已生成的报告，不会从浏览器触发新闻采集"
              type="button"
            >
              <RefreshCw className={loadState === "loading" ? "spin" : ""} size={17} />
              <span>{loadState === "loading" ? "正在加载报告" : "重新加载报告"}</span>
            </button>
          </div>
        </header>

        <FreshnessBanner freshness={freshness} />

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
              <BriefingHome query={searchQuery} report={report} />
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

function FreshnessTime({ label, value, wasInferred = false }: { label: string; value: string | null; wasInferred?: boolean }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        {value ? (
          <>
            <time dateTime={value} title={formatFullDateTime(value)}>{formatCompactDateTime(value)}</time>
            <small>
              {formatRelativeTime(value)}
              {wasInferred ? <span className="inferred-badge">旧报告推算</span> : null}
            </small>
          </>
        ) : (
          <>
            <span>时间未知</span>
            <small>缺少时间信息</small>
          </>
        )}
      </dd>
    </div>
  );
}

function FreshnessBanner({ freshness }: { freshness: ReportFreshnessView }) {
  const pipelineDegraded = freshness.pipelineStatus === "degraded" || freshness.pipelineStatus === "failed";
  const unavailable = freshness.status === "unavailable";
  const contentNeedsNotice = freshness.contentStatus === "quiet" || freshness.contentStatus === "stale";
  if (!pipelineDegraded && !unavailable && !contentNeedsNotice) return null;

  const status: ReportRefreshStatus = unavailable ? "unavailable" : pipelineDegraded ? "degraded" : "stale";
  const heading = unavailable
    ? "暂时无法确认报告状态"
    : pipelineDegraded
      ? "更新链路部分降级"
      : freshness.contentStatus === "quiet"
        ? "当前时段暂无新事件"
        : "当前内容较旧";
  const message = unavailable
    ? "目前没有足够的刷新元数据，请稍后重新加载报告。"
    : pipelineDegraded
      ? "页面继续显示最近一份可用报告；部分来源或后台步骤将自动重试。"
      : freshness.contentStatus === "quiet"
        ? "后台检查仍在正常进行，只是当前来源没有发现新的可发布事件。"
        : `内容活动时间已超过 ${freshness.staleAfterMinutes} 分钟，服务仍可用并保留最后一份有效报告。`;

  return (
    <section className={`freshness-banner ${status}`} role="status">
      <CircleAlert aria-hidden="true" size={20} />
      <div>
        <strong>{heading}</strong>
        <p>
          {message}
          {freshness.statusWasInferred ? " 状态由旧报告时间推算。" : ""}
        </p>
      </div>
    </section>
  );
}

function BriefingHome({ report, query }: { report: DailyNewsReport; query: string }) {
  const [latestVisibleCount, setLatestVisibleCount] = useState(initialLatestVisibleCount);
  const latestStories = filterStories(resolveLatestStories(report), query);
  const visibleLatestStories = latestStories.slice(0, latestVisibleCount);
  const topStories = filterStories(report.topStories, query);
  const importantStories = selectBriefingImportantStories(report, query);
  const watchlist = filterStories(report.watchlist, query);
  const visibleStoryCount = latestStories.length + topStories.length + importantStories.length + watchlist.length;

  useEffect(() => {
    setLatestVisibleCount(initialLatestVisibleCount);
  }, [query, report.generatedAt]);

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
        <p>全部有效事件先进入最新流；事实状态和精选层级不会让新闻消失。</p>
      </section>

      {visibleStoryCount === 0 ? <div className="empty-state">没有匹配当前搜索的事件。</div> : null}

      {visibleLatestStories.length > 0 ? (
        <section className="story-section latest-news-section" aria-labelledby="latest-updates-title">
          <div className="story-section-heading">
            <div>
            <p className="eyebrow">按最新证据时间</p>
              <h2 id="latest-updates-title">全部最新</h2>
            </div>
            <span>{latestStories.length} 个最近事件</span>
          </div>
          <div className="story-grid">
            {visibleLatestStories.map((story) => <EventCard anchor={false} key={story.id} story={story} variant="compact" />)}
          </div>
          {latestStories.length > visibleLatestStories.length ? (
            <button className="show-more" type="button" onClick={() => setLatestVisibleCount((current) => current + latestVisibleStep)}>
              展开更多 {Math.min(latestVisibleStep, latestStories.length - visibleLatestStories.length)} 个最新事件
            </button>
          ) : null}
        </section>
      ) : null}

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
            <span>按报告精选顺序展示</span>
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

function EventCard({ story, variant, anchor = true }: { story: StoryCard; variant: "lead" | "compact" | "watch"; anchor?: boolean }) {
  const primaryEvidence = story.evidence[0];
  const facts = story.keyFacts.filter((fact) => normalizeText(fact) !== normalizeText(story.whatHappened)).slice(0, 2);

  return (
    <article className={`event-card ${variant}`} id={anchor ? `story-${story.id}` : undefined}>
      <div className="event-meta">
        <span className={`event-status ${story.status}`}>{storyStatusLabel(story.status)}</span>
        <span>{categoryLabel(story.primaryBeat)}</span>
        <span>{story.evidence.length} 个证据来源</span>
        <span>{formatStoryAge(story)}</span>
        {story.translationStatus === "pending" ? <span className="degraded-badge">待翻译</span> : null}
        {story.summaryStatus === "pending" ? <span className="degraded-badge">摘要待补全</span> : null}
        {story.timeStatus === "estimated" ? <span className="degraded-badge">时间待核验</span> : null}
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
          <span>{newsSources.filter((source) => source.enabled && source.admission === "approved").length} 个启用来源</span>
        </div>
      </div>
    </section>
  );
}

export async function readReport(url: string, timeoutMs = reportRequestTimeoutMs): Promise<DailyNewsReport | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    const report = (await response.json()) as unknown;
    if (isWebDailyNewsReport(report)) return hydrateWebDailyNewsReport(report);
    if (!report || typeof report !== "object") return null;
    const candidate = report as Partial<DailyNewsReport>;
    if (!Array.isArray(candidate.items) || candidate.items.length === 0 || typeof candidate.generatedAt !== "string") return null;
    const generatedAt = Date.parse(candidate.generatedAt);
    if (!Number.isFinite(generatedAt)) return null;
    if (
      candidate.version === 2 &&
      Array.isArray(candidate.stories) &&
      Array.isArray(candidate.topStories) &&
      Array.isArray(candidate.importantStories) &&
      Array.isArray(candidate.watchlist) &&
      Array.isArray(candidate.sections) &&
      candidate.coverage &&
      candidate.quality
    ) {
      const normalized = candidate as DailyNewsReport;
      normalized.latestStories = resolveLatestStories(normalized);
      return normalized;
    }
    const upgradedReport = buildDailyReport(
      candidate.items as RawNewsItem[],
      defaultPreferences,
      new Date(generatedAt),
    );
    upgradedReport.refresh = candidate.refresh;
    return upgradedReport;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export function shouldReplaceReport(current: DailyNewsReport | null, candidate: DailyNewsReport): boolean {
  if (!current) return true;
  if (current.refresh?.servingMode === "durable" && candidate.refresh?.servingMode !== "durable") return false;
  const candidatePublicationStateAt = Date.parse(validTimestamp(candidate.refresh?.publicationStateAt) ?? "");
  const currentPublicationStateAt = Date.parse(validTimestamp(current.refresh?.publicationStateAt) ?? "");
  if (candidate.refresh?.servingMode === "durable" && Number.isFinite(candidatePublicationStateAt)) {
    if (current.refresh?.servingMode !== "durable" || !Number.isFinite(currentPublicationStateAt)) return true;
    if (candidatePublicationStateAt !== currentPublicationStateAt) {
      return candidatePublicationStateAt > currentPublicationStateAt;
    }
  }
  return reportDataTimestamp(candidate) >= reportDataTimestamp(current);
}

function reportDataTimestamp(report: Pick<DailyNewsReport, "generatedAt" | "refresh">): number {
  return Date.parse(validTimestamp(report.refresh?.dataAsOf) ?? report.generatedAt);
}

export function reportApiUrl(_nowMs: number, bypassCache = false): string {
  if (bypassCache) return "/api/news?view=web&reload=1";
  return "/api/news?view=web";
}

export function resolveReportFreshness(
  report: Pick<DailyNewsReport, "generatedAt" | "items" | "refresh">,
  pageCheckedAt: string | null,
  nowMs = Date.now(),
  serviceRefresh: ReportRefreshMetadata | null = null,
): ReportFreshnessView {
  const metadata = { ...report.refresh, ...serviceRefresh };
  const reportGeneratedAt = validTimestamp(report.generatedAt);
  const explicitNewestContentAt = validTimestamp(metadata.newestContentAt);
  const newestContentAt = explicitNewestContentAt ?? newestUpdatedAt(report.items);
  const dataAsOf = validTimestamp(metadata.dataAsOf) ?? reportGeneratedAt;
  const explicitLastCheckedAt =
    validTimestamp(metadata.lastCheckedAt) ??
    validTimestamp(metadata.lastAttemptAt) ??
    validTimestamp(metadata.lastSuccessAt);
  const lastCheckedAt = explicitLastCheckedAt ?? reportGeneratedAt;
  const lastPublishedAt = validTimestamp(metadata.lastPublishedAt) ?? reportGeneratedAt;
  const configuredStaleAfterMinutes = metadata.staleAfterMinutes;
  const staleAfterMinutes =
    typeof configuredStaleAfterMinutes === "number" && Number.isFinite(configuredStaleAfterMinutes) && configuredStaleAfterMinutes > 0
      ? configuredStaleAfterMinutes
      : defaultStaleAfterMinutes;
  const inferredStatus = inferRefreshStatus(dataAsOf, staleAfterMinutes, nowMs);
  const explicitStatus = isReportRefreshStatus(metadata.status) ? metadata.status : null;
  const explicitFreshIsStale = explicitStatus === "fresh" && inferredStatus === "stale";
  const pipelineStatus =
    metadata.pipelineStatus ??
    (explicitStatus === "unavailable"
      ? "failed"
      : explicitStatus === "degraded"
        ? "degraded"
        : "healthy");
  const contentStatus = metadata.contentStatus ?? (inferredStatus === "stale" ? "stale" : "current");
  const status: ReportRefreshStatus =
    explicitStatus === "unavailable"
      ? "unavailable"
      : pipelineStatus === "degraded" || pipelineStatus === "failed"
        ? "degraded"
        : contentStatus === "stale"
          ? "stale"
          : (explicitFreshIsStale ? "stale" : (explicitStatus ?? inferredStatus));

  return {
    status,
    reportGeneratedAt,
    lastPublishedAt,
    newestContentAt,
    lastCheckedAt,
    pageCheckedAt: validTimestamp(pageCheckedAt),
    staleAfterMinutes,
    newestContentWasInferred: !explicitNewestContentAt && Boolean(newestContentAt),
    lastCheckedWasInferred: !explicitLastCheckedAt && Boolean(lastCheckedAt),
    statusWasInferred: !explicitStatus || explicitFreshIsStale,
    servingMode: metadata.servingMode ?? "bundled",
    pipelineStatus,
    contentStatus,
    coverageStatus: metadata.coverageStatus ?? "unavailable",
  };
}

export function resolveLatestStories(
  report: Pick<DailyNewsReport, "generatedAt" | "stories" | "latestStories" | "refresh">,
): StoryCard[] {
  if (Array.isArray(report.latestStories)) return orderStoriesByActivity(report.latestStories);

  const ordered = orderStoriesByActivity(report.stories);
  const referenceAt = Date.parse(validTimestamp(report.refresh?.dataAsOf) ?? report.generatedAt);
  if (!Number.isFinite(referenceAt)) return ordered;
  const within24Hours = ordered.filter((story) => {
    const ageMs = referenceAt - storyActivityTimestamp(story);
    return ageMs >= 0 && ageMs <= 24 * 60 * 60_000;
  });
  if (within24Hours.length > 0) return within24Hours;
  const within72Hours = ordered.filter((story) => {
    const ageMs = referenceAt - storyActivityTimestamp(story);
    return ageMs >= 0 && ageMs <= 72 * 60 * 60_000;
  });
  return within72Hours.length > 0 ? within72Hours : ordered;
}

function newestUpdatedAt(items: DailyNewsReport["items"]): string | null {
  let newest: string | null = null;
  let newestMs = Number.NEGATIVE_INFINITY;

  for (const item of items) {
    const updatedAt = validTimestamp(item.updatedAt);
    if (!updatedAt) continue;
    const updatedAtMs = Date.parse(updatedAt);
    if (updatedAtMs > newestMs) {
      newest = updatedAt;
      newestMs = updatedAtMs;
    }
  }

  return newest;
}

function pipelineStatusLabel(status: NonNullable<ReportRefreshMetadata["pipelineStatus"]>): string {
  return { running: "运行中", healthy: "正常", degraded: "部分降级", failed: "失败" }[status];
}

function coverageStatusLabel(status: NonNullable<ReportRefreshMetadata["coverageStatus"]>): string {
  return { current: "完整", stale: "超时", incomplete: "未完成", unavailable: "未知" }[status];
}

function contentStatusLabel(status: NonNullable<ReportRefreshMetadata["contentStatus"]>): string {
  return { current: "最新", quiet: "平静期", stale: "较旧", unknown: "未知" }[status];
}

function inferRefreshStatus(dataAsOf: string | null, staleAfterMinutes: number, nowMs: number): ReportRefreshStatus {
  if (!dataAsOf) return "unavailable";
  return nowMs - Date.parse(dataAsOf) > staleAfterMinutes * 60_000 ? "stale" : "fresh";
}

function isReportRefreshStatus(value: unknown): value is ReportRefreshStatus {
  return value === "fresh" || value === "stale" || value === "degraded" || value === "unavailable";
}

function validTimestamp(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function snapshotReferenceDate(items: RawNewsItem[]): Date {
  const timestamps = items
    .flatMap((item) => [item.extractedAt, item.publishedAt])
    .map((value) => Date.parse(value ?? ""))
    .filter(Number.isFinite);
  return new Date(timestamps.length > 0 ? Math.max(...timestamps) : 0);
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

export function selectBriefingImportantStories(
  report: Pick<DailyNewsReport, "importantStories">,
  query: string,
): StoryCard[] {
  return filterStories(report.importantStories, query);
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

function formatCompactDateTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}

function formatFullDateTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "long",
    timeStyle: "short",
  }).format(timestamp);
}

export function formatRelativeTime(value: string, nowMs = Date.now()): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "时间未知";
  const ageMs = nowMs - timestamp;
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
