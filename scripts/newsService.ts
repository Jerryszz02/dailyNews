import { existsSync, readFileSync } from "node:fs";
import { Firecrawl } from "firecrawl";
import { defaultPreferences } from "../src/config/preferences.js";
import { newsSources } from "../src/config/sources.js";
import { firecrawlSnapshotNews } from "../src/data/firecrawlSnapshot.js";
import { buildDailyReport } from "../src/lib/newsPipeline.js";
import { hostnameFromUrl } from "../src/lib/text.js";
import type { DailyNewsReport, NewsSource, RawNewsItem, SearchSourceType, SourceSection } from "../src/types";

export const defaultLimitPerSection = 5;
export const defaultMaxSources = newsSources.filter((source) => source.enabled).length;
export const defaultRefreshIntervalMinutes = 15;

export interface NewsGenerationOptions {
  limitPerSection?: number;
  maxSources?: number;
  now?: Date;
}

export interface NewsGenerationResult {
  report: DailyNewsReport;
  mode: "Firecrawl keyless" | "Direct source fetch" | "Firecrawl snapshot";
  rawItemCount: number;
  usedLiveData: boolean;
}

interface TranslationConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export async function generateDailyNewsReport(options: NewsGenerationOptions = {}): Promise<NewsGenerationResult> {
  loadLocalEnv();
  const limitPerSection = options.limitPerSection ?? readPositiveInteger("DAILY_NEWS_LIMIT_PER_SECTION", defaultLimitPerSection);
  const maxSources = options.maxSources ?? readPositiveInteger("DAILY_NEWS_MAX_SOURCES", defaultMaxSources);
  const translationConfig = readTranslationConfig();
  const fetchedItems = await fetchWithFirecrawlKeyless({ limitPerSection, maxSources, translationConfig });
  const directItems =
    fetchedItems.length > 0 ? [] : await fetchDirectSources({ limitPerSection, maxSources, translationConfig });
  const liveItems = fetchedItems.length > 0 ? fetchedItems : directItems;
  const fallbackItems = readGeneratedFallbackItems();
  const rawItems = liveItems.length > 0 ? liveItems : fallbackItems;
  const report = buildDailyReport(rawItems, defaultPreferences, options.now);
  const usedLiveData = liveItems.length > 0;

  return {
    report,
    mode: fetchedItems.length > 0 ? "Firecrawl keyless" : directItems.length > 0 ? "Direct source fetch" : "Firecrawl snapshot",
    rawItemCount: rawItems.length,
    usedLiveData,
  };
}

function readGeneratedFallbackItems(): RawNewsItem[] {
  const filePath = new URL("../public/daily-news.json", import.meta.url);
  if (!existsSync(filePath)) return firecrawlSnapshotNews;

  try {
    const report = JSON.parse(readFileSync(filePath, "utf8")) as Partial<DailyNewsReport>;
    return Array.isArray(report.items) && report.items.length > 0 ? (report.items as RawNewsItem[]) : firecrawlSnapshotNews;
  } catch {
    return firecrawlSnapshotNews;
  }
}

