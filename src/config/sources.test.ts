import { describe, expect, it } from "vitest";
import type { Category } from "../types";
import { expandedSourceDefinitions } from "./expandedSources";
import { newsSources } from "./sources";
import { xAccountRegistry, xSourceId } from "./xAccounts";

/** The 54 source ids that existed before the approved catalog expansion. */
const ORIGINAL_SOURCE_IDS = [
  "xinhua",
  "people",
  "cctv",
  "chinanews",
  "china-daily",
  "caixin",
  "yicai",
  "jiemian",
  "the-paper",
  "36kr",
  "tmtpost",
  "jiqizhixin",
  "qbitai",
  "nba",
  "fifa",
  "fiba",
  "bbc-sport",
  "espn",
  "yahoo-sports-nba",
  "cbs-sports-nba",
  "the-athletic-nba",
  "variety",
  "mtime",
  "reuters",
  "ap",
  "cnn",
  "bbc",
  "aljazeera",
  "npr",
  "guardian",
  "bloomberg",
  "ft",
  "wsj",
  "cnbc",
  "techcrunch",
  "the-verge",
  "wired",
  "ars-technica",
  "mit-tech-review",
  "openai",
  "anthropic",
  "google-deepmind",
  "google-ai",
  "meta-ai",
  "microsoft-ai",
  "nvidia-ai",
  "hugging-face",
  "x-shams",
  "x-openai",
  "x-anthropic",
  "x-sam-altman",
  "x-greg-brockman",
  "x-deepmind",
  "x-karpathy",
];

/** Pre-expansion disabled source ids that must stay disabled. */
const PRESERVED_DISABLED_SOURCE_IDS = ["the-athletic-nba", "reuters", "bloomberg", "ft", "wsj"];

/** The 46 approved non-X publisher entries added by this expansion. */
const EXPANDED_SOURCE_IDS = [
  "deepseek",
  "qwen",
  "z-ai",
  "arxiv",
  "ithome",
  "leiphone",
  "ifanr",
  "apple-newsroom",
  "github-blog",
  "21jingji",
  "nbs",
  "pboc",
  "fed",
  "ecb",
  "sse",
  "szse",
  "hkex",
  "cna",
  "nhk",
  "dw",
  "france24",
  "africanews",
  "agencia-brasil",
  "bjnews",
  "infzm",
  "cyol",
  "redstar",
  "gov-cn",
  "ndrc",
  "mof",
  "miit",
  "eu-commission",
  "who",
  "science-news",
  "nature-news",
  "nasa",
  "cas",
  "sciencenet",
  "wta",
  "atp",
  "world-athletics",
  "olympics",
  "f1",
  "deadline",
  "thr",
  "billboard",
];

/**
 * The complete approved publisher/category catalog: each publisher must expose a
 * section whose primaryCategory is the listed category.
 */
const EXPECTED_CATEGORY_ROWS: Record<Category, string[]> = {
  ai: [
    "jiqizhixin",
    "qbitai",
    "mit-tech-review",
    "openai",
    "anthropic",
    "google-deepmind",
    "google-ai",
    "meta-ai",
    "microsoft-ai",
    "nvidia-ai",
    "hugging-face",
    "deepseek",
    "qwen",
    "z-ai",
    "arxiv",
  ],
  technology: [
    "36kr",
    "tmtpost",
    "techcrunch",
    "the-verge",
    "ars-technica",
    "ithome",
    "leiphone",
    "ifanr",
    "apple-newsroom",
    "github-blog",
  ],
  finance: ["chinanews", "caixin", "yicai", "jiemian", "cnbc", "21jingji", "nbs", "pboc", "fed", "ecb", "sse", "szse", "hkex"],
  international: [
    "xinhua",
    "cctv",
    "chinanews",
    "ap",
    "cnn",
    "bbc",
    "aljazeera",
    "npr",
    "guardian",
    "cna",
    "nhk",
    "dw",
    "france24",
    "africanews",
    "agencia-brasil",
  ],
  china: ["xinhua", "people", "cctv", "chinanews", "china-daily", "the-paper", "bjnews", "infzm", "cyol", "redstar"],
  policy: ["pboc", "fed", "ecb", "gov-cn", "ndrc", "mof", "miit", "eu-commission"],
  society: ["chinanews", "the-paper", "bjnews", "infzm", "who"],
  science: ["xinhua", "wired", "science-news", "nature-news", "nasa", "cas", "sciencenet"],
  sports: [
    "xinhua",
    "cctv",
    "chinanews",
    "nba",
    "fifa",
    "fiba",
    "bbc-sport",
    "espn",
    "yahoo-sports-nba",
    "cbs-sports-nba",
    "wta",
    "atp",
    "world-athletics",
    "olympics",
    "f1",
  ],
  entertainment: ["cctv", "chinanews", "the-paper", "variety", "mtime", "deadline", "thr", "billboard"],
};

