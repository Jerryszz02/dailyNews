import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RawNewsItem } from "../src/types";
import {
  extractArticleSummaryContext,
  extractPublishedDateFromHtml,
  generateDailyNewsReport,
  inferPrimaryCategory,
  inferPublishedDateFromUrl,
  mapWithConcurrency,
  matchesSourceDomain,
  parsePublishedDate,
  prepareNewsTextForDisplay,
  readTranslationConfig,
  readHtmlLinkCandidates,
  runWithinDeadline,
  selectEnglishEventRepresentatives,
  selectChineseEnrichmentUrls,
  sortCandidatesByNewest,
  translateNewsText,
} from "./newsService";

const translationEnvNames = [
  "DAILY_NEWS_TRANSLATION_API_KEY",
  "DAILY_NEWS_TRANSLATION_BASE_URL",
  "DAILY_NEWS_TRANSLATION_MODEL",
] as const;
const maxNewsAgeEnvName = "DAILY_NEWS_MAX_AGE_HOURS";

let originalTranslationEnv: Record<(typeof translationEnvNames)[number], string | undefined>;
let originalMaxNewsAge: string | undefined;

beforeEach(() => {
  originalTranslationEnv = Object.fromEntries(translationEnvNames.map((name) => [name, process.env[name]])) as Record<
    (typeof translationEnvNames)[number],
    string | undefined
  >;
  for (const name of translationEnvNames) {
    delete process.env[name];
  }
  originalMaxNewsAge = process.env[maxNewsAgeEnvName];
  delete process.env[maxNewsAgeEnvName];
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  for (const name of translationEnvNames) {
    const value = originalTranslationEnv[name];
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  if (originalMaxNewsAge === undefined) {
    delete process.env[maxNewsAgeEnvName];
  } else {
    process.env[maxNewsAgeEnvName] = originalMaxNewsAge;
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function htmlResponse(html: string): Response {
  return {
    ok: true,
    status: 200,
    text: async () => html,
  } as Response;
}

function chatResponse(content: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ choices: [{ message: { content } }] }),
  } as Response;
}

describe("generateDailyNewsReport", () => {
  it("uses the checked-in fallback when direct results are all stale", async () => {
    process.env[maxNewsAgeEnvName] = "72";
    const fetchMock = vi.fn().mockResolvedValue(
      htmlResponse('<a href="/2026/07/01/article.html">这是一条用于验证过期新闻降级逻辑的测试标题 2026-07-01</a>'),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await generateDailyNewsReport({
      useFirecrawlKeyless: false,
      maxSources: 1,
      limitPerSection: 1,
      now: new Date("2026-07-10T00:00:00.000Z"),
      repairSummariesWithModel: false,
    });

    expect(fetchMock).toHaveBeenCalled();
    expect(result.usedLiveData).toBe(false);
    expect(result.mode).toBe("Firecrawl snapshot");
    expect(result.rawItemCount).toBeGreaterThan(0);
    expect(result.report.items.length).toBeGreaterThan(0);
  });

  it("returns last-known-good when collection reaches its overall deadline", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    const startedAt = Date.now();

    const result = await generateDailyNewsReport({
      useFirecrawlKeyless: false,
      maxSources: 6,
      limitPerSection: 1,
      collectionBudgetMs: 30,
      repairSummariesWithModel: false,
    });

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(result.usedLiveData).toBe(false);
    expect(result.mode).toBe("Firecrawl snapshot");
    expect(result.report.items.length).toBeGreaterThan(0);
  });
});

describe("matchesSourceDomain", () => {
  it("accepts the configured domain and its subdomains", () => {
    expect(matchesSourceDomain("https://www.news.cn/politics/article.html", "www.news.cn")).toBe(true);
    expect(matchesSourceDomain("https://sports.news.cn/2026/07/10/article.html", "www.news.cn")).toBe(true);
  });

  it("rejects unrelated search results", () => {
    expect(matchesSourceDomain("https://example.com/news/article.html", "www.news.cn")).toBe(false);
  });
});

describe("direct HTML candidates", () => {
  it("sorts dated candidates before stale pinned links consume the section limit", () => {
    const candidates = sortCandidatesByNewest([
      { title: "旧置顶", url: "https://www.mem.gov.cn/xw/yjyw/202607/t20260701_1.shtml" },
      { title: "最新", url: "https://www.mem.gov.cn/xw/bndt/202607/t20260710_2.shtml" },
      { title: "次新", url: "https://www.mem.gov.cn/xw/bndt/202607/t20260709_3.shtml" },
    ]);

    expect(candidates.map((candidate) => candidate.title)).toEqual(["最新", "次新", "旧置顶"]);
  });

  it("accepts article paths that use a YYYYMM directory", () => {
    const candidates = readHtmlLinkCandidates(
      '<a href="./xw/bndt/202607/t20260710_675933.shtml">国家防总办公室部署重点地区防汛防台风工作</a>',
      "https://www.mem.gov.cn/",
    );

    expect(candidates).toHaveLength(1);
  });

  it("keeps article links on a sibling site subdomain and reads a nearby asset date", () => {
    const candidates = readHtmlLinkCandidates(
      `<li>
        <a href="https://content.mtime.com/article/229511820"><img src="https://img5.mtime.cn/mg/2026/07/10/114537.jpg"></a>
        <h4><a href="https://content.mtime.com/article/229511820">后街男孩献唱动画电影主题曲并发布全新预告</a></h4>
      </li>`,
      "https://news.mtime.com/",
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0].publishedAt).toBe("2026-07-09T16:00:00.000Z");
  });
});