export function loadLocalEnv() {
  for (const fileName of [".env.local", ".env"]) {
    const filePath = new URL(`../${fileName}`, import.meta.url);
    if (!existsSync(filePath)) continue;

    const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const separator = trimmed.indexOf("=");
      if (separator <= 0) continue;

      const key = trimmed.slice(0, separator).trim();
      const value = trimmed
        .slice(separator + 1)
        .trim()
        .replace(/^['"]|['"]$/g, "");

      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  }
}

export function readPositiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

async function fetchWithFirecrawlKeyless(
  options: { limitPerSection: number; maxSources: number; translationConfig?: TranslationConfig },
): Promise<RawNewsItem[]> {
  const app = new Firecrawl({ apiKey: "" });
  const items: RawNewsItem[] = [];
  const enabledSources = selectNewsSources(options.maxSources);
  let warnedMissingTranslation = false;

  for (const source of enabledSources) {
    for (const section of source.sections) {
      try {
        const domain = hostnameFromUrl(section.url);
        const seenUrls = new Set<string>();
        const webResults: unknown[] = [];

        for (const query of buildQueries(source.name, section)) {
          let results = await app.search(query, {
            limit: options.limitPerSection,
            includeDomains: domain ? [domain] : undefined,
            sources: section.searchSources ?? ["news"],
          } as never);
          let searchResults = readSearchResults(results, section.searchSources ?? ["news"]);
          if (searchResults.length === 0 && domain) {
            results = await app.search(query, {
              limit: options.limitPerSection,
              sources: section.searchSources ?? ["news"],
            } as never);
            searchResults = readSearchResults(results, section.searchSources ?? ["news"]);
          }

          for (const result of searchResults) {
            const url = readString(result, "url").trim();
            if (!url || seenUrls.has(url)) continue;
            seenUrls.add(url);
            webResults.push(result);
          }
        }

        for (const result of webResults) {
          let title = readString(result, "title").trim();
          const url = readString(result, "url").trim();
          if (!title || !url) continue;
          let summary = readString(result, "description") || title;
          if (!containsChinese(title) && !containsChinese(summary)) {
            if (section.requireChinese !== false) continue;
            if (!options.translationConfig) {
              if (!warnedMissingTranslation) {
                console.warn("Skipped non-Chinese results because DAILY_NEWS_TRANSLATION_* is not fully configured.");
                warnedMissingTranslation = true;
              }
              continue;
            }

            const translated = await translateNewsText({ title, summary }, options.translationConfig);
            title = translated.title;
            summary = translated.summary;
            if (!containsChinese(title) && !containsChinese(summary)) continue;
          }

          const publishedAt = extractDate(result) ?? inferPublishedDateFromUrl(url);

          items.push({
            id: `${source.source_id}-${hashId(url)}`,
            title,
            url,
            sourceId: source.source_id,
            sourceName: source.name,
            language: source.language,
            region: source.countryOrRegion,
            categories: section.categories,
            primaryCategory: section.primaryCategory,
            summary,
            publishedAt,
            extractedAt: new Date().toISOString(),
            mayHavePaywall: source.mayHavePaywall,
          });
        }
      } catch (error) {
        if (isKeylessLimitError(error)) {
          console.warn(`Firecrawl keyless unavailable after ${source.name} ${section.label}; switching to direct source fetch.`);
          return [];
        }
        console.warn(`Skipped ${source.name} ${section.label}: ${String(error)}`);
      }
    }
  }

  return items;
}

function isKeylessLimitError(error: unknown): boolean {
  const message = String(error).toLowerCase();
  return (
    message.includes("insufficient credits") ||
    message.includes("rate limit") ||
    message.includes("too many requests") ||
    message.includes("payment required") ||
    message.includes("http 402") ||
    message.includes("http 429")
  );
}

function selectNewsSources(maxSources: number): NewsSource[] {
  const enabledSources = newsSources.filter((source) => source.enabled);
  if (maxSources >= enabledSources.length) return enabledSources;

  const prioritySourceIds = [
    "xinhua",
    "cnn",
    "cctv",
    "chinanews",
    "ap",
    "bbc",
    "aljazeera",
    "npr",
    "36kr",
    "tmtpost",
    "jiqizhixin",
    "qbitai",
    "techcrunch",
  ];
  const selected: NewsSource[] = [];

  for (const sourceId of prioritySourceIds) {
    if (selected.length >= maxSources) break;
    const source = enabledSources.find((candidate) => candidate.source_id === sourceId);
    if (!source) continue;
    selected.push(source);
  }

  for (const source of enabledSources) {
    if (selected.length >= maxSources) break;
    if (selected.some((selectedSource) => selectedSource.source_id === source.source_id)) continue;
    selected.push(source);
  }

  return selected;
}

async function fetchDirectSources(
  options: { limitPerSection: number; maxSources: number; translationConfig?: TranslationConfig },
): Promise<RawNewsItem[]> {
  const items: RawNewsItem[] = [];
  const enabledSources = selectNewsSources(options.maxSources);
  let warnedMissingTranslation = false;

  for (const source of enabledSources) {
    for (const section of source.sections) {
      try {
        const html = await fetchText(section.url);
        const candidates = readDirectCandidates(html, section.url).slice(0, options.limitPerSection * 2);
        let accepted = 0;

        for (const candidate of candidates) {
          if (accepted >= options.limitPerSection) break;
          let title = candidate.title.trim();
          const url = candidate.url.trim();
          if (!title || !url) continue;
          let summary = candidate.summary || title;

          if (!containsChinese(title) && !containsChinese(summary)) {
            if (section.requireChinese !== false) continue;
            if (!options.translationConfig) {
              if (!warnedMissingTranslation) {
                console.warn("Skipped direct non-Chinese results because DAILY_NEWS_TRANSLATION_* is not fully configured.");
                warnedMissingTranslation = true;
              }
              continue;
            }

            const translated = await translateNewsText({ title, summary }, options.translationConfig);
            title = translated.title;
            summary = translated.summary;
            if (!containsChinese(title) && !containsChinese(summary)) continue;
          }

          const publishedAt = candidate.publishedAt ?? inferPublishedDateFromUrl(url);

          items.push({
            id: `${source.source_id}-direct-${hashId(url)}`,
            title,
            url,
            sourceId: source.source_id,
            sourceName: source.name,
            language: source.language,
            region: source.countryOrRegion,
            categories: section.categories,
            primaryCategory: section.primaryCategory,
            summary,
            publishedAt,
            extractedAt: new Date().toISOString(),
            mayHavePaywall: source.mayHavePaywall,
          });
          accepted += 1;
        }
      } catch (error) {
        console.warn(`Direct source skipped ${source.name} ${section.label}: ${String(error)}`);
      }
    }
  }

  return items;
}

async function fetchText(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(url, {
      headers: {
        accept: "text/html, application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8",
        "user-agent": "DailyNewsBot/0.1 (+https://localhost)",
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function readDirectCandidates(html: string, baseUrl: string): Array<{ title: string; url: string; summary: string; publishedAt?: string }> {
  const feedItems = readFeedCandidates(html, baseUrl);
  if (feedItems.length > 0) return feedItems;
  return readHtmlLinkCandidates(html, baseUrl);
}

function readFeedCandidates(html: string, baseUrl: string): Array<{ title: string; url: string; summary: string; publishedAt?: string }> {
  const blocks = [...html.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)].map((match) => match[0]);
  const candidates: Array<{ title: string; url: string; summary: string; publishedAt?: string }> = [];
  for (const block of blocks) {
    const title = cleanText(readTag(block, "title"));
    const rawLink = readTag(block, "link") || readLinkHref(block);
    const url = resolveCandidateUrl(rawLink, baseUrl);
    const summary = cleanText(readTag(block, "description") || readTag(block, "summary") || readTag(block, "content"));
    const publishedAt = readPublishedDate(readTag(block, "pubDate") || readTag(block, "published") || readTag(block, "updated"));
    if (title && url) candidates.push({ title, url, summary: summary || title, publishedAt });
  }
  return uniqueCandidates(candidates);
}

function readHtmlLinkCandidates(html: string, baseUrl: string): Array<{ title: string; url: string; summary: string; publishedAt?: string }> {
  const baseHost = hostnameFromUrl(baseUrl);
  const candidates: Array<{ title: string; url: string; summary: string; publishedAt?: string }> = [];
  const anchorPattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchorPattern)) {
    const url = resolveCandidateUrl(match[1], baseUrl);
    const title = cleanText(match[2]);
    if (!url || !title || title.length < 8) continue;
    if (baseHost && hostnameFromUrl(url) !== baseHost) continue;
    if (!isLikelyArticleUrl(url)) continue;
    if (/\.(jpg|jpeg|png|gif|webp|svg|pdf|zip)(\?|$)/i.test(url)) continue;
    if (url === baseUrl || url.endsWith("#")) continue;
    candidates.push({ title, url, summary: title, publishedAt: inferPublishedDateFromUrl(url) });
  }
  return uniqueCandidates(candidates);
}

function isLikelyArticleUrl(url: string): boolean {
  const path = new URL(url).pathname.toLowerCase();
  return (
    /\/(20\d{2}|n1|n2|article|articles|news|gn|gj|cj|sh|politics|finance|companies|tech|world)\b/.test(path) ||
    /\/20\d{6,8}\//.test(path) ||
    /\/\d{6,}\.(html|shtml)$/.test(path) ||
    /\/[a-f0-9]{20,}\/c\.html$/.test(path)
  );
}

function readTag(value: string, tagName: string): string {
  const match = value.match(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i"));
  return match?.[1] ?? "";
}

function readLinkHref(value: string): string {
  const match = value.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
  return match?.[1] ?? "";
}

function resolveCandidateUrl(value: string, baseUrl: string): string {
  const trimmed = decodeHtml(value).trim();
  if (!trimmed || /^(javascript:|mailto:|tel:)/i.test(trimmed)) return "";
  try {
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return "";
  }
}

function readPublishedDate(value: string): string | undefined {
  const cleaned = cleanText(value);
  return cleaned && Number.isFinite(Date.parse(cleaned)) ? new Date(cleaned).toISOString() : undefined;
}

function cleanText(value: string): string {
  return decodeHtml(value)
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCharCode(Number.parseInt(code, 16)));
}

function uniqueCandidates<T extends { url: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  });
}

function containsChinese(value: string): boolean {
  return /[\u4e00-\u9fff]/.test(value);
}

function readSearchResults(results: unknown, preferredSources: SearchSourceType[]): unknown[] {
  if (!results || typeof results !== "object") {
    return [];
  }
  const record = results as Record<string, unknown>;
  for (const source of preferredSources) {
    if (Array.isArray(record[source])) return record[source];
  }
  if (Array.isArray(record.data)) return record.data;
  if (Array.isArray(record.news)) return record.news;
  if (Array.isArray(record.web)) return record.web;
  return [];
}

function buildQueries(sourceName: string, section: SourceSection): string[] {
  const terms = section.searchTerms && section.searchTerms.length > 0 ? section.searchTerms : [`${sourceName} ${section.label}`];
  return terms.map((term) => buildQuery(term));
}

function buildQuery(term: string): string {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  return `${term} ${today}`;
}

function extractDate(result: unknown): string | undefined {
  const possibleDate =
    readString(result, "publishedDate") || readString(result, "date") || readString(result, "publishedAt");
  return typeof possibleDate === "string" && Number.isFinite(Date.parse(possibleDate)) ? possibleDate : undefined;
}

export function inferPublishedDateFromUrl(url: string): string | undefined {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return undefined;
  }

  const patterns = [
    /\/(20\d{2})\/(\d{2})-(\d{2})(?:\/|$)/,
    /\/(20\d{2})\/(\d{2})(\d{2})(?:\/|[-_.])/,
    /(?:\/|-)(20\d{2})-(\d{2})-(\d{2})(?:\/|$)/,
    /\/(20\d{2})(\d{2})(\d{2})(?:\/|[-_.])/,
  ];

  for (const pattern of patterns) {
    const match = path.match(pattern);
    if (!match) continue;
    const isoDate = chinaLocalDateToIso(match[1], match[2], match[3]);
    if (isoDate) return isoDate;
  }

  return undefined;
}

