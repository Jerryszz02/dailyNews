import { SITE, withSubject } from "@aihot/industry/site";
import { useEffect, useRef, useState } from "react";
import { Link, useLoaderData, useNavigation, useSearchParams } from "react-router";
import type { Route } from "./+types/all";
import type { PoolResponse } from "@aihot/contracts/site";
import { CATEGORY_KEYS, CATEGORY_LABELS, isCategoryKey, isChannelKey } from "@aihot/contracts/taxonomy";
import { loadOr404, queryString } from "../lib/api.server";
import { listPath, pageMeta } from "../lib/seo";
import { CategoryTabs, SearchField } from "../features/feed/Filters";
import { PillTabs } from "../components/ui/Tabs";
import { DayList, Pagination } from "../features/feed/DayList";
import { EmptyState } from "../components/ui/Page";
import { RingMark } from "../components/Logo";
import { commitPersonalPreferences, DEFAULT_PREFERENCES, normalizePreferences, personalOrder, readPersonalPreferences, type PersonalPreferences } from "../lib/personal-preferences";

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const channelParam = url.searchParams.get("channel") ?? "all";
  const categoryParam = url.searchParams.get("category");
  const channel = isChannelKey(channelParam) ? channelParam : "all";
  const category = categoryParam && isCategoryKey(categoryParam) ? categoryParam : null;
  const tag = url.searchParams.get("tag")?.trim() || null;
  const q = url.searchParams.get("q")?.trim().slice(0, 200) || null;
  const tab = url.searchParams.get("tab") === "relevance" ? "relevance" : null;
  // Legacy deep-paging parameters (deep, anchorAt) still open a normal page.
  const page = Math.min(Math.max(Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1, 1), 50);
  const data = await loadOr404<PoolResponse>(
    `/api/site/pool${queryString({ channel: channel === "all" ? null : channel, category, tag, q, tab, page: page > 1 ? page : null })}`,
    { signal: request.signal, busyRedirect: "/all/search-busy" },
  );
  return { data, personal: url.searchParams.get("personal") === "1" };
}

export function meta({ loaderData }: Route.MetaArgs) {
  const f = loaderData?.data.filters;
  const q = f?.q;
  const page = loaderData?.data.page ?? 1;
  return pageMeta({
    title: q ? `搜索：${q}` : `全部${withSubject("动态")}`,
    description: `${SITE.name} 收录的全部${withSubject("动态")}，可按类别与标签筛选，支持中英文搜索。`,
    path: listPath("/all", { channel: f && f.channel !== "all" ? f.channel : null, category: f?.category, tag: f?.tag, q, tab: f?.tab === "relevance" ? "relevance" : null, page: page > 1 ? page : null }),
    noindex: !!q || !!loaderData?.personal,
  });
}

export function headers() {
  return { "Cache-Control": "public, max-age=0, s-maxage=60, stale-while-revalidate=30" };
}

function pageHref(params: URLSearchParams, page: number) {
  const sp = new URLSearchParams(params);
  sp.delete("deep");
  sp.delete("anchorAt");
  sp.delete("search");
  if (page <= 1) sp.delete("page");
  else sp.set("page", String(page));
  const s = sp.toString();
  return s ? `/all?${s}` : "/all";
}

function viewHref(params: URLSearchParams, personal: boolean) {
  const sp = new URLSearchParams(params);
  sp.delete("page");
  if (personal) sp.set("personal", "1");
  else sp.delete("personal");
  return sp.size ? `/all?${sp}` : "/all";
}

function words(text: string) {
  return text.split(/[,，\n]/).map((word) => word.trim()).filter(Boolean);
}

