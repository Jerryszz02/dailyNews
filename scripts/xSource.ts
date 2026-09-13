import type { NewsSource, RawNewsItem } from "../src/types.js";
import type { NewsCollectionSourceOutcome } from "./newsService.js";
import type { SourceCollectionCursor } from "./newsStore.js";

const API_ROOT = "https://api.x.com/2";
const DEFAULT_MAX_PAGES = 3;
const MAX_REQUEST_MS = 15_000;
const RECENT_WINDOW_MS = 72 * 60 * 60_000;

export function isXApiConfigured(): boolean { return Boolean(process.env.DAILY_NEWS_X_BEARER_TOKEN?.trim()); }
export interface XCollectionOutcome extends NewsCollectionSourceOutcome { cursor?: SourceCollectionCursor; }
interface XCollectOptions { source: NewsSource; cursor?: SourceCollectionCursor; now: Date; deadlineAt: number; requestGate?: { run<T>(task: () => Promise<T>): Promise<T> }; fetchImpl?: typeof fetch; maxPages?: number; }

export async function collectXSource(options: XCollectOptions): Promise<{ items: RawNewsItem[]; outcome: XCollectionOutcome }> {
  const { source, now, deadlineAt } = options;
  if (!isXApiConfigured()) return finish([], source, "skipped", "x_api_not_configured");
  const handle = source.xUsername?.trim().replace(/^@/, "");
  if (!handle) return finish([], source, "skipped", "x_username_missing");
  const token = process.env.DAILY_NEWS_X_BEARER_TOKEN!.trim();
  const fetcher = options.fetchImpl ?? fetch;
  const gate = options.requestGate ?? { run: <T>(task: () => Promise<T>) => task() };
  const maxPages = Math.max(1, options.maxPages ?? DEFAULT_MAX_PAGES);
  const base = options.cursor;
  let userId = numericId(base?.userId) ?? "";
  let sinceId = numericId(base?.sinceId);
  let paginationToken = boundedToken(base?.paginationToken);
  let newestId = numericId(base?.newestId);
  let startTime = (paginationToken && validTimestamp(base?.startTime)) || new Date(now.getTime() - RECENT_WINDOW_MS).toISOString();
  const items: RawNewsItem[] = [];
  const seen = new Set<string>();
  let resetUsed = false;
  let pages = 0;

  try {
    if (!userId) {
      const lookup = objectValue(await requestJson(`${API_ROOT}/users/by/username/${encodeURIComponent(handle)}`, token, fetcher, gate, deadlineAt));
      userId = numericId(objectValue(lookup?.data)?.id) ?? "";
      if (!userId) throw new XError("x_api_malformed_response");
    }
    while (pages < maxPages) {
      if (Date.now() >= deadlineAt) return finish(items, source, "partial", "x_collection_deadline", makeCursor(userId, sinceId, paginationToken, newestId, startTime));
      const query = new URLSearchParams({ "tweet.fields": "created_at,author_id,note_tweet,referenced_tweets", exclude: "retweets,replies", max_results: "100", start_time: startTime });
      if (sinceId) query.set("since_id", sinceId);
      if (paginationToken) query.set("pagination_token", paginationToken);
      let payload: Record<string, unknown> | undefined;
      try {
        payload = objectValue(await requestJson(`${API_ROOT}/users/${encodeURIComponent(userId)}/tweets?${query}`, token, fetcher, gate, deadlineAt));
      } catch (error) {
        if (error instanceof XError && error.code === "x_api_invalid_pagination_token" && paginationToken && !resetUsed) {
          resetUsed = true;
          paginationToken = undefined;
          startTime = validTimestamp(base?.startTime) ?? startTime;
          continue;
        }
        throw error;
      }
      const meta = objectValue(payload?.meta);
      if (!payload || (payload.data === undefined && meta?.result_count !== 0) || (payload.data !== undefined && !Array.isArray(payload.data))) throw new XError("x_api_malformed_response");
      for (const post of Array.isArray(payload.data) ? payload.data : []) {
        const item = toItem(post, source, handle, userId, now);
        if (!item || seen.has(item.id)) continue;
        seen.add(item.id); items.push(item);
        if (!newestId || compareIds(item.id, newestId) > 0) newestId = item.id;
      }
      pages += 1;
      const next = boundedToken(meta?.next_token);
      if (meta?.next_token !== undefined && !next) throw new XError("x_api_malformed_response");
      if (!next) {
        const durableSince = maxId(sinceId, newestId);
        return finish(items, source, items.length ? "success" : "empty", null, makeCursor(userId, durableSince, undefined, durableSince, undefined));
      }
      paginationToken = next;
    }
    return finish(items, source, "partial", "x_collection_page_limit", makeCursor(userId, sinceId, paginationToken, newestId, startTime));
  } catch (error) {
    const code = error instanceof XError ? error.code : "x_api_request_failed";
    return finish(items, source, items.length ? "partial" : "failed", code, userId ? makeCursor(userId, sinceId, paginationToken, newestId, startTime) : undefined);
  }
}