function chinaLocalDateToIso(yearValue: string, monthValue: string, dayValue: string): string | undefined {
  const year = Number(yearValue);
  const month = Number(monthValue);
  const day = Number(dayValue);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return undefined;
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;

  const utcDate = new Date(Date.UTC(year, month - 1, day));
  if (utcDate.getUTCFullYear() !== year || utcDate.getUTCMonth() !== month - 1 || utcDate.getUTCDate() !== day) {
    return undefined;
  }

  return new Date(`${yearValue}-${monthValue}-${dayValue}T00:00:00+08:00`).toISOString();
}

function readString(value: unknown, key: string): string {
  if (!value || typeof value !== "object") {
    return "";
  }
  const record = value as Record<string, unknown>;
  return typeof record[key] === "string" ? record[key] : "";
}

function hashId(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function readTranslationConfig(): TranslationConfig | undefined {
  const apiKey = process.env.DAILY_NEWS_TRANSLATION_API_KEY;
  const baseUrl = process.env.DAILY_NEWS_TRANSLATION_BASE_URL;
  const model = process.env.DAILY_NEWS_TRANSLATION_MODEL;
  if (!apiKey || !baseUrl || !model) return undefined;
  return { apiKey, baseUrl, model };
}

async function translateNewsText(
  text: { title: string; summary: string },
  config: TranslationConfig,
): Promise<{ title: string; summary: string }> {
  const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        {
          role: "system",
          content:
            "你是新闻编辑。把英文新闻标题和摘要改写为简洁中文，保留事实、人物、机构、赛事和数字，不添加原文没有的信息。只返回 JSON。",
        },
        {
          role: "user",
          content: JSON.stringify(text),
        },
      ],
      temperature: 0.2,
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    throw new Error(`Translation request failed with status ${response.status}`);
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const content = readAssistantContent(payload);
  const parsed = JSON.parse(content) as Partial<{ title: string; summary: string }>;
  return {
    title: typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim() : text.title,
    summary: typeof parsed.summary === "string" && parsed.summary.trim() ? parsed.summary.trim() : text.summary,
  };
}

function readAssistantContent(payload: Record<string, unknown>): string {
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const first = choices[0];
  if (!first || typeof first !== "object") return "{}";
  const message = (first as Record<string, unknown>).message;
  if (!message || typeof message !== "object") return "{}";
  const content = (message as Record<string, unknown>).content;
  return typeof content === "string" ? content : "{}";
}
