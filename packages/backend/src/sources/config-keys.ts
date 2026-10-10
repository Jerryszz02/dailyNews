// The config keys each kind of source implements. Anything else is refused: a key a collector does not
// know would otherwise fall back silently to the generic parse (menus and sentence fragments as
// articles, dates never found).
import type { SourceRow } from "./types.ts";

// Rules applied in collect.ts to every kind read through collectSource.
const COLLECTED = ["_aihot", "dailyNews", "allowUrlPrefixes", "denyUrlPrefixes", "ingestNoiseFilter", "itemUrlPrefixRewrite", "sortByPublishedAt", "detail", "fetchPublicContent"];

const KEYS: Record<SourceRow["kind"], string[]> = {
  rss: [...COLLECTED, "feedUrl", "summaryIsBody", "preserveUrlFragment", "allowCategories", "denyCategories"],
  web_list: [
    ...COLLECTED, "url", "baseUrl", "parseMode", "adapter", "cacheToleranceSeconds", "linksStartLine", "preserveUrlFragment",
    "itemSelector", "linkSelector", "titleSelector", "publishedAtSelector", "publishedAtRegex", "publishedAtUtcOffset",
  ],
  json_list: [
    ...COLLECTED, "url", "mode", "method", "headers", "bodyJson", "jsonKey", "windowVar", "itemsPath", "itemsObjectValues",
    "titlePaths", "summaryPaths", "summaryIsBody", "authorPaths", "publishedAtPath", "publishedAtUnit", "externalIdPath",
    "urlTemplate", "urlTemplateFallback", "rawDropKeys", "requireBoolean", "minNumeric",
  ],
  // X accounts are mostly read in shards, which apply only these.
  x_search: ["_aihot", "dailyNews", "ingestNoiseFilter", "itemUrlPrefixRewrite", "query", "searchType", "xUsername"],
  mp_account: ["wxid", "ghid", "nickname"],
  external: [],
};

// Objects with fixed keys (headers and bodyJson are request data, free-form).
const NESTED: Record<string, string[]> = {
  _aihot: ["initialBackfillLimit", "initialBackfillMonths"],
  dailyNews: [
    "legacySourceId", "sectionId", "sectionLabel", "sectionUrl", "sourceCredibility", "tierReason", "mediaType", "signalRole",
    "mayHavePaywall", "primaryCategoryHint", "publisherKey", "language", "allowedHosts", "allowedPathPrefixes",
    "readerUrlAliases", "legacyEnabled", "disabledReason", "migrationStatus", "adapter", "searchTerms", "searchSources",
    "reviewedAt", "firecrawlFallback",
  ],
  ingestNoiseFilter: ["dropMarkers", "dropMarkersTitleOnly", "keepIfMatches"],
  itemUrlPrefixRewrite: ["from", "to"],
  requireBoolean: ["path", "equals"],
  minNumeric: ["path", "min"],
  detail: [
    "maxFetches", "publishedAtSelector", "publishedAtRegex", "publishedAtUtcOffset", "publishedAtUnit", "publishedAtAuthoritative", "upgradeDatePrecision",
    "titleSelector", "titleRegex", "titleAuthoritative", "summarySelector",
  ],
};

const VALUES: Record<string, string[]> = {
  adapter: ["mimo_home"],
  parseMode: ["html", "markdown", "docusaurus_changelog"],
};

/** The config entries a source of this kind would ignore or cannot run, e.g. ["adapter=site_cards", "detail.titleFoo"]. */
export function unsupportedConfig(kind: SourceRow["kind"], config: Record<string, unknown>): string[] {
  const allowed = new Set(KEYS[kind] ?? []);
  const out: string[] = [];
  for (const [key, value] of Object.entries(config ?? {})) {
    if (!allowed.has(key)) out.push(key);
    else if (VALUES[key] && !VALUES[key]!.includes(String(value))) out.push(`${key}=${String(value)}`);
    else if (NESTED[key] && value && typeof value === "object") {
      for (const sub of Object.keys(value)) if (!NESTED[key]!.includes(sub)) out.push(`${key}.${sub}`);
    }
  }
  const detail = config.detail as Record<string, unknown> | undefined;
  if (detail?.publishedAtUnit !== undefined && !["epoch_s", "epoch_ms"].includes(String(detail.publishedAtUnit)))
    out.push(`detail.publishedAtUnit=${String(detail.publishedAtUnit)}`);
  const dn = config.dailyNews;
  if (dn !== undefined && (!dn || typeof dn !== "object" || Array.isArray(dn))) out.push("dailyNews");
  if (dn && typeof dn === "object" && !Array.isArray(dn)) {
    const v = dn as Record<string, unknown>;
    const adapter = v.adapter;
    if (!["rss", "sitemap", "web_list", "json_list", "x_official"].includes(String(adapter))) out.push(`dailyNews.adapter=${String(adapter)}`);
    if (!Array.isArray(v.allowedHosts) || v.allowedHosts.length === 0 || !v.allowedHosts.every((host) => typeof host === "string" && /^[a-z0-9.-]+$/i.test(host))) out.push("dailyNews.allowedHosts");
    if (typeof v.publisherKey !== "string" || !/^publisher:[a-z0-9_-]+$/i.test(v.publisherKey)) out.push("dailyNews.publisherKey");
    if (typeof v.legacySourceId !== "string" || typeof v.sectionId !== "string") out.push("dailyNews.legacyIdentity");
    if (kind === "x_search" && adapter !== "x_official") out.push("dailyNews.xSearchAdapter");
    if (kind === "rss" && adapter !== "rss") out.push("dailyNews.rssAdapter");
    if (kind === "web_list" && adapter !== "web_list" && adapter !== "sitemap") out.push("dailyNews.webAdapter");
    if (kind === "json_list" && adapter !== "json_list") out.push("dailyNews.jsonAdapter");
    if (v.migrationStatus === "verified" && adapter === "web_list" &&
      (typeof config.itemSelector !== "string" || typeof config.linkSelector !== "string" || typeof config.titleSelector !== "string"))
      out.push("dailyNews.verifiedWebSelectors");
  }
  return out;
}

export class UnsupportedConfig extends Error {
  readonly statusCode = 400;
}

/** Refuses a config with entries its kind does not implement (admin create, edit and preview). */
export function assertSupportedConfig(kind: SourceRow["kind"], config: Record<string, unknown>): void {
  const bad = unsupportedConfig(kind, config);
  if (bad.length) throw new UnsupportedConfig(`不支持的配置项：${bad.join("、")}`);
}