function finish(items: RawNewsItem[], source: NewsSource, status: XCollectionOutcome["status"], errorCode: string | null, cursor?: SourceCollectionCursor) { return { items, outcome: { sourceId: source.source_id, status, discoveredCount: items.length, errorCode, ...(cursor ? { cursor } : {}) } }; }
function makeCursor(userId: string, sinceId?: string, paginationToken?: string, newestId?: string, startTime?: string): SourceCollectionCursor { return { userId, ...(sinceId ? { sinceId } : {}), ...(paginationToken ? { paginationToken } : {}), ...(newestId ? { newestId } : {}), ...(startTime ? { startTime } : {}) }; }

async function requestJson(url: string, token: string, fetcher: typeof fetch, gate: { run<T>(task: () => Promise<T>): Promise<T> }, deadlineAt: number): Promise<unknown> {
  if (Date.now() >= deadlineAt) throw new XError("x_collection_deadline");
  const controller = new AbortController();
  let globalTimer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    globalTimer = setTimeout(() => {
      controller.abort();
      reject(new XError("x_collection_deadline"));
    }, deadlineAt - Date.now());
  });
  try {
    return await Promise.race([gate.run(async () => {
      if (controller.signal.aborted || Date.now() >= deadlineAt) throw new XError("x_collection_deadline");
      const remaining = Math.min(MAX_REQUEST_MS, deadlineAt - Date.now());
      let requestTimer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<never>((_, reject) => {
        requestTimer = setTimeout(() => {
          controller.abort();
          reject(new XError(Date.now() >= deadlineAt ? "x_collection_deadline" : "x_api_timeout"));
        }, remaining);
      });
      try {
        return await Promise.race([(async () => {
        const response = await fetcher(url, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal, redirect: "error" });
        if (response.status === 400) {
          const body = await response.json().catch(() => ({}));
          const isPaginationError = /pagination.?token|next.?token/i.test(JSON.stringify(body));
          throw new XError(isPaginationError ? "x_api_invalid_pagination_token" : "x_api_http_400");
        }
        if (response.status === 401 || response.status === 403) throw new XError(`x_api_http_${response.status}`);
        if (response.status === 429) throw new XError("x_api_rate_limited");
        if (!response.ok) throw new XError(`x_api_http_${response.status}`);
        try { return await response.json(); } catch { throw new XError("x_api_non_json"); }
        })(), timedOut]);
      } catch (error) {
        if (error instanceof XError) throw error;
        if (controller.signal.aborted) throw new XError(Date.now() >= deadlineAt ? "x_collection_deadline" : "x_api_timeout");
        throw new XError("x_api_request_failed");
      } finally { if (requestTimer) clearTimeout(requestTimer); }
    }), expired]);
  } finally { if (globalTimer) clearTimeout(globalTimer); }
}

function toItem(value: unknown, source: NewsSource, handle: string, userId: string, now: Date): RawNewsItem | null {
  const post = objectValue(value);
  if (!post) return null;
  const id = numericId(post.id); const author = numericId(post.author_id); const created = validTimestamp(post.created_at); const text = validString(objectValue(post.note_tweet)?.text) ?? validString(post.text);
  const timestamp = created ? Date.parse(created) : NaN;
  if (!id || author !== userId || !created || !text || timestamp > now.getTime() || timestamp < now.getTime() - RECENT_WINDOW_MS || isReplyOrRetweet(post.referenced_tweets)) return null;
  const section = source.sections[0]; const title = text.split(/\n|[。！？.!?]/, 1)[0].trim().slice(0, 140) || text.slice(0, 140);
  return { id, title, url: `https://x.com/${handle}/status/${id}`, sourceId: source.source_id, sourceName: source.name, language: source.language, region: source.countryOrRegion, categories: section?.categories ?? [], primaryCategory: section?.primaryCategory, summary: text, publishedAt: created, updatedAt: created, discoveredAt: now.toISOString(), extractedAt: now.toISOString(), mayHavePaywall: source.mayHavePaywall, translationStatus: "pending", summaryStatus: "complete", timeStatus: "verified" };
}
function isReplyOrRetweet(value: unknown): boolean { return Array.isArray(value) && value.some((entry) => entry && typeof entry === "object" && ((entry as { type?: unknown }).type === "retweeted" || (entry as { type?: unknown }).type === "replied_to")); }
function objectValue(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function validString(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value : undefined; }
function numericId(value: unknown): string | undefined { return typeof value === "string" && /^\d{1,30}$/.test(value) ? value : undefined; }
function boundedToken(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 && value.length <= 2048 ? value : undefined; }
function validTimestamp(value: unknown): string | undefined { return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : undefined; }
function compareIds(a: string, b: string): number { return a.length === b.length ? a.localeCompare(b) : a.length - b.length; }
function maxId(left?: string, right?: string): string | undefined { return !left ? right : !right || compareIds(left, right) >= 0 ? left : right; }
class XError extends Error { constructor(readonly code: string) { super(code); } }
