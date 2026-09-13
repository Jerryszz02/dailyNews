import { afterEach, describe, expect, it, vi } from "vitest";
import { defineApprovedSource } from "../src/lib/sourceAdmission";
import { newsSources } from "../src/config/sources";
import type { NewsSource } from "../src/types";
import { InMemoryNewsStore } from "./inMemoryNewsStore";
import { runNewsRefresh } from "./newsRefresh";
import { readBundledReport } from "./reportStore";
import { collectNewsCandidates, type NewsCollectionOptions, type NewsCollectionResult } from "./newsService";

const search = vi.hoisted(() => vi.fn());
vi.mock("firecrawl", () => ({ Firecrawl: class { search(...args: unknown[]) { return search(...args); } } }));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  search.mockReset();
});

const now = new Date("2026-09-13T01:00:00.000Z");
const publishedAt = "2026-09-13T00:00:00.000Z";
function source(id: string): NewsSource {
  return defineApprovedSource({
    source_id: id, name: "测试新闻来源", enabled: true, language: "zh-CN",
    countryOrRegion: "china", mediaType: "public", defaultWeight: 1, credibility: 80,
    mayHavePaywall: false,
    sections: [{ label: "新闻", url: `https://${id}.example.com/news`, primaryCategory: "china", categories: ["china"] }],
  });
}
function rss(article: string, date = publishedAt) {
  return `<rss><channel><item><title>研究机构发布重要研究进展</title><link>${article}</link><description>研究机构公布实验结果，并说明后续验证安排。</description><pubDate>${date}</pubDate></item></channel></rss>`;
}
const empty = (sources: NewsSource[]): NewsCollectionResult => ({
  items: [], mode: "No live data",
  sourceOutcomes: sources.map((s) => ({ sourceId: s.source_id, status: "empty", discoveredCount: 0, errorCode: null })),
});

describe("scaled collection", () => {
  it.each([50, 3])("refills a %i-source pool before slow siblings finish", async (concurrency) => {
    vi.stubEnv("DAILY_NEWS_SOURCE_CONCURRENCY", String(concurrency));
    const sources = Array.from({ length: 55 }, (_, i) => source(`pool-${i}`));
    const pending: Array<() => void> = [];
    let active = 0, peak = 0;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => {
      active += 1; peak = Math.max(peak, active);
      pending.push(() => { active -= 1; resolve(new Response("<html></html>")); });
    }));
    vi.stubGlobal("fetch", fetchMock);
    const run = collectNewsCandidates({ sources, now, useFirecrawlKeyless: false, repairSummariesWithModel: false });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(concurrency));
    pending.pop()!();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(concurrency + 1));
    while (fetchMock.mock.calls.length < sources.length || pending.length) {
      pending.splice(0).forEach((resolve) => resolve());
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const result = await run;
    expect(peak).toBe(concurrency);
    expect(result.sourceOutcomes).toHaveLength(55);
    expect(result.sourceOutcomes.every((outcome) => outcome.status === "empty")).toBe(true);
  });

  it.each(["rss", "rdf", "atom"])("uses a recent %s feed before the website or Firecrawl", async (format) => {
    const s = source("feeds");
    s.sections[0].feedUrl = "https://feeds.example.org/updates.xml";
    const article = "https://feeds.example.com/news/research-update.html";
    const doc = format === "rss" ? rss(article) : format === "rdf"
      ? `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/"><item rdf:about="${article}"><title>研究机构发布重要研究进展</title><link>${article}</link><description>研究机构公布实验结果，并说明后续验证安排。</description><dc:date>${publishedAt}</dc:date></item></rdf:RDF>`
      : `<feed><entry><title>研究机构发布重要研究进展</title><link href="${article}"/><summary>研究机构公布实验结果，并说明后续验证安排。</summary><updated>${publishedAt}</updated></entry></feed>`;
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => new Response(String(url) === s.sections[0].feedUrl ? doc : "<html></html>"));
    vi.stubGlobal("fetch", fetchMock);
    const result = await collectNewsCandidates({ sources: [s], now, repairSummariesWithModel: false });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].publishedAt).toBe(publishedAt);
    expect(result.items[0].url).toBe(article);
    expect(fetchMock.mock.calls.some(([url]) => String(url) === s.sections[0].url)).toBe(false);
    expect(search).not.toHaveBeenCalled();
  });

  it.each(["stale", "redirect", "failed"])("falls back to the website after a %s feed without following a foreign redirect", async (mode) => {
    const s = source("fallback");
    s.sections[0].feedUrl = "https://feeds.example.org/updates.xml";
    const article = "https://fallback.example.com/news/update.html";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === s.sections[0].feedUrl) {
        if (mode === "redirect") return new Response("", { status: 302, headers: { location: "https://foreign.invalid/private" } });
        if (mode === "failed") return new Response("", { status: 503 });
        return new Response(rss(article, "2020-01-01T00:00:00.000Z"));
      }
      return new Response(url === s.sections[0].url ? rss(article) : "<html></html>");
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await collectNewsCandidates({ sources: [s], now, repairSummariesWithModel: false });
    expect(result.items.map((item) => item.url)).toEqual([article]);
    expect(fetchMock.mock.calls.some(([url]) => String(url) === s.sections[0].url)).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("foreign.invalid"))).toBe(false);
    expect(search).not.toHaveBeenCalled();
  });

  it("retains a cursor-only X outcome without issuing an X HTML or search request", async () => {
    vi.stubEnv("DAILY_NEWS_X_BEARER_TOKEN", "fixture-only");
    const s = { ...source("x-source"), xUsername: "test", mediaType: "social" as const };
    s.sections[0].url = "https://x.com/test";
    s.allowedHosts = ["x.com"];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify({ meta: { result_count: 0 } })));
    vi.stubGlobal("fetch", fetchMock);
    const result = await collectNewsCandidates({
      sources: [s], now, sourceStates: [{
        sourceId: s.source_id, intervalMinutes: 120, lastAttemptAt: null, lastSuccessAt: null, nextDueAt: null,
        consecutiveFailures: 0, circuitOpenUntil: null, lastErrorCode: null, collectionCursor: { userId: "42", sinceId: "100" },
      }],
    });
    expect(result.sourceOutcomes[0]).toMatchObject({ status: "empty", cursor: { userId: "42", sinceId: "100" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("https://api.x.com/2/users/42/tweets?");
    expect(search).not.toHaveBeenCalled();
  });

  it("skips unconfigured X from the production registry while planning every website", async () => {
    vi.stubEnv("DAILY_NEWS_X_BEARER_TOKEN", "");
    const initial = readBundledReport();
    const store = new InMemoryNewsStore(initial);
    const collect = vi.fn(async (options) => empty(options.sources));
    const result = await runNewsRefresh({ trigger: "manual" }, { store, collect, buildReport: () => initial });
    const expected = newsSources.filter((s) => s.enabled && s.admission === "approved" && !s.xUsername);
    expect(collect.mock.calls[0][0].sources.map((s: NewsSource) => s.source_id)).toEqual(expected.map((s) => s.source_id));
    expect(result.selectedSourceIds).toHaveLength(88);
    expect((await store.readState()).sources.filter((s) => s.enabled)).toHaveLength(88);
  });
});

