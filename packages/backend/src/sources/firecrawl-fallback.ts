// Explicitly opted-in, receipt- and budget-bound fallback for an already configured source.
// The seed enables no fallback; the database budget starts at zero.
import { sql } from "../db.ts";
import { Firecrawl } from "firecrawl";
import { paidRequest, rejectReceivedResponse } from "../providers/receipts.ts";
import { allowed } from "./web-list.ts";
import { FetchError, type Candidate, type SourceRow } from "./types.ts";

const asObject = (v: unknown): Record<string, any> | null => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : null;

export function firecrawlFallbackEnabled(source: SourceRow): boolean {
  return process.env.DAILY_NEWS_FIRECRAWL_FALLBACK_ENABLED === "true"
    && source.config.dailyNews?.firecrawlFallback?.enabled === true
    && source.config.dailyNews?.migrationStatus === "verified";
}

/** The keyless SDK returns source arrays directly; never accept a result outside source admission. */
export function parseFirecrawlSearch(value: unknown, source: SourceRow): Candidate[] {
  const response = asObject(value);
  const news = response?.news ?? asObject(response?.data)?.news ?? response?.data;
  if (!Array.isArray(news)) throw new FetchError("Firecrawl malformed search response");
  const candidates: Candidate[] = [];
  for (const raw of news.slice(0, 3)) {
    const row = asObject(raw);
    const url = typeof row?.url === "string" ? row.url : "";
    const title = typeof row?.title === "string" ? row.title.trim() : "";
    if (!url || !title || !allowed(url, source)) continue;
    const parsed = typeof row?.date === "string" ? Date.parse(row.date) : NaN;
    const description = typeof row?.description === "string" ? row.description : row?.snippet;
    candidates.push({ url, title: title.slice(0, 300), excerpt: typeof description === "string" ? description.slice(0, 1000) : null,
      publishedAt: Number.isFinite(parsed) ? new Date(parsed) : null, raw: { provider: "firecrawl_keyless_search" } });
  }
  return candidates;
}

export async function fetchFirecrawlFallback(source: SourceRow): Promise<{ candidates: Candidate[]; receiptId: number }> {
  if (!firecrawlFallbackEnabled(source)) throw new FetchError("Firecrawl fallback disabled");
  // The shared receipt layer fails closed without a budget; check here as well for a source-specific error.
  const [budget] = await sql<{ per_minute: number; per_hour: number; per_day: number }[]>`
    SELECT per_minute, per_hour, per_day FROM budgets WHERE service = 'firecrawl'`;
  if (!budget) throw new FetchError("Firecrawl budget row missing");
  const daily = source.config.dailyNews;
  const term = daily.searchTerms?.find((v: unknown) => typeof v === "string" && v.trim())?.trim();
  if (!term || term.length > 120) throw new FetchError("Firecrawl fallback needs a bounded reviewed query");
  const domains = daily.allowedHosts?.filter((v: unknown) => typeof v === "string" && /^[a-z0-9.-]+$/i.test(v)).slice(0, 5) ?? [];
  if (!domains.length) throw new FetchError("Firecrawl fallback needs approved domains");
  const body = { query: term, limit: 3, sources: ["news"], includeDomains: domains };
  const day = new Date().toISOString().slice(0, 10);
  const receipt = await paidRequest({
    service: "firecrawl", purpose: "dailynews_source_fallback", subject: source.id,
    identity: { sourceId: source.id, day, body },
    requestSummary: { sourceId: source.id, day, domains, limit: 3 },
  }, async () => {
    // The frozen old collector uses this SDK with an empty key for its keyless search route.
    // No paid API key is read or sent. P5 must validate the route with a bounded real sample.
    const app = new Firecrawl({ apiKey: "", timeoutMs: 15_000, maxRetries: 1 });
    const result = await app.search(term, { limit: 3, includeDomains: domains, sources: ["news"] } as never);
    return { response: result };
  });
  let candidates: Candidate[];
  try { candidates = parseFirecrawlSearch(receipt.response, source); }
  catch (error) {
    await rejectReceivedResponse(receipt.receiptId, "Firecrawl malformed search response");
    throw error;
  }
  return { candidates, receiptId: receipt.receiptId };
}
