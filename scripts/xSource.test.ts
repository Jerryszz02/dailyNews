import { afterEach, describe, expect, it, vi } from "vitest";
import { collectXSource, isXApiConfigured } from "./xSource.js";
import type { NewsSource } from "../src/types.js";

const source: NewsSource = {
  source_id: "x-test", name: "X测试", countryOrRegion: "global", language: "en-US", mediaType: "social",
  defaultWeight: 1, credibility: 0.5, sections: [{ label: "科技", url: "https://x.com/test", categories: ["technology"], primaryCategory: "technology" }],
  xUsername: "test", mayHavePaywall: false, enabled: true, admission: "approved", publicationRole: "reporting", signalRole: "first_party", allowedHosts: ["x.com"], reviewedAt: "2026-01-01", reviewNote: "test",
};
const post = (id: string, text = "A useful post") => ({ id, text, author_id: "42", created_at: "2026-09-13T00:00:00.000Z" });
const response = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => { delete process.env.DAILY_NEWS_X_BEARER_TOKEN; vi.useRealTimers(); });

describe("official X source collector", () => {
  it("skips without making HTTP when bearer token is absent", async () => {
    let calls = 0;
    const result = await collectXSource({ source, now: new Date(), deadlineAt: Date.now() + 1000, fetchImpl: async () => { calls += 1; return response({}); } });
    expect(isXApiConfigured()).toBe(false);
    expect(calls).toBe(0);
    expect(result.outcome.errorCode).toBe("x_api_not_configured");
  });

  it("resolves user and collects pages with a durable cursor", async () => {
    process.env.DAILY_NEWS_X_BEARER_TOKEN = "test-token";
    const urls: string[] = [];
    const fetchImpl = async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return response(urls.length === 1 ? { data: { id: "42" } } : { data: [post("9007199254740993", "Long post")], meta: { next_token: "next" } });
    };
    const result = await collectXSource({ source, now: new Date("2026-09-13T01:00:00.000Z"), deadlineAt: Date.now() + 5000, fetchImpl, maxPages: 1 });
    expect(urls[0]).toContain("/users/by/username/test");
    expect(urls[1]).toContain("exclude=retweets%2Creplies");
    expect(result.items[0]).toMatchObject({ id: "9007199254740993", url: "https://x.com/test/status/9007199254740993", summary: "Long post" });
    expect(result.outcome.cursor).toMatchObject({ userId: "42", paginationToken: "next" });
  });

  it("sanitizes unauthorized responses", async () => {
    process.env.DAILY_NEWS_X_BEARER_TOKEN = "secret";
    const result = await collectXSource({ source, now: new Date(), deadlineAt: Date.now() + 1000, fetchImpl: async () => response({ error: "secret" }, 401) });
    expect(result.outcome.errorCode).toBe("x_api_http_401");
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("accepts a meta-only empty result and retains the durable sinceId", async () => {
    process.env.DAILY_NEWS_X_BEARER_TOKEN = "test-token";
    const result = await collectXSource({ source, cursor: { userId: "42", sinceId: "9007199254740999" }, now: new Date("2026-09-13T01:00:00.000Z"), deadlineAt: Date.now() + 5000, fetchImpl: async () => response({ meta: { result_count: 0 } }) });
    expect(result).toMatchObject({ items: [], outcome: { status: "empty", cursor: { sinceId: "9007199254740999" } } });
  });

  it("resumes a partial page without moving sinceId backwards", async () => {
    process.env.DAILY_NEWS_X_BEARER_TOKEN = "test-token";
    const now = new Date("2026-09-13T01:00:00.000Z");
    const partial = await collectXSource({ source, cursor: { userId: "42", sinceId: "100" }, now, deadlineAt: Date.now() + 5000, maxPages: 1, fetchImpl: async () => response({ data: [post("200")], meta: { next_token: "older" } }) });
    expect(partial.outcome.cursor).toMatchObject({ sinceId: "100", newestId: "200", paginationToken: "older" });
    const resumed = await collectXSource({ source, cursor: partial.outcome.cursor, now, deadlineAt: Date.now() + 5000, fetchImpl: async () => response({ data: [post("150")] }) });
    expect(resumed.outcome.cursor).toMatchObject({ sinceId: "200", newestId: "200" });
  });

  it("keeps usable page-one items when page two fails", async () => {
    process.env.DAILY_NEWS_X_BEARER_TOKEN = "test-token";
    let count = 0;
    const result = await collectXSource({ source, cursor: { userId: "42" }, now: new Date("2026-09-13T01:00:00.000Z"), deadlineAt: Date.now() + 5000, fetchImpl: async () => count++ === 0 ? response({ data: [post("300")], meta: { next_token: "older" } }) : response({ error: "no" }, 503) });
    expect(result).toMatchObject({ items: [expect.objectContaining({ id: "300" })], outcome: { status: "partial", errorCode: "x_api_http_503", cursor: { paginationToken: "older" } } });
  });

  it("filters wrong authors, replies, retweets and future posts while preferring note_tweet", async () => {
    process.env.DAILY_NEWS_X_BEARER_TOKEN = "test-token";
    const now = new Date("2026-09-13T01:00:00.000Z");
    const result = await collectXSource({ source, cursor: { userId: "42" }, now, deadlineAt: Date.now() + 5000, fetchImpl: async () => response({ data: [post("1"), { ...post("2"), author_id: "99" }, { ...post("3"), referenced_tweets: [{ type: "replied_to" }] }, { ...post("4"), referenced_tweets: [{ type: "retweeted" }] }, { ...post("5"), created_at: "2026-09-13T02:00:00.000Z" }, { ...post("6", "short"), note_tweet: { text: "long form" } }] }) });
    expect(result.items).toHaveLength(2);
    expect(result.items.find((item) => item.id === "6")?.summary).toBe("long form");
  });

  it("uses bearer auth, blocks redirects, and does not expose the token", async () => {
    process.env.DAILY_NEWS_X_BEARER_TOKEN = "private-token";
    let init: RequestInit | undefined;
    const result = await collectXSource({ source, now: new Date("2026-09-13T01:00:00.000Z"), deadlineAt: Date.now() + 5000, fetchImpl: async (_url, request) => { init = request; return response({ data: { id: "42" } }); } });
    expect(init).toMatchObject({ redirect: "error", headers: { Authorization: "Bearer private-token" } });
    expect(JSON.stringify(result)).not.toContain("private-token");
  });

  it("resets one invalid pagination token without losing already fetched items", async () => {
    process.env.DAILY_NEWS_X_BEARER_TOKEN = "test-token";
    let calls = 0;
    const result = await collectXSource({ source, cursor: { userId: "42", sinceId: "100" }, now: new Date("2026-09-13T01:00:00.000Z"), deadlineAt: Date.now() + 5000, maxPages: 2, fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return response({ data: [post("300")], meta: { next_token: "bad" } });
      if (calls === 2) return response({ title: "invalid pagination token" }, 400);
      return response({ data: [post("300"), post("200")] });
    } });
    expect(result.items.map((item) => item.id)).toEqual(["300", "200"]);
    expect(result.outcome.cursor).toMatchObject({ sinceId: "300" });
  });

  it.each([[403, "x_api_http_403"], [429, "x_api_rate_limited"]] as const)("returns sanitized %i response without retry", async (status, code) => {
    process.env.DAILY_NEWS_X_BEARER_TOKEN = "test-token";
    let calls = 0;
    const result = await collectXSource({ source, now: new Date("2026-09-13T01:00:00.000Z"), deadlineAt: Date.now() + 5000, fetchImpl: async () => { calls += 1; return response({}, status); } });
    expect(result.outcome.errorCode).toBe(code);
    expect(calls).toBe(1);
  });

  it("reports non-json bodies without exposing response text", async () => {
    process.env.DAILY_NEWS_X_BEARER_TOKEN = "test-token";
    const result = await collectXSource({ source, now: new Date("2026-09-13T01:00:00.000Z"), deadlineAt: Date.now() + 5000, fetchImpl: async () => new Response("private body", { status: 200 }) });
    expect(result.outcome.errorCode).toBe("x_api_non_json");
    expect(JSON.stringify(result)).not.toContain("private body");
  });

  it.each([{}, { data: {} }, { data: [], meta: { next_token: "x".repeat(2049) } }])("does not treat a malformed timeline as an empty success", async (body) => {
    process.env.DAILY_NEWS_X_BEARER_TOKEN = "test-token";
    const result = await collectXSource({ source, cursor: { userId: "42", sinceId: "100" }, now: new Date(), deadlineAt: Date.now() + 5000, fetchImpl: async () => response(body) });
    expect(result.outcome).toMatchObject({ status: "failed", errorCode: "x_api_malformed_response", cursor: { sinceId: "100" } });
  });

  it("times out an unresponsive request and preserves its cursor", async () => {
    vi.useFakeTimers();
    process.env.DAILY_NEWS_X_BEARER_TOKEN = "test-token";
    let signal: AbortSignal | undefined;
    const resultPromise = collectXSource({ source, cursor: { userId: "42", sinceId: "100" }, now: new Date(), deadlineAt: Date.now() + 45_000, fetchImpl: async (_url, init) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    } });
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await resultPromise).outcome).toMatchObject({ status: "failed", errorCode: "x_api_timeout", cursor: { sinceId: "100" } });
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not start a queued API call after the source deadline", async () => {
    vi.useFakeTimers();
    process.env.DAILY_NEWS_X_BEARER_TOKEN = "test-token";
    let release!: () => void;
    const fetchImpl = vi.fn(async () => response({ meta: { result_count: 0 } }));
    const requestGate = { async run<T>(task: () => Promise<T>): Promise<T> {
      await new Promise<void>((resolve) => { release = resolve; });
      return task();
    } };
    const resultPromise = collectXSource({ source, cursor: { userId: "42", sinceId: "100" }, now: new Date(), deadlineAt: Date.now() + 1000, requestGate, fetchImpl });
    await vi.advanceTimersByTimeAsync(1000);
    expect((await resultPromise).outcome.errorCode).toBe("x_collection_deadline");
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
