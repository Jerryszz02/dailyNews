import { existsSync, readFileSync } from "node:fs";
import { Firecrawl } from "firecrawl";
import { defaultPreferences } from "../src/config/preferences.js";
import { newsSources } from "../src/config/sources.js";
import { firecrawlSnapshotNews } from "../src/data/firecrawlSnapshot.js";
import { buildDailyReport } from "../src/lib/newsPipeline.js";
import { hostnameFromUrl } from "../src/lib/text.js";
import type { Category, DailyNewsReport, NewsSource, RawNewsItem, SearchSourceType, SourceSection } from "../src/types";

export const defaultLimitPerSection = 5;
export const defaultMaxSources = newsSources.filter((source) => source.enabled).length;
export const defaultRefreshIntervalMinutes = 15;
export const defaultMaxNewsAgeHours = 72;

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

interface NewsText {
  title: string;
  summary: string;
}

interface NewsTextForDisplayOptions extends NewsText {
  url: string;
  allowTranslation: boolean;
  translationConfig?: TranslationConfig;
}

const defaultTranslationBaseUrl = "https://api.deepseek.com";
const defaultTranslationModel = "deepseek-v4-flash";
const maxArticleContextLength = 3_200;

export async function generateDailyNewsReport(options: NewsGenerationOptions = {}): Promise<NewsGenerationResult> {
  loadLocalEnv();
  const limitPerSection = options.limitPerSection ?? readPositiveInteger("DAILY_NEWS_LIMIT_PER_SECTION", defaultLimitPerSection);
  const maxSources = options.maxSources ?? readPositiveInteger("DAILY_NEWS_MAX_SOURCES", defaultMaxSources);
  const now = options.now ?? new Date();
  const maxNewsAgeHours = readPositiveInteger("DAILY_NEWS_MAX_AGE_HOURS", defaultMaxNewsAgeHours);
  const translationConfig = readTranslationConfig();
  const fetchedItems = await fetchWithFirecrawlKeyless({ limitPerSection, maxSources, translationConfig });
  const directItems =
    fetchedItems.length > 0 ? [] : await fetchDirectSources({ limitPerSection, maxSources, translationConfig });
  const liveItems = fetchedItems.length > 0 ? fetchedItems : directItems;
  const fallbackItems = readGeneratedFallbackItems();
  const recentLiveItems = filterRecentItems(liveItems, now, maxNewsAgeHours);
  const rawItems = liveItems.length > 0 ? recentLiveItems : fallbackItems;
  const report = buildDailyReport(rawItems, defaultPreferences, now);
  const usedLiveData = liveItems.length > 0;

  return {
    report,
    mode: fetchedItems.length > 0 ? "Firecrawl keyless" : directItems.length > 0 ? "Direct source fetch" : "Firecrawl snapshot",
    rawItemCount: rawItems.length,
    usedLiveData,
  };
}