describe("long-running refresh lease and cursors", () => {
  it.each([true, false])("renews long collection and permits a terminal commit only while owned (%s)", async (renewSucceeds) => {
    vi.useFakeTimers();
    const initial = readBundledReport();
    vi.setSystemTime(new Date(initial.generatedAt));
    const sources = [newsSources[0]];
    const store = new InMemoryNewsStore(initial, () => new Date());
    const renew = vi.spyOn(store, "renewRefresh");
    if (!renewSucceeds) renew.mockResolvedValue(false);
    const complete = vi.spyOn(store, "completeRefreshWithoutPublish");
    const commit = vi.spyOn(store, "commitRefresh");
    let finish!: (value: NewsCollectionResult) => void;
    const collect = vi.fn(() => new Promise<NewsCollectionResult>((resolve) => { finish = resolve; }));
    const run = runNewsRefresh({ trigger: "manual", leaseSeconds: 120 }, { store, sources, collect, buildReport: () => initial });
    await vi.advanceTimersByTimeAsync(125_000);
    expect(collect).toHaveBeenCalledOnce();
    expect(renew.mock.calls.length).toBeGreaterThanOrEqual(renewSucceeds ? 4 : 1);
    finish(empty(sources));
    const result = await run;
    if (renewSucceeds) {
      expect(result.ok).toBe(true);
      expect(complete).toHaveBeenCalledOnce();
    } else {
      expect(result.status).toBe("failed");
      expect(result.errorCode).toBe("refresh_lease_invalid");
      expect(complete).not.toHaveBeenCalled();
    }
    expect(commit).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("passes an atomically saved X cursor to the next refresh", async () => {
    vi.stubEnv("DAILY_NEWS_X_BEARER_TOKEN", "fixture-only");
    const initial = readBundledReport();
    const store = new InMemoryNewsStore(initial);
    const s = { ...newsSources.find((s) => s.xUsername)!, enabled: true };
    const collect = vi.fn(async (_options: NewsCollectionOptions): Promise<NewsCollectionResult> => ({
      items: [], mode: "No live data",
      sourceOutcomes: [{ sourceId: s.source_id, status: "empty", discoveredCount: 0, errorCode: null, cursor: { userId: "42", sinceId: "9007199254740993" } }],
    }));
    await runNewsRefresh({ trigger: "manual", idempotencyKey: "cursor:first" }, { store, sources: [s], collect, buildReport: () => initial });
    await runNewsRefresh({ trigger: "manual", idempotencyKey: "cursor:second" }, { store, sources: [s], collect, buildReport: () => initial });
    expect(collect).toHaveBeenCalledTimes(2);
    const options = collect.mock.calls[1][0] as unknown as { sourceStates: Array<{ sourceId: string; collectionCursor?: unknown }> };
    expect(options.sourceStates.find((state) => state.sourceId === s.source_id)?.collectionCursor).toEqual({ userId: "42", sinceId: "9007199254740993" });
  });
});