/** Supplied public feed endpoints keyed by publisher id and section category. */
const EXPECTED_FEEDS: Array<[string, Category, string]> = [
  ["openai", "ai", "https://openai.com/news/rss.xml"],
  ["google-deepmind", "ai", "https://deepmind.google/blog/rss.xml"],
  ["hugging-face", "ai", "https://huggingface.co/blog/feed.xml"],
  ["arxiv", "ai", "https://rss.arxiv.org/rss/cs.AI"],
  ["chinanews", "finance", "https://www.chinanews.com.cn/rss/finance.xml"],
  ["fed", "finance", "https://www.federalreserve.gov/feeds/press_all.xml"],
  ["fed", "policy", "https://www.federalreserve.gov/feeds/press_all.xml"],
  ["bbc", "international", "https://feeds.bbci.co.uk/news/world/rss.xml"],
  ["cna", "international", "https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml&category=6511"],
  ["dw", "international", "https://rss.dw.com/rdf/rss-en-all"],
  ["chinanews", "society", "https://www.chinanews.com.cn/rss/society.xml"],
  ["nature-news", "science", "https://www.nature.com/nature.rss"],
  ["nasa", "science", "https://www.nasa.gov/news-release/feed/"],
  ["deadline", "entertainment", "https://deadline.com/feed/"],
];

/** The seven pre-expansion X sources whose ids and metadata are preserved. */
const PRESERVED_X_SOURCES: Array<[string, string]> = [
  ["x-shams", "ShamsCharania"],
  ["x-openai", "OpenAI"],
  ["x-anthropic", "AnthropicAI"],
  ["x-sam-altman", "sama"],
  ["x-greg-brockman", "gdb"],
  ["x-deepmind", "GoogleDeepMind"],
  ["x-karpathy", "karpathy"],
];

const PENDING_X_HANDLES = ["SpaceXAI", "grok", "ibab", "TobyPhln", "Yuhu_ai_", "jimmybajimmyba", "Guodzh", "TheGregYang", "ZihangDai"];

const CHINESE = /[\u4e00-\u9fff]/;

function sourceById(sourceId: string) {
  return newsSources.find((source) => source.source_id === sourceId);
}

function sectionForCategory(sourceId: string, category: Category) {
  return sourceById(sourceId)?.sections.find((section) => section.primaryCategory === category);
}

function registrySourceId(entry: (typeof xAccountRegistry)[number]): string {
  return entry.existingSourceId ?? xSourceId(entry.handle);
}

