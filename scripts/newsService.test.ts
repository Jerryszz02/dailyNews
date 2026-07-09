import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractArticleSummaryContext,
  extractPublishedDateFromHtml,
  inferPrimaryCategory,
  inferPublishedDateFromUrl,
  parsePublishedDate,
  prepareNewsTextForDisplay,
  readTranslationConfig,
  translateNewsText,
} from "./newsService";

const translationEnvNames = [
  "DAILY_NEWS_TRANSLATION_API_KEY",
  "DAILY_NEWS_TRANSLATION_BASE_URL",
  "DAILY_NEWS_TRANSLATION_MODEL",
] as const;

let originalTranslationEnv: Record<(typeof translationEnvNames)[number], string | undefined>;

beforeEach(() => {
  originalTranslationEnv = Object.fromEntries(translationEnvNames.map((name) => [name, process.env[name]])) as Record<
    (typeof translationEnvNames)[number],
    string | undefined
  >;
  for (const name of translationEnvNames) {
    delete process.env[name];
  }
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
        translationConfig: config,
      }),
    ).resolves.toEqual({
      title: "中文标题",
      summary: "这是一段中文新闻正文，提供事件背景、关键人物、时间线和后续影响，适合作为页面摘要。",
    });
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
