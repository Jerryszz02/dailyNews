import { existsSync, readFileSync } from "node:fs";
import { Firecrawl } from "firecrawl";
import { defaultPreferences } from "../src/config/preferences";
import { newsSources } from "../src/config/sources";
import { firecrawlSnapshotNews } from "../src/data/firecrawlSnapshot";
import { sampleNews } from "../src/data/sampleNews";
import { buildDailyReport } from "../src/lib/newsPipeline";
import { hostnameFromUrl } from "../src/lib/text";
import type { DailyNewsReport, RawNewsItem, SourceSection } from "../src/types";

export const defaultLimitPerSection = 5;
export const defaultMaxSources = 20;
export const defaultRefreshIntervalMinutes = 15;

export interface NewsGenerationOptions {
  apiKey?: string;
  limitPerSection?: number;
  maxSources?: number;
  now?: Date;
}

export interface NewsGenerationResult {
  report: DailyNewsReport;
  mode: "Firecrawl API" | "Firecrawl snapshot";
  rawItemCount: number;
}

export async function generateDailyNewsReport(options: NewsGenerationOptions = {}): Promise<NewsGenerationResult> {
  loadLocalEnv();
  const apiKey = options.apiKey ?? process.env.FIRECRAWL_API_KEY;
  const limitPerSection = options.limitPerSection ?? readPositiveInteger("DAILY_NEWS_LIMIT_PER_SECTION", defaultLimitPerSection);
  const maxSources = options.maxSources ?? readPositiveInteger("DAILY_NEWS_MAX_SOURCES", defaultMaxSources);
  const fetchedItems = apiKey ? await fetchWithFirecrawl(apiKey, { limitPerSection, maxSources }) : [];
  const rawItems = fetchedItems.length > 0 ? [...fetchedItems, ...firecrawlSnapshotNews, ...sampleNews] : [...firecrawlSnapshotNews, ...sampleNews];
  const report = buildDailyReport(rawItems.length > 0 ? rawItems : sampleNews, defaultPreferences, options.now);

  return {
    report,
    mode: apiKey ? "Firecrawl API" : "Firecrawl snapshot",
    rawItemCount: rawItems.length,
  };
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

async function fetchWithFirecrawl(
  apiKey: string,
  options: { limitPerSection: number; maxSources: number },
): Promise<RawNewsItem[]> {
  const app = new Firecrawl({ apiKey });
  const items: RawNewsItem[] = [];
  const enabledSources = newsSources.filter((source) => source.enabled).slice(0, options.maxSources);

  for (const source of enabledSources) {
    for (const section of source.sections) {
      try {
        const domain = hostnameFromUrl(section.url);
        const query = buildQuery(source.name, section);
        let results = await app.search(query, {
          limit: options.limitPerSection,
          includeDomains: domain ? [domain] : undefined,
          sources: ["news"],
        } as never);
        let webResults = readSearchResults(results);
        if (webResults.length === 0 && domain) {
          results = await app.search(query, {
            limit: options.limitPerSection,
            sources: ["news"],
          } as never);
          webResults = readSearchResults(results);
        }

        for (const result of webResults) {
          const title = readString(result, "title").trim();
          const url = readString(result, "url").trim();
          if (!title || !url) continue;
          const summary = readString(result, "description") || title;
          if (!containsChinese(title) && !containsChinese(summary)) continue;

          items.push({
            id: `${source.source_id}-${hashId(url)}`,
            title,
            url,
            sourceId: source.source_id,
            sourceName: source.name,
            language: source.language,
            region: source.countryOrRegion,
            categories: section.categories,
            summary,
            publishedAt: extractDate(result),
            extractedAt: new Date().toISOString(),
            mayHavePaywall: source.mayHavePaywall,
          });
        }
      } catch (error) {
        console.warn(`Skipped ${source.name} ${section.label}: ${String(error)}`);
      }
    }
  }

  return items;
}

function containsChinese(value: string): boolean {
  return /[\u4e00-\u9fff]/.test(value);
}

function readSearchResults(results: unknown): unknown[] {
  if (!results || typeof results !== "object") {
    return [];
  }
  const record = results as Record<string, unknown>;
  if (Array.isArray(record.news)) return record.news;
  if (Array.isArray(record.web)) return record.web;
  return [];
}

function buildQuery(sourceName: string, section: SourceSection): string {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  return `${sourceName} ${section.label} AI technology finance policy world China ${today}`;
}

function extractDate(result: unknown): string | undefined {
  const possibleDate =
    readString(result, "publishedDate") || readString(result, "date") || readString(result, "publishedAt");
  return typeof possibleDate === "string" && Number.isFinite(Date.parse(possibleDate)) ? possibleDate : undefined;
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