function filterRecentItems(items: RawNewsItem[], now: Date, maxAgeHours: number): RawNewsItem[] {
  const maxAgeMs = maxAgeHours * 3_600_000;
  return items.filter((item) => {
    if (!item.publishedAt) return false;
    const publishedAt = Date.parse(item.publishedAt);
    if (!Number.isFinite(publishedAt)) return false;
    const ageMs = now.getTime() - publishedAt;
    return ageMs >= 0 && ageMs <= maxAgeMs;
  });
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
          const preparedText = await prepareNewsTextForDisplay({
            title,
            summary,
            url,
            allowTranslation: section.requireChinese === false,
            translationConfig: options.translationConfig,
          });
          if (!preparedText) {
            if (isNonChineseText({ title, summary }) && section.requireChinese === false && !options.translationConfig) {
              if (!warnedMissingTranslation) {
                console.warn("Skipped non-Chinese results because DAILY_NEWS_TRANSLATION_API_KEY is not configured.");
                warnedMissingTranslation = true;
              }
            }
            continue;
          }
          title = preparedText.title;
          summary = preparedText.summary;

          const publishedAt = await resolvePublishedAt(url, extractDate(result));
          if (!publishedAt) continue;
          const primaryCategory = inferPrimaryCategory({ title, summary, url }, section);
          const categories = uniqueValues([primaryCategory, ...section.categories]);

          items.push({
            id: `${source.source_id}-${hashId(url)}`,
            title,
            url,
            sourceId: source.source_id,
            sourceName: source.name,
            language: source.language,
            region: source.countryOrRegion,
            categories,
            primaryCategory,
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

          const preparedText = await prepareNewsTextForDisplay({
            title,
            summary,
            url,
            allowTranslation: section.requireChinese === false,
            translationConfig: options.translationConfig,
          });
          if (!preparedText) {
            if (isNonChineseText({ title, summary }) && section.requireChinese === false && !options.translationConfig) {
              if (!warnedMissingTranslation) {
                console.warn("Skipped direct non-Chinese results because DAILY_NEWS_TRANSLATION_API_KEY is not configured.");
                warnedMissingTranslation = true;
              }
            }
            continue;
          }
          title = preparedText.title;
          summary = preparedText.summary;

          const publishedAt = await resolvePublishedAt(url, candidate.publishedAt);
          if (!publishedAt) continue;
          const primaryCategory = inferPrimaryCategory({ title, summary, url }, section);
          const categories = uniqueValues([primaryCategory, ...section.categories]);

          items.push({
            id: `${source.source_id}-direct-${hashId(url)}`,
            title,
            url,
            sourceId: source.source_id,
            sourceName: source.name,
            language: source.language,
            region: source.countryOrRegion,
            categories,
            primaryCategory,
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

export async function prepareNewsTextForDisplay(options: NewsTextForDisplayOptions): Promise<NewsText | null> {
  const nonChinese = isNonChineseText(options);
  if (nonChinese) {
    if (!options.allowTranslation || !options.translationConfig) return null;

    try {
      const articleContext = await readArticleSummaryContext(options.url);
      const translated = await translateNewsText({ title: options.title, summary: options.summary, articleContext }, options.translationConfig);
      if (isNonChineseText(translated) || needsSummaryRepair(translated.title, translated.summary)) return null;
      return translated;
    } catch (error) {
      console.warn(`Skipped non-Chinese result after translation failed: ${String(error)}`);
      return null;
    }
  }

  if (!options.translationConfig || !needsSummaryRepair(options.title, options.summary)) {
    return { title: options.title, summary: options.summary };
  }

  const articleContext = await readArticleSummaryContext(options.url);
  try {
    const enriched = await translateNewsText({ title: options.title, summary: options.summary, articleContext }, options.translationConfig);
    if (containsChinese(enriched.summary) && !needsSummaryRepair(options.title, enriched.summary)) {
      return { title: options.title, summary: enriched.summary };
    }
  } catch (error) {
    console.warn(`Kept original summary after enrichment failed: ${String(error)}`);
  }

  const fallbackSummary = buildSummaryFromArticleContext(options.title, articleContext);
  if (fallbackSummary) {
    return { title: options.title, summary: fallbackSummary };
  }

  return { title: options.title, summary: buildMinimalSummary(options.title) };
}

function isNonChineseText(text: NewsText): boolean {
  return !containsChinese(text.title) && !containsChinese(text.summary);
}

function needsSummaryRepair(title: string, summary: string): boolean {
  const normalizedTitle = normalizeForComparison(title);
  const normalizedSummary = normalizeForComparison(summary);
  return !normalizedSummary || normalizedTitle === normalizedSummary;
}

function normalizeForComparison(value: string): string {
  return value.replace(/\s+/g, "").trim().toLowerCase();
}

function buildSummaryFromArticleContext(title: string, articleContext?: string): string | undefined {
  if (!articleContext || !containsChinese(articleContext)) return undefined;
  const cleaned = articleContext
    .split(/\n+/)
    .map((line) => cleanText(line))
    .find((line) => line.length >= 30 && !needsSummaryRepair(title, line));
  if (!cleaned) return undefined;
  return cleaned.length > 120 ? `${cleaned.slice(0, 118)}...` : cleaned;
}

function buildMinimalSummary(title: string): string {
  return `相关报道聚焦“${title}”，具体背景、影响和后续进展以原文披露为准。`;
}

async function readArticleSummaryContext(url: string): Promise<string | undefined> {
  try {
    return extractArticleSummaryContext(await fetchText(url));
  } catch {
    return undefined;
  }
}

export function extractArticleSummaryContext(html: string): string | undefined {
  const values = uniqueValues([...readMetaDescriptions(html), ...readJsonLdText(html), ...readParagraphText(html)]);
  const context = values.join("\n").slice(0, maxArticleContextLength).trim();
  return context || undefined;
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
    const rawTitle = cleanText(match[2]);
    const publishedAt = parsePublishedDate(rawTitle);
    const title = removeTrailingPublishedDate(rawTitle);
    if (!url || !title || title.length < 8) continue;
    if (baseHost && hostnameFromUrl(url) !== baseHost) continue;
    if (!isLikelyArticleUrl(url)) continue;
    if (/\.(jpg|jpeg|png|gif|webp|svg|pdf|zip)(\?|$)/i.test(url)) continue;
    if (url === baseUrl || url.endsWith("#")) continue;
    candidates.push({ title, url, summary: title, publishedAt });
  }
  return uniqueCandidates(candidates);
}

function removeTrailingPublishedDate(value: string): string {
  return value
    .replace(/\s+20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}(?:日)?(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?\s*$/, "")
    .trim();
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
  return parsePublishedDate(cleaned);
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

function uniqueValues<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

async function resolvePublishedAt(url: string, candidateDate?: string): Promise<string | undefined> {
  const parsedCandidate = parsePublishedDate(candidateDate);
  if (parsedCandidate) return parsedCandidate;

  const articleDate = await readArticlePublishedAt(url);
  if (articleDate) return articleDate;

  return inferPublishedDateFromUrl(url);
}

async function readArticlePublishedAt(url: string): Promise<string | undefined> {
  try {
    const html = await fetchText(url);
    return extractPublishedDateFromHtml(html);
  } catch {
    return undefined;
  }
}

export function extractPublishedDateFromHtml(html: string): string | undefined {
  const candidates = [
    ...readInlineDates(html),
    ...readTimeTagDates(html),
    ...readJsonLdDates(html),
    ...readMetaDates(html),
  ].sort((left, right) => Number(hasClockTime(right)) - Number(hasClockTime(left)));

  for (const candidate of candidates) {
    const publishedAt = parsePublishedDate(candidate);
    if (publishedAt) return publishedAt;
  }

  return undefined;
}

function readMetaDescriptions(html: string): string[] {
  const values: string[] = [];
  const metaPattern = /<meta\b[^>]*>/gi;
  for (const match of html.matchAll(metaPattern)) {
    const tag = match[0];
    const key = readAttribute(tag, "property") || readAttribute(tag, "name") || readAttribute(tag, "itemprop");
    if (!isDescriptionMetaKey(key)) continue;
    const content = cleanText(readAttribute(tag, "content"));
    if (content) values.push(content);
  }
  return values;
}

function readJsonLdText(html: string): string[] {
  const values: string[] = [];
  const scriptPattern = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(scriptPattern)) {
    const rawJson = match[1].trim();
    try {
      collectJsonTextValues(JSON.parse(rawJson), values);
    } catch {
      for (const textMatch of rawJson.matchAll(/"(?:description|articleBody)"\s*:\s*"([^"]{40,})"/gi)) {
        values.push(cleanText(textMatch[1]));
      }
    }
  }
  return values.filter(Boolean);
}

function collectJsonTextValues(value: unknown, values: string[]) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectJsonTextValues(item, values);
    return;
  }

  const record = value as Record<string, unknown>;
  for (const key of ["description", "articleBody"]) {
    const text = record[key];
    if (typeof text === "string" && cleanText(text).length >= 40) {
      values.push(cleanText(text));
    }
  }
  for (const item of Object.values(record)) collectJsonTextValues(item, values);
}

function readParagraphText(html: string): string[] {
  const values: string[] = [];
  const paragraphPattern = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
  for (const match of html.matchAll(paragraphPattern)) {
    const text = cleanText(match[1]);
    if (text.length < 40) continue;
    if (isBoilerplateParagraph(text)) continue;
    values.push(text);
    if (values.join("\n").length >= maxArticleContextLength) break;
  }
  return values;
}

function isBoilerplateParagraph(value: string): boolean {
  return /责任编辑|版权|Copyright|广告|声明|二维码|分享到|举报/.test(value);
}

function readMetaDates(html: string): string[] {
  const values: string[] = [];
  const metaPattern = /<meta\b[^>]*>/gi;
  for (const match of html.matchAll(metaPattern)) {
    const tag = match[0];
    const key = readAttribute(tag, "property") || readAttribute(tag, "name") || readAttribute(tag, "itemprop");
    if (!isDateMetaKey(key)) continue;
    const content = readAttribute(tag, "content");
    if (content) values.push(content);
  }
  return values;
}

function readJsonLdDates(html: string): string[] {
  const values: string[] = [];
  const scriptPattern = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(scriptPattern)) {
    const text = cleanText(match[1]);
    values.push(...readJsonDateValues(text));
  }
  return values;
}

