import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NewsSource } from "../src/types";

const firecrawlSearchMock = vi.hoisted(() => vi.fn());

vi.mock("firecrawl", () => ({
  Firecrawl: class {
    search(...args: unknown[]) {
      return firecrawlSearchMock(...args);
    }
  },
}));

import {
  collectNewsCandidates,
  defaultSourceConcurrency,
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
  runWithinDeadline,
  translateNewsText,
} from "./newsService";
import { readBundledReport } from "./reportStore";

const translationEnvNames = [
  "DAILY_NEWS_TRANSLATION_API_KEY",
  "DAILY_NEWS_TRANSLATION_BASE_URL",
  "DAILY_NEWS_TRANSLATION_MODEL",
] as const;
const maxNewsAgeEnvName = "DAILY_NEWS_MAX_AGE_HOURS";

let originalTranslationEnv: Record<(typeof translationEnvNames)[number], string | undefined>;
let originalMaxNewsAge: string | undefined;

beforeEach(() => {
  firecrawlSearchMock.mockReset();
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

function testSource(sourceId: string, name: string): NewsSource {
  return {
    source_id: sourceId,
    name,
    countryOrRegion: "china",
    language: "zh-CN",
    mediaType: "public",
    defaultWeight: 1,
    credibility: 80,
    mayHavePaywall: false,
    enabled: true,
    sections: [
      {
        label: "新闻",
        url: `https://${sourceId}.example.com/news`,
        categories: ["china"],
        primaryCategory: "china",
        searchTerms: [`${name} 新闻`],
      },
    ],
  };
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
    expect(result.report.generatedAt).toBe(readBundledReport().generatedAt);
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

describe("collectNewsCandidates source outcomes", () => {
  it("preserves keyless success, empty, and failed outcomes while direct fetch runs in parallel", async () => {
    const sources = [testSource("success", "成功源"), testSource("empty", "空结果源"), testSource("failed", "失败源")];
    const fetchedItems = Array.from({ length: 8 }, (_, index) => ({
      title: `实时新闻标题 ${index + 1}`,
      description: `实时新闻摘要 ${index + 1}，包含明确事实和后续安排。`,
      url: `https://success.example.com/news/article-${index + 1}`,
      publishedDate: "2026-07-13T07:00:00.000Z",
    }));
    firecrawlSearchMock.mockImplementation((query: string) => {
      if (query.includes("成功源")) return Promise.resolve({ news: fetchedItems });
      if (query.includes("空结果源")) return Promise.resolve({ news: [] });
      return Promise.reject(new Error("HTTP 429"));
    });
    const fetchMock = vi.fn((input: string | URL | Request) => {
      if (String(input).includes("failed.example.com")) {
        return Promise.resolve({ ok: false, status: 503, text: async () => "" } as Response);
      }
      return Promise.resolve(htmlResponse("<html><body>暂无直连新闻</body></html>"));
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await collectNewsCandidates({
      sources,
      limitPerSection: 8,
      now: new Date("2026-07-13T08:00:00.000Z"),
      collectionBudgetMs: 3_000,
      repairSummariesWithModel: false,
    });

    expect(result.items).toHaveLength(8);
    expect(result.sourceOutcomes).toEqual([
      { sourceId: "success", status: "success", discoveredCount: 8, errorCode: null },
      { sourceId: "empty", status: "empty", discoveredCount: 0, errorCode: null },
      { sourceId: "failed", status: "failed", discoveredCount: 0, errorCode: "source_rate_limited" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("marks a source failed only when both keyless and direct attempts fail", async () => {
    const sources = [testSource("empty", "空结果源"), testSource("failed", "双路失败源"), testSource("recovered", "直连恢复源")];
    firecrawlSearchMock.mockImplementation((query: string) => {
      if (query.includes("空结果源")) return Promise.resolve({ news: [] });
      return Promise.reject(new Error("HTTP 503"));
    });
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("empty.example.com")) return Promise.resolve(htmlResponse("<html><body>暂无新闻</body></html>"));
      if (url.includes("failed.example.com")) {
        return Promise.resolve({ ok: false, status: 503, text: async () => "" } as Response);
      }
      return Promise.resolve(htmlResponse(`
        <rss><channel><item>
          <title>直连恢复新闻标题</title>
          <link>https://recovered.example.com/news/article-1</link>
          <description>直连恢复新闻摘要，包含具体机构、时间和后续安排。</description>
          <pubDate>2026-07-13T07:30:00.000Z</pubDate>
        </item></channel></rss>
      `));
    }));

    const result = await collectNewsCandidates({
      sources,
      limitPerSection: 1,
      now: new Date("2026-07-13T08:00:00.000Z"),
      collectionBudgetMs: 3_000,
      repairSummariesWithModel: false,
    });

    expect(result.sourceOutcomes).toEqual([
      { sourceId: "empty", status: "empty", discoveredCount: 0, errorCode: null },
      { sourceId: "failed", status: "failed", discoveredCount: 0, errorCode: "source_server_error" },
      { sourceId: "recovered", status: "success", discoveredCount: 1, errorCode: null },
    ]);
  });

  it("does not turn a keyless processing deadline plus direct failure into an empty source", async () => {
    const source = testSource("keyless-deadline", "Keyless 后处理超时源");
    firecrawlSearchMock.mockResolvedValue({
      news: [
        {
          title: "需要正文补充摘要的 Keyless 新闻标题",
          description: "需要正文补充摘要的 Keyless 新闻标题",
          url: "https://keyless-deadline.example.com/news/article.html",
          publishedDate: "2026-07-18T06:00:00.000Z",
        },
      ],
    });
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => {
      if (String(input) === source.sections[0].url) {
        return Promise.resolve({ ok: false, status: 503, text: async () => "" } as Response);
      }
      return new Promise<Response>(() => undefined);
    }));

    const result = await collectNewsCandidates({
      sources: [source],
      limitPerSection: 1,
      now: new Date("2026-07-18T07:00:00.000Z"),
      collectionBudgetMs: 60,
      repairSummariesWithModel: false,
    });

    expect(result.items).toHaveLength(0);
    expect(result.sourceOutcomes).toEqual([
      {
        sourceId: "keyless-deadline",
        status: "failed",
        discoveredCount: 0,
        errorCode: "source_server_error",
      },
    ]);
  });

  it("keeps sources queued past the deadline eligible for the next refresh", async () => {
    vi.useFakeTimers();
    try {
      const sources = Array.from({ length: 8 }, (_, index) => testSource(`source-${index + 1}`, `来源 ${index + 1}`));
      vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));

      const resultPromise = collectNewsCandidates({
        sources,
        useFirecrawlKeyless: false,
        limitPerSection: 1,
        collectionBudgetMs: 30,
        repairSummariesWithModel: false,
      });
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.sourceOutcomes).toEqual(
        sources.map((source) => ({
          sourceId: source.source_id,
          status: "skipped",
          discoveredCount: 0,
          errorCode: "collection_deadline",
        })),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("records a successful listing fetch as attempted when article metadata probing reaches the deadline", async () => {
    const source = testSource("probe-deadline", "探测超时源");
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url === source.sections[0].url) {
        return Promise.resolve(
          htmlResponse('<a href="/news/2026/07/18/article.html">探测超时新闻标题，包含足够长度用于候选识别</a>'),
        );
      }
      return new Promise<Response>(() => undefined);
    }));

    const result = await collectNewsCandidates({
      sources: [source],
      useFirecrawlKeyless: false,
      limitPerSection: 1,
      collectionBudgetMs: 30,
      repairSummariesWithModel: false,
    });

    expect(result.items).toHaveLength(0);
    expect(result.sourceOutcomes).toEqual([
      {
        sourceId: "probe-deadline",
        status: "empty",
        discoveredCount: 0,
        errorCode: null,
      },
    ]);
  });

  it("records a successful feed fetch as attempted when summary context reaches the deadline", async () => {
    const source = testSource("feed-context-deadline", "Feed 正文超时源");
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url === source.sections[0].url) {
        return Promise.resolve(htmlResponse(`
          <rss><channel><item>
            <title>需要正文补充摘要的 Feed 新闻标题</title>
            <link>https://feed-context-deadline.example.com/news/article.html</link>
            <pubDate>2026-07-18T06:00:00.000Z</pubDate>
          </item></channel></rss>
        `));
      }
      return new Promise<Response>(() => undefined);
    }));

    const result = await collectNewsCandidates({
      sources: [source],
      useFirecrawlKeyless: false,
      limitPerSection: 1,
      now: new Date("2026-07-18T07:00:00.000Z"),
      collectionBudgetMs: 30,
      repairSummariesWithModel: false,
    });

    expect(result.items).toHaveLength(0);
    expect(result.sourceOutcomes).toEqual([
      {
        sourceId: "feed-context-deadline",
        status: "empty",
        discoveredCount: 0,
        errorCode: null,
      },
    ]);
  });

  it("bounds direct listing and article requests across eleven concurrent sources", async () => {
    const sources = Array.from({ length: 11 }, (_unused, index) =>
      testSource(`bounded-${index + 1}`, `受限来源 ${index + 1}`),
    );
    let articleRequestsStarted = 0;
    let releaseArticleRequests: () => void = () => undefined;
    const articleBarrier = new Promise<void>((resolve) => {
      releaseArticleRequests = resolve;
    });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const sourceIndex = sources.findIndex((source) => source.sections[0].url === url);
      if (sourceIndex >= 0 && sourceIndex < 5) {
        return htmlResponse(`
          <rss><channel><item>
            <title>需要正文摘要的 Feed 新闻标题</title>
            <link>https://bounded-${sourceIndex + 1}.example.com/news/feed-article.html</link>
            <pubDate>2026-07-18T06:00:00.000Z</pubDate>
          </item></channel></rss>
        `);
      }
      if (sourceIndex >= 5) {
        return htmlResponse(`
          <a href="/news/2026/07/18/article-1.html">候选新闻标题一，包含足够长度用于识别</a>
          <a href="/news/2026/07/18/article-2.html">候选新闻标题二，包含足够长度用于识别</a>
          <a href="/news/2026/07/18/article-3.html">候选新闻标题三，包含足够长度用于识别</a>
        `);
      }
      articleRequestsStarted += 1;
      await articleBarrier;
      return htmlResponse(`
        <meta property="article:published_time" content="2026-07-18T14:00:00+08:00">
        <meta property="og:description" content="公开文章包含具体主体、事件时间、事实进展和后续安排，用于验证全局请求并发上限。">
      `);
    }));

    const resultPromise = collectNewsCandidates({
      sources,
      useFirecrawlKeyless: false,
      limitPerSection: 1,
      now: new Date("2026-07-18T07:00:00.000Z"),
      collectionBudgetMs: 3_000,
      repairSummariesWithModel: false,
    });
    for (let attempt = 0; attempt < 100 && articleRequestsStarted < 11; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(articleRequestsStarted).toBe(11);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(articleRequestsStarted).toBe(11);

    releaseArticleRequests();
    const result = await resultPromise;
    expect(result.sourceOutcomes).toHaveLength(11);
    expect(result.sourceOutcomes.every((outcome) => outcome.status === "success")).toBe(true);
  });

  it("prioritizes newer date-encoded article links before applying the per-section limit", async () => {
    const source = testSource("ordered", "按日期排序源");
    source.sections[0].url = "https://ordered.example.com/";
    const olderLinks = Array.from(
      { length: 10 },
      (_, index) =>
        `<a href="/gn/2026/07-17/${10661000 + index}.shtml">旧新闻标题 ${index + 1}，用于占据首页前部候选位置</a>`,
    ).join("");
    const currentUrl = "https://ordered.example.com/cj/2026/07-18/10661953.shtml";
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url === source.sections[0].url) {
        return Promise.resolve(
          htmlResponse(
            `${olderLinks}<a href="${currentUrl}">年中盘点：中国民营经济韧性强活力足</a>`,
          ),
        );
      }
      return Promise.resolve(
        htmlResponse(`
          <meta property="article:published_time" content="2026-07-18T12:38:00+08:00">
          <meta property="og:description" content="最新公开文章包含具体时间、主体、事实进展和后续安排，可用于验证首页后部的新链接不会被旧链接挤出。">
        `),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await collectNewsCandidates({
      sources: [source],
      useFirecrawlKeyless: false,
      limitPerSection: 1,
      now: new Date("2026-07-18T06:00:00.000Z"),
      collectionBudgetMs: 3_000,
      repairSummariesWithModel: false,
    });

    expect(result.sourceOutcomes).toEqual([
      { sourceId: "ordered", status: "success", discoveredCount: 1, errorCode: null },
    ]);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      url: currentUrl,
      publishedAt: "2026-07-18T04:38:00.000Z",
    });
  });

  it("resolves exact article times before truncating same-day HTML links", async () => {
    const source = testSource("same-day", "同日排序源");
    source.sections[0].url = "https://same-day.example.com/";
    const newestUrl = "https://same-day.example.com/news/2026/07/18/newest.html";
    const olderLinks = Array.from(
      { length: 9 },
      (_unused, index) =>
        `<a href="/news/2026/07/18/story-${index + 1}.html">同日较早新闻标题 ${index + 1}，包含足够长度用于候选识别</a>`,
    ).join("");
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url === source.sections[0].url) {
        return Promise.resolve(htmlResponse(`
          ${olderLinks}
          <a href="/news/2026/07/18/newest.html">同日最新新闻标题，包含足够长度用于候选识别</a>
        `));
      }
      return Promise.resolve(htmlResponse(`
        <meta property="article:published_time" content="${url === newestUrl ? "2026-07-18T14:00:00+08:00" : "2026-07-18T08:00:00+08:00"}">
        <meta property="og:description" content="公开文章包含具体主体、事件时间、事实进展和后续安排，可用于验证同一天候选按精确发布时间选择。">
      `));
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await collectNewsCandidates({
      sources: [source],
      useFirecrawlKeyless: false,
      limitPerSection: 1,
      now: new Date("2026-07-18T07:00:00.000Z"),
      collectionBudgetMs: 3_000,
      repairSummariesWithModel: false,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      url: newestUrl,
      publishedAt: "2026-07-18T06:00:00.000Z",
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("uses anchor time dates and skips stale or self-linked HTML candidates before probing", async () => {
    const source = testSource("anchor-time", "锚点时间源");
    source.sections[0].url = "https://anchor-time.example.com/news";
    const freshUrl = "https://anchor-time.example.com/news/fresh-story";
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url !== source.sections[0].url) {
        throw new Error(`Unexpected article probe: ${url}`);
      }
      return Promise.resolve(htmlResponse(`
        <a href="/news/">新闻列表首页导航链接，不能作为文章重复探测</a>
        <a href="/news/stale-story">
          <time datetime="2026-07-01T09:00:00.000Z">2026-07-01</time>
          已经过期的新闻标题，不能进入翻译或正文探测
        </a>
        <a href="/news/fresh-story">
          <time datetime="2026-07-18T09:00:00.000Z">2026-07-18</time>
          最新新闻标题，直接使用列表中的可靠时间
        </a>
      `));
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await collectNewsCandidates({
      sources: [source],
      useFirecrawlKeyless: false,
      limitPerSection: 3,
      now: new Date("2026-07-18T10:00:00.000Z"),
      collectionBudgetMs: 3_000,
      repairSummariesWithModel: false,
    });

    expect(result.sourceOutcomes).toEqual([
      { sourceId: "anchor-time", status: "success", discoveredCount: 1, errorCode: null },
    ]);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      url: freshUrl,
      publishedAt: "2026-07-18T09:00:00.000Z",
    });
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      source.sections[0].url,
      freshUrl,
    ]);
  });

  it("uses HTML card headings and summaries without fetching a dated article page", async () => {
    process.env.DAILY_NEWS_TRANSLATION_API_KEY = "test-key";
    const source = testSource("card-context", "卡片上下文源");
    source.language = "en-US";
    source.countryOrRegion = "global";
    source.sections[0].requireChinese = false;
    const articleUrl = "https://card-context.example.com/news/fresh-story";
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url === source.sections[0].url) {
        return Promise.resolve(htmlResponse(`
          <a href="/news/fresh-story">
            <time datetime="2026-07-18T09:00:00.000Z">July 18, 2026</time>
            <h2>New model improves complex reasoning</h2>
            <p>The release improves coding, analysis, and long-context reliability for enterprise users.</p>
          </a>
        `));
      }
      if (url === "https://api.deepseek.com/chat/completions") {
        return Promise.resolve(chatResponse(JSON.stringify({
          title: "新模型提升复杂推理能力",
          summary: "该版本提升编码、分析和长上下文可靠性，主要面向企业用户。",
        })));
      }
      throw new Error(`Unexpected article fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await collectNewsCandidates({
      sources: [source],
      useFirecrawlKeyless: false,
      limitPerSection: 1,
      now: new Date("2026-07-18T10:00:00.000Z"),
      collectionBudgetMs: 3_000,
      repairSummariesWithModel: true,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      url: articleUrl,
      title: "新模型提升复杂推理能力",
      publishedAt: "2026-07-18T09:00:00.000Z",
    });
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      source.sections[0].url,
      "https://api.deepseek.com/chat/completions",
    ]);
  });

  it("translates the newest sitemap entry without fetching the article page", async () => {
    process.env.DAILY_NEWS_TRANSLATION_API_KEY = "test-key";
    const source = testSource("sitemap-context", "站点地图源");
    source.language = "en-US";
    source.countryOrRegion = "global";
    source.sections[0].requireChinese = false;
    source.sections[0].url = "https://sitemap-context.example.com/sitemap.xml";
    const articleUrl = "https://sitemap-context.example.com/news/new-model-release";
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url === source.sections[0].url) {
        return Promise.resolve(htmlResponse(`
          <urlset>
            <url><loc>https://sitemap-context.example.com/news/old-release</loc><lastmod>2026-07-17</lastmod></url>
            <url><loc>${articleUrl}</loc><lastmod>2026-07-18T09:00:00.000Z</lastmod></url>
          </urlset>
        `));
      }
      if (url === "https://api.deepseek.com/chat/completions") {
        return Promise.resolve(chatResponse(JSON.stringify({
          title: "新模型提升复杂推理能力",
          summary: "该版本提升编码、分析和长上下文可靠性，主要面向企业用户。",
        })));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await collectNewsCandidates({
      sources: [source],
      useFirecrawlKeyless: false,
      limitPerSection: 1,
      now: new Date("2026-07-18T10:00:00.000Z"),
      collectionBudgetMs: 3_000,
      repairSummariesWithModel: true,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      url: articleUrl,
      title: "新模型提升复杂推理能力",
      publishedAt: "2026-07-18T09:00:00.000Z",
    });
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      source.sections[0].url,
      "https://api.deepseek.com/chat/completions",
    ]);
  });

  it("resolves exact article times before truncating HTML links without dates", async () => {
    const source = testSource("undated", "无日期排序源");
    source.sections[0].url = "https://undated.example.com/";
    const newestUrl = "https://undated.example.com/news/articles/newest-story";
    const articleTimes = new Map([
      ["https://undated.example.com/news/articles/oldest-story", "2026-07-18T08:00:00+08:00"],
      ["https://undated.example.com/news/articles/middle-story", "2026-07-18T10:00:00+08:00"],
      [newestUrl, "2026-07-18T14:00:00+08:00"],
    ]);
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url === source.sections[0].url) {
        return Promise.resolve(htmlResponse(`
          <a href="/news/articles/oldest-story">无日期较早新闻标题，包含足够长度用于候选识别</a>
          <a href="/news/articles/middle-story">无日期中间新闻标题，包含足够长度用于候选识别</a>
          <a href="/news/articles/newest-story">无日期最新新闻标题，包含足够长度用于候选识别</a>
        `));
      }
      return Promise.resolve(htmlResponse(`
        <meta property="article:published_time" content="${articleTimes.get(url)}">
        <meta property="og:description" content="公开文章包含具体主体、事件时间、事实进展和后续安排，可用于验证无日期候选按精确发布时间选择。">
      `));
    }));

    const result = await collectNewsCandidates({
      sources: [source],
      useFirecrawlKeyless: false,
      limitPerSection: 1,
      now: new Date("2026-07-18T07:00:00.000Z"),
      collectionBudgetMs: 3_000,
      repairSummariesWithModel: false,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      url: newestUrl,
      publishedAt: "2026-07-18T06:00:00.000Z",
    });
  });

  it("sorts oldest-first feeds by published time before applying the section limit", async () => {
    const source = testSource("feed-order", "Feed 排序源");
    source.sections[0].url = "https://feed-order.example.com/rss.xml";
    const newestUrl = "https://feed-order.example.com/news/newest.html";
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url === source.sections[0].url) {
        return Promise.resolve(htmlResponse(`
          <rss><channel>
            <item><title>Feed 较早新闻标题</title><link>https://feed-order.example.com/news/oldest.html</link><description>较早新闻摘要包含具体事实和后续安排。</description><pubDate>2026-07-18T00:00:00.000Z</pubDate></item>
            <item><title>Feed 中间新闻标题</title><link>https://feed-order.example.com/news/middle.html</link><description>中间新闻摘要包含具体事实和后续安排。</description><pubDate>2026-07-18T03:00:00.000Z</pubDate></item>
            <item><title>Feed 最新新闻标题</title><link>${newestUrl}</link><description>最新新闻摘要包含具体事实和后续安排。</description><pubDate>2026-07-18T06:00:00.000Z</pubDate></item>
          </channel></rss>
        `));
      }
      return Promise.resolve(htmlResponse("<p>Feed 文章正文包含足够信息用于摘要。</p>"));
    }));

    const result = await collectNewsCandidates({
      sources: [source],
      useFirecrawlKeyless: false,
      limitPerSection: 1,
      now: new Date("2026-07-18T07:00:00.000Z"),
      collectionBudgetMs: 3_000,
      repairSummariesWithModel: false,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      url: newestUrl,
      publishedAt: "2026-07-18T06:00:00.000Z",
    });
  });

  it("re-sorts feeds after resolving missing item dates", async () => {
    const source = testSource("feed-missing-date", "Feed 缺日期源");
    source.sections[0].url = "https://feed-missing-date.example.com/rss.xml";
    const newestUrl = "https://feed-missing-date.example.com/news/newest.html";
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url === source.sections[0].url) {
        return Promise.resolve(htmlResponse(`
          <rss><channel>
            <item><title>Feed 旧新闻标题</title><link>https://feed-missing-date.example.com/news/old.html</link><description>旧新闻摘要包含具体事实和后续安排。</description><pubDate>2026-07-18T00:00:00.000Z</pubDate></item>
            <item><title>Feed 无日期最新新闻标题</title><link>${newestUrl}</link><description>最新新闻摘要包含具体事实和后续安排。</description></item>
          </channel></rss>
        `));
      }
      return Promise.resolve(htmlResponse(`
        <meta property="article:published_time" content="2026-07-18T14:00:00+08:00">
        <meta property="og:description" content="公开文章包含具体主体、事件时间、事实进展和后续安排，用于验证补日期后重新排序。">
      `));
    }));

    const result = await collectNewsCandidates({
      sources: [source],
      useFirecrawlKeyless: false,
      limitPerSection: 1,
      now: new Date("2026-07-18T07:00:00.000Z"),
      collectionBudgetMs: 3_000,
      repairSummariesWithModel: false,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      url: newestUrl,
      publishedAt: "2026-07-18T06:00:00.000Z",
    });
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

  it("starts all eleven selected sources before releasing the default concurrency barrier", async () => {
    const values = Array.from({ length: 11 }, (_, index) => index + 1);
    const started: number[] = [];
    let active = 0;
    let completed = 0;
    let maxActive = 0;
    let release: () => void = () => undefined;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });

    const resultPromise = mapWithConcurrency(values, defaultSourceConcurrency, async (value) => {
      started.push(value);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await barrier;
      active -= 1;
      completed += 1;
      return value;
    });

    expect(defaultSourceConcurrency).toBe(11);
    expect(started).toEqual(values);
    expect(completed).toBe(0);

    release();
    await expect(resultPromise).resolves.toEqual(values);
    expect(maxActive).toBe(11);
    expect(completed).toBe(11);
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
    ).resolves.toEqual({ title: "中文标题", summary: "相关报道聚焦“中文标题”，具体背景、影响和后续进展以原文披露为准。" });
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

  it("extracts a factual article summary without calling the model when repair is disabled", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      htmlResponse(
        '<meta property="og:description" content="这是一段来自公开文章页面的中文事实摘要，说明事件背景、参与机构、发生时间以及后续安排。">',
      ),
    );
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
      summary: "这是一段来自公开文章页面的中文事实摘要，说明事件背景、参与机构、发生时间以及后续安排。",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("https://example.com/news/chinese", expect.any(Object));
  });
});

describe("inferPrimaryCategory", () => {
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
