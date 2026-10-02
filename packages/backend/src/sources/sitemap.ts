// Bounded news sitemap reader. <lastmod> is a revision hint, never the publication date.
import { XMLParser } from "fast-xml-parser";
import { guardedFetch, type GuardedResponse } from "../lib/http-fetch.ts";
import { collapseWhitespace } from "../lib/text.ts";
import { allowed } from "./web-list.ts";
import { FetchError, type Candidate, type SourceRow } from "./types.ts";

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", textNodeName: "#text", trimValues: true });
const MAX_INDEX_DEPTH = 2;
const MAX_SITEMAPS = 8;
const MAX_CANDIDATES = 100;
const MAX_BYTES = 2 * 1024 * 1024;

const list = (v: unknown): unknown[] => v === undefined || v === null ? [] : Array.isArray(v) ? v : [v];
const text = (v: unknown): string => {
  if (typeof v === "string" || typeof v === "number") return String(v).trim();
  if (v && typeof v === "object") return text((v as Record<string, unknown>)["#text"]);
  return "";
};
const date = (v: unknown): Date | null => {
  const value = text(v);
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? new Date(parsed) : null;
};

export interface SitemapRead { candidates: Candidate[]; documents: number; }

export async function fetchSitemap(source: SourceRow, request: (url: string) => Promise<GuardedResponse> = (url) =>
  guardedFetch(url, { timeoutMs: 20_000, maxBytes: MAX_BYTES, maxRedirects: 3 })): Promise<SitemapRead> {
  const entry = String(source.config.url ?? "");
  if (!entry || !allowed(entry, source)) throw new FetchError("sitemap URL outside source boundary");
  const queue: Array<{ url: string; depth: number }> = [{ url: entry, depth: 0 }];
  const seen = new Set<string>();
  const candidates = new Map<string, Candidate>();
  while (queue.length && seen.size < MAX_SITEMAPS && candidates.size < MAX_CANDIDATES) {
    const next = queue.shift()!;
    if (seen.has(next.url)) continue;
    if (!allowed(next.url, source)) throw new FetchError("sitemap child outside source boundary");
    seen.add(next.url);
    const res = await request(next.url);
    if (res.status !== 200 || !allowed(res.url, source)) throw new FetchError(`sitemap HTTP ${res.status}`, res.status);
    let document: Record<string, any>;
    try { document = parser.parse(res.text()); } catch { throw new FetchError("sitemap XML parse failed"); }
    if (document.sitemapindex) {
      if (next.depth >= MAX_INDEX_DEPTH) throw new FetchError("sitemap index nesting exceeds limit");
      for (const node of list(document.sitemapindex.sitemap)) {
        const loc = text((node as Record<string, unknown>)?.loc);
        if (!loc) continue;
        let absolute: string;
        try { absolute = new URL(loc, res.url).toString(); } catch { continue; }
        if (!allowed(absolute, source)) throw new FetchError("sitemap child outside source boundary");
        if (queue.length + seen.size >= MAX_SITEMAPS) break;
        queue.push({ url: absolute, depth: next.depth + 1 });
      }
      continue;
    }
    if (!document.urlset) throw new FetchError("not a sitemap XML document");
    for (const node of list(document.urlset.url)) {
      const row = node as Record<string, any>;
      const loc = text(row?.loc);
      if (!loc || !allowed(loc, source)) continue;
      const news = row["news:news"] ?? row.news;
      const title = collapseWhitespace(text(news?.["news:title"] ?? news?.title));
      if (!title) continue; // Ordinary sitemaps are not headlines; a source-specific adapter is needed.
      const publishedAt = date(news?.["news:publication_date"] ?? news?.publication_date);
      const sourceUpdatedAt = date(row.lastmod);
      if (!candidates.has(loc)) candidates.set(loc, {
        url: loc, title, publishedAt, sourceUpdatedAt,
        raw: { sitemap: res.url, lastmod: text(row.lastmod) || null },
      });
      if (candidates.size >= MAX_CANDIDATES) break;
    }
  }
  if (candidates.size === 0) throw new FetchError("sitemap has no titled news entries; source-specific mapping required");
  return { candidates: [...candidates.values()], documents: seen.size };
}