describe("mapWithConcurrency", () => {
  it("preserves result order while bounding active work", async () => {
    let active = 0;
    let maxActive = 0;
    const result = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      return value * 2;
    });

    expect(result).toEqual([2, 4, 6, 8, 10]);
    expect(maxActive).toBe(2);
  });
});

describe("runWithinDeadline", () => {
  it("returns completed work before the deadline", async () => {
    await expect(runWithinDeadline(async () => "ok", Date.now() + 1_000)).resolves.toBe("ok");
  });

  it("rejects work after the collection deadline", async () => {
    await expect(runWithinDeadline(async () => "late", Date.now() - 1)).rejects.toThrow("Collection deadline reached");
  });
});

describe("inferPublishedDateFromUrl", () => {
  it("reads emergency ministry tYYYYMMDD article dates", () => {
    expect(inferPublishedDateFromUrl("https://www.mem.gov.cn/xw/bndt/202607/t20260710_675933.shtml")).toBe(
      "2026-07-09T16:00:00.000Z",
    );
  });

  it("reads slash-separated article dates", () => {
    expect(inferPublishedDateFromUrl("https://news.cctv.com/2026/07/09/ARTI5D1UsNbahAJfm69osc6K260709.shtml")).toBe(
      "2026-07-08T16:00:00.000Z",
    );
  });

  it("reads ChinaNews year/month-day URLs as China-local dates", () => {
    expect(inferPublishedDateFromUrl("https://www.chinanews.com.cn/gn/2026/06-29/10649512.shtml")).toBe(
      "2026-06-28T16:00:00.000Z",
    );
  });

  it("reads compact date URLs", () => {
    expect(inferPublishedDateFromUrl("http://finance.people.com.cn/n1/2026/0629/c1004-40749146.html")).toBe(
      "2026-06-28T16:00:00.000Z",
    );
  });

  it("ignores URLs without a reliable date", () => {
    expect(inferPublishedDateFromUrl("https://www.bbc.com/news/articles/cpq3yy48zglo")).toBeUndefined();
  });
});

describe("parsePublishedDate", () => {
  it("normalizes ISO dates with explicit timezones", () => {
    expect(parsePublishedDate("2026-07-09T10:30:00+08:00")).toBe("2026-07-09T02:30:00.000Z");
  });

  it("reads Chinese local publish timestamps", () => {
    expect(parsePublishedDate("发布时间：2026年07月09日 10:30")).toBe("2026-07-09T02:30:00.000Z");
  });

  it("reads timestamps appended to direct link titles", () => {
    expect(parsePublishedDate("考文垂：运动员不该为政府行为承担责任 2026-07-09 09:11:28")).toBe("2026-07-09T01:11:28.000Z");
  });
});

describe("extractPublishedDateFromHtml", () => {
  it("reads article meta publish dates", () => {
    expect(
      extractPublishedDateFromHtml('<html><head><meta property="article:published_time" content="2026-07-09T10:30:00+08:00"></head></html>'),
    ).toBe("2026-07-09T02:30:00.000Z");
  });

  it("reads inline Chinese publish dates", () => {
    expect(extractPublishedDateFromHtml("<main>来源：测试 发布时间：2026年07月09日 10:30 作者：编辑</main>")).toBe(
      "2026-07-09T02:30:00.000Z",
    );
  });

  it("prefers visible clock time over date-only meta values", () => {
    expect(
      extractPublishedDateFromHtml(
        '<meta name="publishdate" content="2026-07-09"><span class="year"><em>2026</em></span><span class="day"><em>07</em>/<em>09</em></span><span class="time">08:03:37</span>',
      ),
    ).toBe("2026-07-09T00:03:37.000Z");
  });

  it("reads compact script publish timestamps", () => {
    expect(extractPublishedDateFromHtml('var publishDate ="20260709093554 ";')).toBe("2026-07-09T01:35:54.000Z");
  });
});

