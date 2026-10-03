// Official X API v2 user timeline. New Daily News accounts never enter the SocialData search path.
import { credential } from "../config.ts";
import { guardedFetch } from "../lib/http-fetch.ts";
import { FetchError, type Candidate, type SourceRow } from "./types.ts";

const API = "https://api.x.com/2";
const RECENT_MS = 72 * 3600_000;
const MAX_PAGES = 3;
const MAX_RESULTS = 100;
const numeric = (v: unknown): string | null => typeof v === "string" && /^\d{1,30}$/.test(v) ? v : null;
const tokenValue = (v: unknown): string | null => typeof v === "string" && v.length > 0 && v.length <= 2048 ? v : null;
const object = (v: unknown): Record<string, any> | null => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : null;
const greater = (a: string, b: string) => a.length > b.length || (a.length === b.length && a > b);

export interface OfficialXCursor {
  userId?: string;
  sinceId?: string;
  pageToken?: string;
  newestId?: string;
  startTime?: string;
}
export interface OfficialXRead {
  candidates: Candidate[];
  cursor: OfficialXCursor;
  partial: boolean;
  pages: number;
}
export interface XApiResponse { status: number; body: unknown; }
export type XApiRequest = (url: string, bearerToken: string) => Promise<XApiResponse>;

async function officialRequest(url: string, bearerToken: string): Promise<XApiResponse> {
  if (!url.startsWith(`${API}/`)) throw new FetchError("official X request outside API boundary");
  const res = await guardedFetch(url, {
    headers: { Authorization: `Bearer ${bearerToken}`, Accept: "application/json" },
    timeoutMs: 15_000, maxBytes: 1_000_000, maxRedirects: 0, redirectPolicy: "same-origin", route: "direct",
  });
  let body: unknown;
  try { body = JSON.parse(res.text()); } catch { body = null; }
  return { status: res.status, body };
}

function postCandidate(post: unknown, source: SourceRow, handle: string, userId: string, now: Date): Candidate | null {
  const p = object(post);
  const id = numeric(p?.id);
  const author = numeric(p?.author_id);
  const rawText = typeof p?.note_tweet?.text === "string" ? p.note_tweet.text : p?.text;
  const text = typeof rawText === "string" ? rawText.trim() : "";
  const timestamp = typeof p?.created_at === "string" ? Date.parse(p.created_at) : NaN;
  if (!id || author !== userId || !text || !Number.isFinite(timestamp) || timestamp > +now || timestamp < +now - RECENT_MS) return null;
  if (Array.isArray(p?.referenced_tweets) && p.referenced_tweets.some((r: any) => r?.type === "replied_to" || r?.type === "retweeted")) return null;
  const title = text.split(/\n|[。！？.!?]/, 1)[0]!.trim().slice(0, 140) || text.slice(0, 140);
  return {
    url: `https://x.com/${handle}/status/${id}`,
    identityKey: `x:${id}`,
    title, author: handle, language: source.config.dailyNews?.language ?? null,
    publishedAt: new Date(timestamp), bodyText: text, bodyStatus: "ok",
    xPost: { tweetId: id, authorName: source.name, handle, text },
    raw: { provider: "official_x_v2" },
  };
}

/** Missing opt-in or bearer token causes zero outbound requests, even for a forced collection. */
export async function fetchOfficialX(source: SourceRow, opts: { request?: XApiRequest; now?: Date; maxPages?: number } = {}): Promise<OfficialXRead> {
  if (process.env.DAILY_NEWS_OFFICIAL_X_ENABLED !== "true") throw new FetchError("official X collection disabled");
  const bearer = credential("collectors", "DAILY_NEWS_X_BEARER_TOKEN");
  if (!bearer) throw new FetchError("official X bearer token missing");
  const handle = String(source.config.xUsername ?? "").trim().replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) throw new FetchError("invalid official X username");
  const request = opts.request ?? officialRequest;
  const now = opts.now ?? new Date();
  const base = object(source.cursor?.officialX) as OfficialXCursor | null;
  let userId = numeric(base?.userId) ?? undefined;
  let sinceId = numeric(base?.sinceId) ?? undefined;
  let pageToken = tokenValue(base?.pageToken) ?? undefined;
  let newestId = numeric(base?.newestId) ?? undefined;
  let startTime = pageToken && typeof base?.startTime === "string" && Number.isFinite(Date.parse(base.startTime))
    ? base.startTime : new Date(+now - RECENT_MS).toISOString();
  const call = async (url: string) => {
    const res = await request(url, bearer);
    if (res.status !== 200) throw new FetchError(`official X HTTP ${res.status}`, res.status);
    const body = object(res.body);
    if (!body) throw new FetchError("official X malformed JSON");
    return body;
  };
  if (!userId) {
    const lookup = await call(`${API}/users/by/username/${encodeURIComponent(handle)}`);
    userId = numeric(object(lookup.data)?.id) ?? undefined;
    if (!userId) throw new FetchError("official X user id missing");
  }
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  const pageLimit = Math.min(MAX_PAGES, Math.max(1, opts.maxPages ?? MAX_PAGES));
  let resetInvalidToken = false;
  let pages = 0;
  while (pages < pageLimit) {
    const params = new URLSearchParams({ "tweet.fields": "created_at,author_id,note_tweet,referenced_tweets", exclude: "retweets,replies", max_results: String(MAX_RESULTS), start_time: startTime });
    if (sinceId) params.set("since_id", sinceId);
    if (pageToken) params.set("pagination_token", pageToken);
    let body: Record<string, any>;
    try { body = await call(`${API}/users/${userId}/tweets?${params}`); }
    catch (error) {
      if (pageToken && !resetInvalidToken && error instanceof FetchError && error.status === 400) {
        resetInvalidToken = true;
        pageToken = undefined;
        startTime = new Date(+now - RECENT_MS).toISOString();
        continue;
      }
      throw error;
    }
    if (body.data !== undefined && !Array.isArray(body.data)) throw new FetchError("official X malformed timeline");
    const meta = object(body.meta);
    for (const post of body.data ?? []) {
      const candidate = postCandidate(post, source, handle, userId, now);
      if (!candidate || seen.has(candidate.identityKey!)) continue;
      seen.add(candidate.identityKey!);
      candidates.push(candidate);
      const id = candidate.xPost!.tweetId;
      if (!newestId || greater(id, newestId)) newestId = id;
    }
    pages += 1;
    const next = tokenValue(meta?.next_token);
    if (meta?.next_token !== undefined && !next) throw new FetchError("official X invalid next token");
    if (!next) {
      const watermark = newestId && (!sinceId || greater(newestId, sinceId)) ? newestId : sinceId;
      return { candidates, cursor: { userId, ...(watermark ? { sinceId: watermark } : {}) }, partial: false, pages };
    }
    pageToken = next;
  }
  return { candidates, cursor: { userId, ...(sinceId ? { sinceId } : {}), ...(pageToken ? { pageToken } : {}), ...(newestId ? { newestId } : {}), startTime }, partial: true, pages };
}