describe("approved source catalog expansion", () => {
  it("preserves every pre-expansion source id and its enablement boundary", () => {
    for (const sourceId of ORIGINAL_SOURCE_IDS) {
      expect(sourceById(sourceId), `missing original source ${sourceId}`).toBeDefined();
    }
    for (const sourceId of PRESERVED_DISABLED_SOURCE_IDS) {
      expect(sourceById(sourceId)?.enabled, `${sourceId} must stay disabled`).toBe(false);
    }

    expect(newsSources).toHaveLength(169);
    const nonX = newsSources.filter((source) => source.mediaType !== "social");
    expect(nonX).toHaveLength(93);
    expect(nonX.filter((source) => source.enabled)).toHaveLength(88);
    expect(nonX.filter((source) => !source.enabled).map((source) => source.source_id).sort()).toEqual(
      [...PRESERVED_DISABLED_SOURCE_IDS].sort(),
    );
  });

  it("adds exactly the 46 approved non-X publishers as enabled sources", () => {
    expect(expandedSourceDefinitions).toHaveLength(46);
    expect(expandedSourceDefinitions.map((source) => source.source_id).sort()).toEqual([...EXPANDED_SOURCE_IDS].sort());

    for (const sourceId of EXPANDED_SOURCE_IDS) {
      const source = sourceById(sourceId);
      expect(source, `missing expanded source ${sourceId}`).toBeDefined();
      expect(source?.enabled, `${sourceId} must be enabled`).toBe(true);
      expect(source?.mediaType).not.toBe("social");
      expect(source?.name).toMatch(CHINESE);
    }
  });

  it("covers every approved publisher/category row with a matching section", () => {
    let rowCount = 0;
    for (const [category, publisherIds] of Object.entries(EXPECTED_CATEGORY_ROWS) as Array<[Category, string[]]>) {
      for (const publisherId of publisherIds) {
        rowCount += 1;
        const source = sourceById(publisherId);
        expect(source, `missing publisher ${publisherId} for ${category}`).toBeDefined();
        const section = sectionForCategory(publisherId, category);
        expect(section, `${publisherId} is missing a ${category} section`).toBeDefined();
        expect(section?.categories, `${publisherId}:${category} categories`).toContain(category);
      }
    }
    expect(rowCount).toBe(106);
  });

  it("attaches each supplied feedUrl to the matching category section", () => {
    for (const [sourceId, category, feedUrl] of EXPECTED_FEEDS) {
      const section = sectionForCategory(sourceId, category);
      expect(section, `missing ${sourceId}:${category} section`).toBeDefined();
      expect(section?.feedUrl, `${sourceId}:${category} feedUrl`).toBe(feedUrl);
    }
  });

  it("keeps section reader URLs as the only source of allowedHosts", () => {
    for (const source of newsSources) {
      const sectionHosts = new Set(
        source.sections.flatMap((section) => [section.url, ...(section.readerUrlAliases ?? [])])
          .map((url) => new URL(url).hostname.replace(/^www\./, "").toLowerCase()),
      );
      expect(source.allowedHosts.every((host) => sectionHosts.has(host)), `${source.source_id} allowedHosts`).toBe(true);
      for (const section of source.sections) {
        if (!section.feedUrl) continue;
        const feedHost = new URL(section.feedUrl).hostname.replace(/^www\./, "").toLowerCase();
        if (!sectionHosts.has(feedHost)) {
          expect(source.allowedHosts, `${source.source_id} leaked feed host ${feedHost}`).not.toContain(feedHost);
        }
      }
    }

    expect(sourceById("bbc")?.allowedHosts).toContain("bbc.co.uk");
    expect(sourceById("bbc")?.allowedHosts).not.toContain("feeds.bbci.co.uk");
    expect(sourceById("arxiv")?.allowedHosts).not.toContain("rss.arxiv.org");
    expect(sourceById("dw")?.allowedHosts).not.toContain("rss.dw.com");
  });

  it("keeps source ids unique and passes the admission invariant", () => {
    const sourceIds = newsSources.map((source) => source.source_id);
    expect(new Set(sourceIds).size).toBe(sourceIds.length);
    expect(newsSources.every((source) => source.allowedHosts.length > 0)).toBe(true);
  });

  it("registers 76 unique X handles and maps each to one source", () => {
    expect(xAccountRegistry).toHaveLength(76);
    const handles = xAccountRegistry.map((entry) => entry.handle.toLowerCase());
    expect(new Set(handles).size).toBe(76);

    for (const entry of xAccountRegistry) {
      const source = sourceById(registrySourceId(entry));
      expect(source, `missing source for @${entry.handle}`).toBeDefined();
      expect(source?.xUsername, `@${entry.handle} xUsername`).toBe(entry.handle);
    }

    const xSources = newsSources.filter((source) => source.mediaType === "social");
    expect(xSources).toHaveLength(76);
    expect(xSources.every((source) => Boolean(source.xUsername))).toBe(true);
    const xUsernames = xSources.map((source) => source.xUsername!.toLowerCase());
    expect(new Set(xUsernames).size).toBe(76);
  });

  it("enables the 67 confirmed handles and disables the 9 pending xAI proposals", () => {
    expect(xAccountRegistry.filter((entry) => entry.userConfirmed)).toHaveLength(67);
    expect(xAccountRegistry.filter((entry) => !entry.userConfirmed)).toHaveLength(9);
    expect(xAccountRegistry.filter((entry) => !entry.userConfirmed).map((entry) => entry.handle).sort()).toEqual(
      [...PENDING_X_HANDLES].sort(),
    );

    const xSources = newsSources.filter((source) => source.mediaType === "social");
    expect(xSources.filter((source) => source.enabled)).toHaveLength(67);
    expect(xSources.filter((source) => !source.enabled)).toHaveLength(9);

    for (const handle of PENDING_X_HANDLES) {
      const source = sourceById(xSourceId(handle));
      expect(source, `missing pending source x-${handle.toLowerCase()}`).toBeDefined();
      expect(source?.enabled, `@${handle} must stay disabled`).toBe(false);
    }
  });

  it("preserves the seven existing X source ids and attaches their xUsername", () => {
    for (const [sourceId, handle] of PRESERVED_X_SOURCES) {
      const source = sourceById(sourceId);
      expect(source, `missing preserved X source ${sourceId}`).toBeDefined();
      expect(source?.xUsername).toBe(handle);
      expect(source?.enabled).toBe(true);
      expect(source?.mediaType).toBe("social");
    }
  });

  it("records the corrected and user-specified handles exactly", () => {
    const handles = xAccountRegistry.map((entry) => entry.handle);
    expect(handles).toContain("thsottiaux");
    expect(handles.map((handle) => handle.toLowerCase())).not.toContain("tibo_maker");
    expect(handles.map((handle) => handle.toLowerCase())).not.toContain("liangwenfeng");
    expect(handles).toContain("ZixuanLi_");
    expect(handles.filter((handle) => handle.toLowerCase() === "zixuanli")).toHaveLength(0);
    expect(handles).toEqual(expect.arrayContaining(["arena", "Khazix0918", "derrickcchoi", "elonmusk", "tianyi"]));

    const tibo = xAccountRegistry.find((entry) => entry.handle === "thsottiaux");
    expect(sourceById(xSourceId("thsottiaux"))?.enabled).toBe(true);
    expect(tibo?.evidenceNote).toContain("@thsottiaux");

    const ibab = xAccountRegistry.find((entry) => entry.handle === "ibab");
    expect(ibab?.name).toBe("Igor Babuschkin");
    expect(ibab?.affiliationStatus).toContain("离职");

    const tianyi = xAccountRegistry.find((entry) => entry.handle === "tianyi");
    expect(tianyi?.userConfirmed).toBe(true);
    expect(tianyi?.affiliationStatus).toBeNull();
    expect(tianyi?.identityStatus).toContain("用户指定");
  });

  it("keeps identity notes separate from user confirmation in the registry", () => {
    for (const entry of xAccountRegistry) {
      expect(entry.identityStatus.length).toBeGreaterThan(0);
      expect(entry.evidenceUrl.startsWith("https://")).toBe(true);
      expect(entry.evidenceNote.length).toBeGreaterThan(0);
      expect(entry.decision).toBe(entry.userConfirmed ? "保留" : "待确认");
    }
  });

  it("generates stable x-<lowercasehandle> ids for handles without a preserved source", () => {
    for (const entry of xAccountRegistry) {
      if (entry.existingSourceId) {
        expect(xSourceId(entry.handle)).toBe(`x-${entry.handle.toLowerCase()}`);
        continue;
      }
      const source = sourceById(xSourceId(entry.handle));
      expect(source, `missing generated source for @${entry.handle}`).toBeDefined();
      expect(source?.name).toContain("X 动态");
    }
  });
});