describe("extractArticleSummaryContext", () => {
  it("reads article context from metadata, JSON-LD and paragraphs", () => {
    const context = extractArticleSummaryContext(`
      <meta property="og:description" content="这是一段来自页面 metadata 的新闻摘要，包含足够多的事实信息用于后续概述。">
      <script type="application/ld+json">{"articleBody":"这是一段来自结构化数据的正文内容，说明事件背景、影响范围、相关机构、后续安排以及多方回应。"}</script>
      <article><p>这是一段页面正文段落，继续补充新闻事件的细节、相关机构、时间线、影响范围和后续进展。</p></article>
    `);

    expect(context).toContain("metadata");
    expect(context).toContain("结构化数据");
    expect(context).toContain("页面正文段落");
  });
});

describe("translation helpers", () => {
  it("uses DeepSeek Flash defaults and requests JSON output", async () => {
    process.env.DAILY_NEWS_TRANSLATION_API_KEY = "test-key";
    const config = readTranslationConfig();
    expect(config).toEqual({
      apiKey: "test-key",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
    });

    const fetchMock = vi.fn().mockResolvedValue(chatResponse(JSON.stringify({ title: "中文标题", summary: "这是一段中文全文概述。" })));
    vi.stubGlobal("fetch", fetchMock);

    await translateNewsText({ title: "English title", summary: "English summary", articleContext: "Article context" }, config!);

    expect(fetchMock).toHaveBeenCalledWith("https://api.deepseek.com/chat/completions", expect.any(Object));
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBe("deepseek-v4-flash");
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.max_tokens).toBeGreaterThanOrEqual(600);
    expect(body.messages[0].content).toContain("JSON");
  });

  it("translates non-Chinese news into Chinese display text", async () => {
    const config = { apiKey: "test-key", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash" };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(htmlResponse("<p>The article says the league approved a trade after several days of negotiations.</p>"))
      .mockResolvedValueOnce(chatResponse(JSON.stringify({ title: "联盟批准一笔重要交易", summary: "联盟在多日谈判后批准交易，相关球队阵容和后续赛程将受到影响。" })));
    vi.stubGlobal("fetch", fetchMock);

    const result = await prepareNewsTextForDisplay({
      title: "League approves major trade",
      summary: "League approves major trade",
      url: "https://example.com/news/trade",
      allowTranslation: true,
      repairSummaryWithModel: true,
      translationConfig: config,
    });

    expect(result).toEqual({
      title: "联盟批准一笔重要交易",
      summary: "联盟在多日谈判后批准交易，相关球队阵容和后续赛程将受到影响。",
    });
  });

  it("skips non-Chinese news when translation still returns non-Chinese text", async () => {
    const config = { apiKey: "test-key", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash" };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(htmlResponse("<p>The article includes details about an English-only story.</p>"))
      .mockResolvedValueOnce(chatResponse(JSON.stringify({ title: "English title", summary: "English summary" })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      prepareNewsTextForDisplay({
        title: "English title",
        summary: "English title",
        url: "https://example.com/news/english",
        allowTranslation: true,
        repairSummaryWithModel: true,
        translationConfig: config,
      }),
    ).resolves.toBeNull();
  });

  it("uses a minimal Chinese fallback when duplicate-summary enrichment has no article context", async () => {
    const config = { apiKey: "test-key", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash" };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(htmlResponse("<p>短正文</p>"))
      .mockResolvedValueOnce(chatResponse("{}", 500));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      prepareNewsTextForDisplay({
        title: "中文标题",
        summary: "中文标题",
        url: "https://example.com/news/chinese",
        allowTranslation: false,
        repairSummaryWithModel: true,
        translationConfig: config,
      }),
    ).resolves.toEqual({ title: "中文标题", summary: "“中文标题”已有新的公开信息，详细事实、影响范围和后续进展以来源页面为准。" });
  });

  it("uses article context as fallback when Chinese summary enrichment fails", async () => {
    const config = { apiKey: "test-key", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash" };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(htmlResponse("<p>这是一段中文新闻正文，提供事件背景、关键人物、时间线和后续影响，适合作为页面摘要。</p>"))
      .mockResolvedValueOnce(chatResponse("{}", 500));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      prepareNewsTextForDisplay({
        title: "中文标题",
        summary: "中文标题",
        url: "https://example.com/news/chinese",
        allowTranslation: false,
        repairSummaryWithModel: true,
        translationConfig: config,
      }),
    ).resolves.toEqual({
      title: "中文标题",
      summary: "这是一段中文新闻正文，提供事件背景、关键人物、时间线和后续影响，适合作为页面摘要。",
    });
  });

  it("uses minimal fallback without network calls when model summary repair is disabled", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      prepareNewsTextForDisplay({
        title: "中文标题",
        summary: "中文标题",
        url: "https://example.com/news/chinese",
        allowTranslation: false,
        repairSummaryWithModel: false,
        translationConfig: { apiKey: "test-key", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash" },
      }),
    ).resolves.toEqual({
      title: "中文标题",
      summary: "“中文标题”已有新的公开信息，详细事实、影响范围和后续进展以来源页面为准。",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("pre-translation event selection", () => {
  const englishItem = (id: string, title: string, category: "ai" | "international", publishedAt: string): RawNewsItem => ({
    id,
    title,
    url: `https://example.com/${id}`,
    sourceId: id.startsWith("ap") ? "ap" : "anthropic",
    sourceName: id.startsWith("ap") ? "Associated Press" : "Anthropic",
    language: "en-US",
    region: "global" as const,
    categories: [category],
    primaryCategory: category,
    summary: `${title} ${id}`,
    publishedAt,
    extractedAt: publishedAt,
    mayHavePaywall: false,
  });

  it("deduplicates an English event before choosing translation representatives", () => {
    const representatives = selectEnglishEventRepresentatives([
      englishItem("ap-one", "Global agency announces major policy change", "international", "2026-07-10T10:00:00.000Z"),
      englishItem("ap-two", "Global agency announces major policy change", "international", "2026-07-10T10:05:00.000Z"),
    ]);

    expect(representatives).toHaveLength(1);
  });

  it("keeps the per-round English translation candidate count within the hard cap", () => {
    const topics = [
      "Orchid benchmark released",
      "Falcon dataset expanded",
      "Harbor robotics lab opened",
      "Quartz safety standard approved",
      "Maple research grant awarded",
      "Nimbus compiler introduced",
      "Cobalt chip architecture detailed",
      "Lantern education program launched",
      "Voyager satellite mission confirmed",
      "Meadow climate study published",
      "Atlas medical trial completed",
      "Summit energy project funded",
      "River quantum network demonstrated",
      "Pioneer accessibility toolkit shipped",
      "Beacon language archive digitized",
      "Cedar manufacturing plant announced",
      "Aurora privacy framework adopted",
      "Tundra logistics platform upgraded",
      "Coral conservation model validated",
      "Granite battery prototype tested",
    ];
    const candidates = topics.map((title, index) =>
      englishItem(
        `anthropic-${index}`,
        title,
        "ai",
        `2026-07-10T${String(index).padStart(2, "0")}:00:00.000Z`,
      ),
    );

    expect(selectEnglishEventRepresentatives(candidates)).toHaveLength(15);
  });

  it("selects at most one Chinese article enrichment per category", () => {
    const chinese = (id: string, category: "society" | "entertainment", hour: number): RawNewsItem => ({
      id,
      title: `${category} 中文标题 ${id}`,
      url: `https://example.com/${id}`,
      sourceId: category === "society" ? "mem" : "mtime",
      sourceName: category === "society" ? "应急管理部" : "时光网",
      language: "zh-CN",
      region: "china",
      categories: [category],
      primaryCategory: category,
      summary: `${category} 中文标题 ${id}`,
      publishedAt: `2026-07-10T${String(hour).padStart(2, "0")}:00:00.000Z`,
      extractedAt: "2026-07-10T20:00:00.000Z",
    });
    const urls = selectChineseEnrichmentUrls([
      chinese("society-old", "society", 8),
      chinese("society-new", "society", 10),
      chinese("entertainment", "entertainment", 9),
    ]);

    expect(urls).toEqual(["https://example.com/society-new", "https://example.com/entertainment"]);
  });
});

describe("inferPrimaryCategory", () => {
  it("keeps a dedicated vertical source in its configured primary category", () => {
    expect(
      inferPrimaryCategory(
        {
          title: "应急管理部发布最新通知",
          summary: "通知包含防灾减灾和公共安全工作安排。",
          url: "https://www.mem.gov.cn/example.html",
        },
        { primaryCategory: "society", categories: ["society", "china", "policy"], lockPrimaryCategory: true },
      ),
    ).toBe("society");
  });

  it("uses article URL and text to correct broad source sections", () => {
    expect(
      inferPrimaryCategory(
        {
          title: "银川国际青年足球锦标赛：中国U17队不敌坦桑尼亚U17队",
          summary: "赛事新闻",
          url: "http://www.news.cn/sports/20260709/50a4854f161e4c768d0eb7cf91af4fca/c.html",
        },
        { primaryCategory: "china", categories: ["china", "policy", "international"] },
      ),
    ).toBe("sports");
  });
});