function readJsonDateValues(value: string): string[] {
  const values: string[] = [];
  try {
    collectJsonDateValues(JSON.parse(value), values);
  } catch {
    for (const match of value.matchAll(/"date(?:Published|Created|Modified)"\s*:\s*"([^"]+)"/gi)) {
      values.push(match[1]);
    }
  }
  return values;
}

function collectJsonDateValues(value: unknown, values: string[]) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectJsonDateValues(item, values);
    return;
  }

  const record = value as Record<string, unknown>;
  for (const key of ["datePublished", "dateCreated", "dateModified"]) {
    if (typeof record[key] === "string") values.push(record[key]);
  }
  for (const item of Object.values(record)) collectJsonDateValues(item, values);
}

function readTimeTagDates(html: string): string[] {
  const values: string[] = [];
  const timePattern = /<time\b[^>]*>([\s\S]*?)<\/time>/gi;
  for (const match of html.matchAll(timePattern)) {
    const tag = match[0];
    const datetime = readAttribute(tag, "datetime");
    if (datetime) values.push(datetime);
    const text = cleanText(match[1]);
    if (text) values.push(text);
  }
  return values;
}

function readInlineDates(html: string): string[] {
  const text = cleanText(html);
  const values: string[] = [];
  const splitDate = readSplitHeaderDate(html);
  if (splitDate) values.push(splitDate);

  const patterns = [
    /var\s+publishDate\s*=\s*["']\s*(20\d{12})\s*["']/g,
    /(?:发布时间|发表时间|更新时间|发布日期|发布于|时间)[:：\s]*(20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}(?:日)?(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?)/g,
    /(20\d{2}年\d{1,2}月\d{1,2}日\s+\d{1,2}:\d{2}(?::\d{2})?)/g,
    /\b(20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?)\b/g,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      values.push(match[1]);
    }
  }

  for (const match of text.matchAll(/\b(20\d{2})\s+(\d{1,2})\s*\/\s*(\d{1,2})\s+(\d{1,2}:\d{2}(?::\d{2})?)\b/g)) {
    values.push(`${match[1]}-${match[2]}-${match[3]} ${match[4]}`);
  }
  return values;
}