export default function AllPage() {
  const { data, personal } = useLoaderData<typeof loader>();
  const [params] = useSearchParams();
  const navigation = useNavigation();
  const [mounted, setMounted] = useState(false);
  const [preferences, setPreferences] = useState<PersonalPreferences>(DEFAULT_PREFERENCES);
  const preferencesRef = useRef(preferences);
  const [blockedDraft, setBlockedDraft] = useState("");
  const [boostedDraft, setBoostedDraft] = useState("");
  useEffect(() => {
    let loaded: PersonalPreferences;
    try { loaded = readPersonalPreferences(window.localStorage); } catch { loaded = normalizePreferences(null); }
    preferencesRef.current = loaded;
    setPreferences(loaded);
    setBlockedDraft(loaded.blockedKeywords.join("，"));
    setBoostedDraft(loaded.boostedKeywords.join("，"));
    setMounted(true);
  }, []);
  const changePreferences = (update: (value: PersonalPreferences) => PersonalPreferences) => {
    let storage: Storage | null = null;
    try { storage = window.localStorage; } catch { /* storage disabled */ }
    setPreferences(commitPersonalPreferences(preferencesRef, update, storage));
  };
  const shownItems = personal ? mounted ? personalOrder(data.items, preferences) : [] : data.items;
  const f = data.filters;
  const busy = navigation.state === "loading" && navigation.location?.pathname === "/all";
  const keep = { channel: f.channel === "all" ? null : f.channel, category: f.category, personal: personal ? "1" : null };
  const searchTabHref = (tab: "time" | "relevance") => {
    const sp = new URLSearchParams(params);
    sp.delete("page");
    if (tab === "relevance") sp.set("tab", "relevance");
    else sp.delete("tab");
    return `/all?${sp}`;
  };
  const title = f.q ? `搜索“${f.q}”` : f.tag ? `#${f.tag}` : null;
  const updated = new Date(data.freshness).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Shanghai" });

  return (
    <div className="pb-6">
      {/* Desktop, as on 精选: the title, then one filter row with the search field aligned on the right. */}
      <div className="hidden lg:block">
        <h1 className="text-[24px] font-semibold leading-[1.3] text-ink">{title ?? `全部${withSubject("动态")}`}</h1>
        <div className="mb-5 mt-4 flex items-center justify-between gap-4">
          <CategoryTabs base="/all" category={f.category} channel={f.channel} layoutId="all-cat-desk" className="min-w-0" />
          <SearchField variant="track" defaultValue={f.q ?? ""} keep={keep} />
        </div>
      </div>

      {/* Phones: title with today's count, the search bar, then the same filter row as 精选. */}
      <div className="lg:hidden">
        <div className="flex items-baseline justify-between pb-3 pt-5">
          <h1 className="text-[22px] font-bold text-ink">{title ?? "全部动态"}</h1>
          {!f.q && !personal && (
            <span className="text-[12.5px] text-ink-4">
              今日 <span className="num">{data.todayCount}</span> 条
            </span>
          )}
        </div>
        <SearchField variant="bar" defaultValue={f.q ?? ""} keep={keep} autoFocus={params.get("search") === "1"} />
        <div className="-mx-4 mt-3 border-b border-line-soft px-4 pb-3">
          <CategoryTabs base="/all" category={f.category} channel={f.channel} layoutId="all-cat-mobile" size="sm" className="min-w-0" />
        </div>
      </div>

      <div className="mb-3 mt-3 flex flex-wrap items-center gap-3 text-[12.5px]">
        <PillTabs size="xs" layoutId="all-personal" label="阅读方式" active={personal ? "personal" : "public"}
          items={[{ key: "public", label: "公开顺序", to: viewHref(params, false) }, { key: "personal", label: "我的偏好", to: viewHref(params, true) }]} />
        {personal && <span className="text-ink-4">只调整本页公开条目的阅读顺序；筛出偏好分类，屏蔽词仅降权。</span>}
      </div>
      {personal && mounted && (
        <section aria-label="本机偏好" className="mb-4 rounded-tile border border-line bg-surface px-4 py-3 text-[12.5px] text-ink-3">
          <p className="mb-2">偏好只保存在本机，不影响公共精选、全部动态和热点。</p>
          <div className="flex flex-wrap gap-1.5">
            {CATEGORY_KEYS.map((key) => {
              const on = preferences.topicWeights[key] === "preferred";
              return <button key={key} type="button" aria-pressed={on} onClick={() => changePreferences((current) => ({ ...current,
                topicWeights: { ...current.topicWeights, [key]: current.topicWeights[key] === "preferred" ? "not-preferred" : "preferred" } }))}
                className={`rounded-full border px-2.5 py-1 ${on ? "border-accent bg-accent-soft text-accent" : "border-line text-ink-4"}`}>{CATEGORY_LABELS[key]}</button>;
            })}
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <label>降权关键词（逗号分隔）<input className="mt-1 w-full rounded-control border border-line bg-surface px-2 py-1.5 text-ink" value={blockedDraft}
              onChange={(e) => setBlockedDraft(e.target.value)} onBlur={() => changePreferences((current) => ({ ...current, blockedKeywords: words(blockedDraft) }))} /></label>
            <label>优先关键词（逗号分隔）<input className="mt-1 w-full rounded-control border border-line bg-surface px-2 py-1.5 text-ink" value={boostedDraft}
              onChange={(e) => setBoostedDraft(e.target.value)} onBlur={() => changePreferences((current) => ({ ...current, boostedKeywords: words(boostedDraft) }))} /></label>
          </div>
        </section>
      )}

      {f.q && (
        <div className="mb-3 mt-3 flex flex-wrap items-center justify-between gap-2 lg:mt-0">
          <PillTabs
            size="xs"
            layoutId="all-search-sort"
            label="搜索排序"
            active={f.tab}
            items={(["time", "relevance"] as const).map((t) => ({ key: t, label: t === "time" ? "最新（标题与摘要）" : "全文相关", to: searchTabHref(t) }))}
          />
          <span className="text-[12px] text-ink-4">
            找到 <span className="num">{data.total >= 2000 ? "2000+" : data.total}</span> 条 · 更新于 <span className="num">{updated}</span>
          </span>
        </div>
      )}

      <div className={`transition-opacity duration-200 ${busy ? "opacity-50" : ""}`}>
        {personal && !mounted ? null : shownItems.length === 0 ? (
          <div className="mt-2 lg:card">
            <EmptyState
              title="没有找到相关内容"
              action={
                f.q && f.tab === "time" ? (
                  <Link to={searchTabHref("relevance")} className="text-[13px] font-medium text-accent hover:underline">
                    试试“全文相关”，连正文一起搜
                  </Link>
                ) : undefined
              }
            >
              {personal ? "本页没有偏好分类的条目，可调整上方分类或翻到下一页。" : f.q ? "换个说法，或者去掉筛选再试。" : "这个筛选下暂时没有内容。"}
            </EmptyState>
          </div>
        ) : (
          <DayList items={shownItems} todayCount={f.q || personal ? null : data.todayCount} showTags />
        )}
      </div>
      <Pagination page={data.page} pageCount={data.pageCount} href={(p) => pageHref(params, p)} />
      {data.page >= 50 && <p className="mt-4 text-center text-[12px] text-ink-4">最多提供 50 页，更早的内容请使用搜索或主题页。</p>}
    </div>
  );
}

export function SearchBusy() {
  return (
    <div className="mx-auto max-w-sm py-24 text-center">
      <RingMark className="mx-auto mb-5 size-10 text-accent" spinning />
      <h1 className="text-[20px] font-bold text-ink">搜索有点忙</h1>
      <p className="mt-2 text-[14px] leading-relaxed text-ink-3">现在搜索的人比较多，请稍等几秒再试。列表浏览不受影响。</p>
      <div className="mt-6 flex justify-center gap-2.5">
        <Link to="/all" className="inline-flex h-9 items-center rounded-full bg-accent px-4 text-[13.5px] font-medium text-accent-contrast hover:bg-accent-ink">浏览全部动态</Link>
        <Link to="/" className="inline-flex h-9 items-center rounded-full border border-line-strong bg-surface px-4 text-[13.5px] text-ink-2 hover:border-ink-4">回到精选</Link>
      </div>
    </div>
  );
}