function readSplitHeaderDate(html: string): string | undefined {
  const year = html.match(/class=["'][^"']*year[^"']*["'][^>]*>\s*<em>\s*(20\d{2})\s*<\/em>/i)?.[1];
  const day = html.match(/class=["'][^"']*day[^"']*["'][^>]*>\s*<em>\s*(\d{1,2})\s*<\/em>\s*\/\s*<em>\s*(\d{1,2})\s*<\/em>/i);
  const time = html.match(/class=["'][^"']*time[^"']*["'][^>]*>\s*(\d{1,2}:\d{2}(?::\d{2})?)/i)?.[1];
  return year && day && time ? `${year}-${day[1]}-${day[2]} ${time}` : undefined;
}

function hasClockTime(value: string): boolean {
  return /\d{1,2}:\d{2}/.test(value) || /\b20\d{12}\b/.test(value);
}

function readAttribute(tag: string, name: string): string {
  const pattern = new RegExp(`\\b${name}=["']([^"']+)["']`, "i");
  return decodeHtml(tag.match(pattern)?.[1] ?? "").trim();
}

function isDateMetaKey(value: string): boolean {
  return /(^|:|_)(published_time|publishdate|pubdate|datepublished|datecreated|publish_time|pubtime|date|createdate|article_date)$/i.test(
    value.replace(/[-.]/g, "_"),
  );
}

function isDescriptionMetaKey(value: string): boolean {
  return /(^|:|_)(description|og_description|twitter_description)$/i.test(value.replace(/[-.]/g, "_"));
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
    readString(result, "publishedDate") ||
    readString(result, "date") ||
    readString(result, "publishedAt") ||
    readNestedString(result, ["metadata", "publishedDate"]) ||
    readNestedString(result, ["metadata", "publishedAt"]) ||
    readNestedString(result, ["metadata", "date"]);
  return parsePublishedDate(possibleDate);
}

export function parsePublishedDate(value?: string): string | undefined {
  const cleaned = cleanText(value ?? "");
  if (!cleaned) return undefined;

  if (hasExplicitTimezone(cleaned)) {
    const timestamp = Date.parse(cleaned);
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
  }

  const chinaDateTime = cleaned.match(
    /(20\d{2})\s*[年/.-]\s*(\d{1,2})\s*[月/.-]\s*(\d{1,2})(?:\s*日)?(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/,
  );
  if (chinaDateTime) {
    return chinaLocalDateTimeToIso(
      chinaDateTime[1],
      chinaDateTime[2],
      chinaDateTime[3],
      chinaDateTime[4] ?? "00",
      chinaDateTime[5] ?? "00",
      chinaDateTime[6] ?? "00",
    );
  }

  const compactDateTime = cleaned.match(/\b(20\d{2})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2})|[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?\b/);
  if (compactDateTime) {
    return chinaLocalDateTimeToIso(
      compactDateTime[1],
      compactDateTime[2],
      compactDateTime[3],
      compactDateTime[4] ?? compactDateTime[7] ?? "00",
      compactDateTime[5] ?? compactDateTime[8] ?? "00",
      compactDateTime[6] ?? compactDateTime[9] ?? "00",
    );
  }

  const timestamp = Date.parse(cleaned);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function hasExplicitTimezone(value: string): boolean {
  return /\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})\b/i.test(value) || /\b(?:GMT|UTC)\b/i.test(value);
}

export function inferPublishedDateFromUrl(url: string): string | undefined {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return undefined;
  }

  const patterns = [
    /\/(20\d{2})\/(\d{2})\/(\d{2})(?:\/|$)/,
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

  const compactDate = url.match(/[?&][^=]*=(20\d{2})(\d{2})(\d{2})/);
  if (compactDate) {
    const isoDate = chinaLocalDateToIso(compactDate[1], compactDate[2], compactDate[3]);
    if (isoDate) return isoDate;
  }

  return undefined;
}

function chinaLocalDateToIso(yearValue: string, monthValue: string, dayValue: string): string | undefined {
  return chinaLocalDateTimeToIso(yearValue, monthValue, dayValue, "00", "00", "00");
}

function chinaLocalDateTimeToIso(
  yearValue: string,
  monthValue: string,
  dayValue: string,
  hourValue: string,
  minuteValue: string,
  secondValue: string,
): string | undefined {
  const year = Number(yearValue);
  const month = Number(monthValue);
  const day = Number(dayValue);
  const hour = Number(hourValue);
  const minute = Number(minuteValue);
  const second = Number(secondValue);
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    !Number.isInteger(second)
  ) {
    return undefined;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return undefined;

  const utcDate = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    utcDate.getUTCFullYear() !== year ||
    utcDate.getUTCMonth() !== month - 1 ||
    utcDate.getUTCDate() !== day ||
    utcDate.getUTCHours() !== hour ||
    utcDate.getUTCMinutes() !== minute ||
    utcDate.getUTCSeconds() !== second
  ) {
    return undefined;
  }

  return new Date(
    `${yearValue.padStart(4, "0")}-${monthValue.padStart(2, "0")}-${dayValue.padStart(2, "0")}T${hourValue.padStart(2, "0")}:${minuteValue.padStart(2, "0")}:${secondValue.padStart(2, "0")}+08:00`,
  ).toISOString();
}

function readString(value: unknown, key: string): string {
  if (!value || typeof value !== "object") {
    return "";
  }
  const record = value as Record<string, unknown>;
  return typeof record[key] === "string" ? record[key] : "";
}

function readNestedString(value: unknown, path: string[]): string {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object") return "";
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" ? current : "";
}

const categorySignals: Record<Category, { keywords: string[]; url: RegExp[] }> = {
  ai: {
    keywords: ["ai", "artificial intelligence", "openai", "anthropic", "claude", "chatgpt", "大模型", "人工智能", "机器学习"],
    url: [/\/ai\b/i, /artificial-intelligence/i],
  },
  technology: {
    keywords: ["technology", "tech", "startup", "software", "chip", "semiconductor", "科技", "芯片", "软件", "互联网", "创业"],
    url: [/\/tech(?:nology)?\b/i, /\/it\b/i],
  },
  finance: {
    keywords: ["market", "stock", "bank", "finance", "economy", "inflation", "财经", "金融", "市场", "经济", "央行", "股票", "公司"],
    url: [/\/finance\b/i, /\/business\b/i, /\/cj\//i, /\/money\//i],
  },
  international: {
    keywords: ["world", "global", "war", "conflict", "diplomacy", "国际", "全球", "外交", "战争", "冲突", "联合国"],
    url: [/\/world\b/i, /\/international\b/i, /\/gj\//i],
  },
  china: {
    keywords: ["china", "chinese", "beijing", "中国", "国内", "北京", "全国"],
    url: [/\/china\b/i, /\/gn\//i],
  },
  policy: {
    keywords: ["policy", "regulation", "government", "election", "law", "政策", "监管", "政府", "选举", "法律", "部门"],
    url: [/\/politics\b/i, /\/policy\b/i],
  },
  society: {
    keywords: ["society", "city", "education", "health", "社会", "教育", "健康", "城市", "民生"],
    url: [/\/society\b/i, /\/sh\//i, /\/edu\//i, /\/health\//i],
  },
  sports: {
    keywords: ["nba", "fifa", "fiba", "basketball", "football", "soccer", "sport", "体育", "篮球", "足球", "赛事", "锦标赛"],
    url: [/\/sports?\b/i, /\/nba\b/i, /\/football\b/i, /\/basketball\b/i],
  },
  entertainment: {
    keywords: ["film", "movie", "tv", "music", "entertainment", "电影", "影视", "娱乐", "音乐", "剧集"],
    url: [/\/entertainment\b/i, /\/culture\b/i, /\/film\b/i, /\/movie\b/i],
  },
  science: {
    keywords: ["science", "research", "study", "space", "physics", "科学", "研究", "太空", "航天", "行星"],
    url: [/\/science\b/i, /\/space\b/i],
  },
};

const categoryTieBreak: Category[] = [
  "sports",
  "ai",
  "science",
  "technology",
  "finance",
  "international",
  "policy",
  "china",
  "society",
  "entertainment",
];

export function inferPrimaryCategory(
  item: { title: string; summary: string; url: string },
  section: Pick<SourceSection, "categories" | "primaryCategory">,
): Category {
  const scores = new Map<Category, number>();
  scores.set(section.primaryCategory, 4);
  for (const category of section.categories) {
    scores.set(category, (scores.get(category) ?? 0) + 2);
  }

  const text = normalizeForCategory(`${item.title} ${item.summary}`);
  const url = item.url.toLowerCase();
  for (const [category, signals] of Object.entries(categorySignals) as Array<[Category, (typeof categorySignals)[Category]]>) {
    const keywordHits = signals.keywords.filter((keyword) => text.includes(normalizeForCategory(keyword))).length;
    const urlHits = signals.url.filter((pattern) => pattern.test(url)).length;
    scores.set(category, (scores.get(category) ?? 0) + keywordHits * 3 + urlHits * 8);
  }

  return [...scores.entries()].sort((left, right) => {
    const scoreDelta = right[1] - left[1];
    if (scoreDelta !== 0) return scoreDelta;
    return categoryTieBreak.indexOf(left[0]) - categoryTieBreak.indexOf(right[0]);
  })[0]?.[0] ?? section.primaryCategory;
}

function normalizeForCategory(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function hashId(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

export function readTranslationConfig(): TranslationConfig | undefined {
  const apiKey = process.env.DAILY_NEWS_TRANSLATION_API_KEY?.trim();
  const baseUrl = process.env.DAILY_NEWS_TRANSLATION_BASE_URL?.trim() || defaultTranslationBaseUrl;
  const model = process.env.DAILY_NEWS_TRANSLATION_MODEL?.trim() || defaultTranslationModel;
  if (!apiKey) return undefined;
  return { apiKey, baseUrl, model };
}

export async function translateNewsText(
  text: { title: string; summary: string; articleContext?: string },
  config: TranslationConfig,
): Promise<{ title: string; summary: string }> {
  const body = {
    model: config.model,
    messages: [
      {
        role: "system",
        content:
          "你是中文新闻编辑。把新闻标题改写为简洁中文，并把摘要写成中文全文概述。保留事实、人物、机构、赛事、地点和数字，不添加素材没有的信息。只输出合法 JSON，格式为 {\"title\":\"中文标题\",\"summary\":\"中文概述\"}。",
      },
      {
        role: "user",
        content: `请基于以下新闻素材输出 JSON：${JSON.stringify(text)}`,
      },
    ],
    temperature: 0.2,
    max_tokens: 600,
    response_format: { type: "json_object" },
    ...(isDeepSeekConfig(config) ? { thinking: { type: "disabled" } } : {}),
  };

  const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Translation request failed with status ${response.status}`);
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const content = readAssistantContent(payload);
  const parsed = readTranslationJson(content);
  return {
    title: typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim() : text.title,
    summary: typeof parsed.summary === "string" && parsed.summary.trim() ? parsed.summary.trim() : text.summary,
  };
}

function isDeepSeekConfig(config: TranslationConfig): boolean {
  return config.baseUrl.includes("api.deepseek.com") || config.model.startsWith("deepseek-");
}

function readTranslationJson(content: string): Partial<{ title: string; summary: string }> {
  try {
    return JSON.parse(content) as Partial<{ title: string; summary: string }>;
  } catch {
    throw new Error("Translation response was not valid JSON");
  }
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
