import { describe, expect, it, vi } from "vitest";
import { defaultPreferences } from "../src/config/preferences";
import { newsSources } from "../src/config/sources";
import { buildDailyReport } from "../src/lib/newsPipeline";
import { selectLatestStories } from "../src/lib/curation";
import { selectSourcesForCoverage } from "../src/lib/sourceCoverage";
import type { RawNewsItem } from "../src/types";
import { InMemoryNewsStore } from "./inMemoryNewsStore";
import type { NewsStore } from "./newsStore";
import {
  defaultServerlessMaxSources,
  hashReportContent,
  mergeRefreshCandidates,
  runNewsRefresh,
} from "./newsRefresh";
import type { NewsCollectionOptions, NewsCollectionResult } from "./newsService";
import { expandLegacyItems, readBundledReport } from "./reportStore";

describe("durable news refresh", () => {
  it.each([
    ["the production default", undefined, 45_000],
    ["an explicit override", 9_000, 9_000],
  ])("forwards %s collection budget while reserving retry slots", async (_label, override, expected) => {
    const initial = readBundledReport();
    const now = new Date("2026-07-15T23:45:00.000Z");
    const store = new InMemoryNewsStore(initial, () => now);
    const readRecentCandidates = vi.spyOn(store, "readRecentCandidates");
    const sources = newsSources.filter((source) => source.enabled).slice(0, 11);
    const collect = vi.fn(async (_options: NewsCollectionOptions): Promise<NewsCollectionResult> => ({
      items: [],
      mode: "No live data",
      sourceOutcomes: sources.map((source) => ({
        sourceId: source.source_id,
        status: "empty",
        discoveredCount: 0,
        errorCode: null,
      })),
    }));
    const originalBudget = process.env.DAILY_NEWS_COLLECTION_BUDGET_MS;
    delete process.env.DAILY_NEWS_COLLECTION_BUDGET_MS;

    try {
      await runNewsRefresh(
        {
          trigger: "cron",
          scheduledAt: now,
          idempotencyKey: `refresh:collection-budget:${expected}`,
          ...(override === undefined ? {} : { collectionBudgetMs: override }),
        },
        { store, now: () => now, sources, collect },
      );
    } finally {
      if (originalBudget === undefined) {
        delete process.env.DAILY_NEWS_COLLECTION_BUDGET_MS;
      } else {
        process.env.DAILY_NEWS_COLLECTION_BUDGET_MS = originalBudget;
      }
    }

    expect(collect).toHaveBeenCalledOnce();
    expect(collect.mock.calls[0]?.[0]).toMatchObject({
      maxSources: 11,
      collectionBudgetMs: expected,
    });
    expect(readRecentCandidates).toHaveBeenCalledWith(expect.any(String));
  });

  it("merges newly collected candidates with the same canonical ordering as the rolling pool", () => {
    const now = new Date("2026-07-23T06:45:00.000Z");
    const stored = recentCandidates(now, "旧标题").slice(0, 2);
    const replacement = {
      ...stored[0]!,
      title: "更新后的标题",
      url: `${stored[0]!.url}?utm_source=refresh`,
      publishedAt: now.toISOString(),
    };
    const result = mergeRefreshCandidates(
      stored,
      [replacement],
      new Date(now.getTime() - 72 * 60 * 60_000).toISOString(),
    );

    expect(result).toHaveLength(2);
    expect(result[0]?.title).toBe("更新后的标题");
    expect(result.filter((candidate) => candidate.sourceId === replacement.sourceId)).toHaveLength(1);

    const withoutPublishedAt = { ...replacement, publishedAt: undefined, extractedAt: now.toISOString() };
    const inherited = mergeRefreshCandidates(
      stored,
      [withoutPublishedAt],
      new Date(now.getTime() - 72 * 60 * 60_000).toISOString(),
    );
    expect(inherited.find((candidate) => candidate.title === "更新后的标题")?.publishedAt).toBe(stored[0]?.publishedAt);
    expect(inherited.find((candidate) => candidate.title === "更新后的标题")?.extractedAt).toBe(stored[0]?.extractedAt);
  });

  it("does not revive an undated story when the same URL is rediscovered", () => {
    const now = new Date("2026-08-03T12:00:00.000Z");
    const firstDiscoveredAt = new Date(now.getTime() - 48 * 60 * 60_000).toISOString();
    const [oldTemplate, currentTemplate] = recentCandidates(now, "旧事件首次发现");
    const oldCandidate: RawNewsItem = {
      ...oldTemplate!,
      title: "两天前首次发现且没有发布时间的旧事件",
      publishedAt: undefined,
      updatedAt: undefined,
      discoveredAt: firstDiscoveredAt,
      extractedAt: firstDiscoveredAt,
    };
    const rediscovered = {
      ...oldCandidate,
      discoveredAt: now.toISOString(),
      extractedAt: now.toISOString(),
    };
    const currentCandidate: RawNewsItem = {
      ...currentTemplate!,
      title: "今天发生的完全不同的新事件",
      summary: "该事件今天发生，包含清晰的时间、参与机构、具体安排和后续影响。",
      publishedAt: new Date(now.getTime() - 60 * 60_000).toISOString(),
      discoveredAt: new Date(now.getTime() - 60 * 60_000).toISOString(),
      extractedAt: now.toISOString(),
    };

    const merged = mergeRefreshCandidates(
      [oldCandidate, currentCandidate],
      [rediscovered],
      new Date(now.getTime() - 72 * 60 * 60_000).toISOString(),
    );
    const mergedOld = merged.find((candidate) => candidate.url === oldCandidate.url);
    const report = buildDailyReport(merged, defaultPreferences, now);

    expect(mergedOld?.discoveredAt).toBe(firstDiscoveredAt);
    expect(report.stories.find((story) => story.evidence.some((entry) => entry.url === oldCandidate.url))?.updatedAt)
      .toBe(firstDiscoveredAt);
    expect(report.latestStories?.some((story) => story.evidence.some((entry) => entry.url === oldCandidate.url)))
      .toBe(false);
    expect(report.latestStories?.some((story) => story.evidence.some((entry) => entry.url === currentCandidate.url)))
      .toBe(true);
  });

  it("keeps a stored article update when the next collection omits updatedAt", () => {
    const now = new Date("2026-08-03T12:00:00.000Z");
    const oldAt = new Date(now.getTime() - 96 * 60 * 60_000).toISOString();
    const updatedAt = new Date(now.getTime() - 60 * 60_000).toISOString();
    const stored: RawNewsItem = {
      ...recentCandidates(now, "有真实更新时间的持续事件")[0]!,
      publishedAt: oldAt,
      discoveredAt: oldAt,
      extractedAt: oldAt,
      updatedAt,
    };
    const recollected = {
      ...stored,
      updatedAt: undefined,
      discoveredAt: now.toISOString(),
      extractedAt: now.toISOString(),
    };

    const merged = mergeRefreshCandidates(
      [stored],
      [recollected],
      new Date(now.getTime() - 72 * 60 * 60_000).toISOString(),
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]?.updatedAt).toBe(updatedAt);
    expect(merged[0]?.discoveredAt).toBe(oldAt);
  });

  it("overlaps candidate reads and persistence with collection and report building", async () => {
    const initial = readBundledReport();
    const now = new Date("2026-07-23T06:45:00.000Z");
    const store = new InMemoryNewsStore(initial, () => now);
    const sources = newsSources.filter((source) => source.enabled).slice(0, 10);
    const candidates = recentCandidates(now, "并行刷新候选");
    const events: string[] = [];
    let completedWrites = 0;

    const originalRead = store.readRecentCandidates.bind(store);
    vi.spyOn(store, "readRecentCandidates").mockImplementation(async (...args) => {
      events.push("read-start");
      const result = await originalRead(...args);
      events.push("read-end");
      return result;
    });
    const originalRecord = store.recordSourceResults.bind(store);
    vi.spyOn(store, "recordSourceResults").mockImplementation(async (...args) => {
      events.push("record-start");
      await new Promise((resolve) => setTimeout(resolve, 20));
      const result = await originalRecord(...args);
      completedWrites += 1;
      events.push("record-end");
      return result;
    });
    const originalUpsert = store.upsertCandidates.bind(store);
    vi.spyOn(store, "upsertCandidates").mockImplementation(async (...args) => {
      events.push("upsert-start");
      await new Promise((resolve) => setTimeout(resolve, 20));
      const result = await originalUpsert(...args);
      completedWrites += 1;
      events.push("upsert-end");
      return result;
    });
    const collect = vi.fn(async (): Promise<NewsCollectionResult> => {
      events.push("collect-start");
      await Promise.resolve();
      expect(events).toContain("read-start");
      events.push("collect-end");
      return {
        items: candidates,
        mode: "Direct source fetch",
        sourceOutcomes: sources.map((source) => ({
          sourceId: source.source_id,
          status: candidates.some((candidate) => candidate.sourceId === source.source_id) ? "success" : "empty",
          discoveredCount: candidates.filter((candidate) => candidate.sourceId === source.source_id).length,
          errorCode: null,
        })),
      };
    });
    const buildReport = vi.fn((items: RawNewsItem[], reportNow: Date) => {
      events.push("build");
      expect(completedWrites).toBe(0);
      return buildDailyReport(items, defaultPreferences, reportNow);
    });

    const result = await runNewsRefresh(
      { trigger: "cron", scheduledAt: now, idempotencyKey: "refresh:parallel-persistence" },
      { store, now: () => now, sources, collect, buildReport },
    );

    expect(result.status).toBe("published");
    expect(buildReport).toHaveBeenCalledOnce();
    expect(events.indexOf("read-start")).toBeLessThan(events.indexOf("collect-end"));
    expect(events.indexOf("build")).toBeLessThan(events.indexOf("record-end"));
    expect(events.indexOf("build")).toBeLessThan(events.indexOf("upsert-end"));
    expect(completedWrites).toBe(2);
  });

  it("uses the atomic store commit for a changed Supabase-style refresh", async () => {
    const initial = readBundledReport();
    const now = new Date("2026-07-23T09:15:00.000Z");
    const store = new InMemoryNewsStore(initial, () => now);
    const candidates = recentCandidates(now, "原子提交刷新候选");
    const recordSourceResults = vi.spyOn(store, "recordSourceResults");
    const upsertCandidates = vi.spyOn(store, "upsertCandidates");
    const publishRefresh = vi.spyOn(store, "publishRefresh");
    const commitRefresh = vi.fn(async (
      input: Parameters<NonNullable<NewsStore["commitRefresh"]>>[0],
      _sourceResults: Parameters<NonNullable<NewsStore["commitRefresh"]>>[1],
      _candidates: Parameters<NonNullable<NewsStore["commitRefresh"]>>[2],
    ) => ({
      published: true,
      reportId: input.reportId,
      previousReportId: null,
      lastSuccessAt: input.dataAsOf,
    }));
    Object.assign(store, { commitRefresh });

    const result = await runNewsRefresh(
      { trigger: "cron", scheduledAt: now, idempotencyKey: "refresh:atomic-commit" },
      { store, now: () => now, collect: collection(candidates) },
    );

    expect(result.status).toBe("published");
    expect(commitRefresh).toHaveBeenCalledOnce();
    expect(commitRefresh.mock.calls[0]?.[1]).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: candidates[0]?.sourceId }),
    ]));
    const committedCandidates = commitRefresh.mock.calls[0]?.[2] ?? [];
    expect(committedCandidates).toHaveLength(candidates.length);
    expect(committedCandidates.map((candidate) => candidate.url)).toEqual(candidates.map((candidate) => candidate.url));
    expect(committedCandidates.every((candidate) => Boolean(candidate.discoveredAt))).toBe(true);
    expect(recordSourceResults).not.toHaveBeenCalled();
    expect(upsertCandidates).not.toHaveBeenCalled();
    expect(publishRefresh).not.toHaveBeenCalled();
  });

  it("publishes changed live candidates from the rolling pool", async () => {
    const initial = readBundledReport();
    const now = new Date("2026-07-13T08:00:00.000Z");
    const store = new InMemoryNewsStore(initial, () => now);
    const candidates = recentCandidates(now, "新的实时事件：公开机构发布重要安排");

    const result = await runNewsRefresh(
      { trigger: "cron", scheduledAt: now, idempotencyKey: "refresh:changed" },
      { store, now: () => now, collect: collection(candidates) },
    );

    expect(result.status).toBe("published");
    expect(result.reportId).not.toBeNull();
    expect((await store.readState()).latest?.report.generatedAt).toBe(now.toISOString());
  });

  it("keeps report identity and generatedAt when a successful scan finds no new content", async () => {
    const initial = readBundledReport();
    const now = new Date("2026-07-13T08:00:00.000Z");
    const store = new InMemoryNewsStore(initial, () => now);
    const before = await store.readState();

    const result = await runNewsRefresh(
      { trigger: "cron", scheduledAt: now, idempotencyKey: "refresh:quiet" },
      { store, now: () => now, collect: collection([]) },
    );
    const after = await store.readState();

    expect(result.status).toBe("unchanged");
    expect(after.latest?.reportId).toBe(before.latest?.reportId);
    expect(after.latest?.report.generatedAt).toBe(initial.generatedAt);
    expect(after.latest?.dataAsOf).toBe(initial.generatedAt);
    expect(after.runtime.lastSuccessAt).toBe(now.toISOString());
  });

  it("does not create another report when the candidate content is unchanged", async () => {
    const initial = readBundledReport();
    let now = new Date("2026-07-13T08:00:00.000Z");
    const store = new InMemoryNewsStore(initial, () => now);
    const candidates = recentCandidates(now, "第一轮实时事件：公开机构发布重要安排");
    const first = await runNewsRefresh(
      { trigger: "cron", scheduledAt: now, idempotencyKey: "refresh:first" },
      { store, now: () => now, collect: collection(candidates) },
    );
    const firstReport = await store.readState();
    expect(firstReport.latest?.contentHash).toBe(hashReportContent(firstReport.latest!.report));

    const hydratedState = structuredClone(firstReport);
    hydratedState.latest!.report.items[0]!.summary = "兼容读取会重建旧字段，但数据库内容哈希仍代表原始发布内容";
    expect(hashReportContent(hydratedState.latest!.report)).not.toBe(hydratedState.latest?.contentHash);
    const readState = vi.spyOn(store, "readState").mockResolvedValueOnce(hydratedState);

    const second = await runNewsRefresh(
      { trigger: "cron", scheduledAt: now, idempotencyKey: "refresh:second" },
      { store, now: () => now, collect: collection(candidates) },
    );
    readState.mockRestore();
    const secondReport = await store.readState();

    expect(first.status).toBe("published");
    expect(second.status).toBe("unchanged");
    expect(secondReport.latest?.reportId).toBe(firstReport.latest?.reportId);
    expect(secondReport.latest?.report.generatedAt).toBe(firstReport.latest?.report.generatedAt);
    expect(secondReport.latest?.dataAsOf).toBe(firstReport.latest?.dataAsOf);
  });

  it("keeps old report content time when no sources are due", async () => {
    const initial = readBundledReport();
    const now = new Date(initial.generatedAt);
    const store = new InMemoryNewsStore(initial, () => now);
    const seedLease = await store.tryAcquireRefresh({
      ownerId: "00000000-0000-4000-8000-000000000001",
      idempotencyKey: "refresh:source-seed",
      trigger: "local",
      scheduledAt: now.toISOString(),
      leaseSeconds: 120,
    });
    expect(seedLease.acquired).toBe(true);
    const seedIdentity = {
      ownerId: seedLease.ownerId,
      runId: seedLease.runId,
      fencingToken: seedLease.fencingToken,
    };
    await store.syncSources(
      seedIdentity,
      newsSources.map((source) => ({ sourceId: source.source_id, enabled: source.enabled, intervalMinutes: 90 })),
      now.toISOString(),
    );
    await store.recordSourceResults(
      seedIdentity,
      newsSources
        .filter((source) => source.enabled)
        .map((source) => ({
          sourceId: source.source_id,
          status: "empty" as const,
          attemptedAt: now.toISOString(),
          nextDueAt: new Date(now.getTime() + 90 * 60_000).toISOString(),
          discoveredCount: 0,
          acceptedCount: 0,
          errorCode: null,
        })),
    );
    await store.completeRefreshWithoutPublish(seedIdentity, { outcome: "source_seed" });
    const before = await store.readState();
    const syncSources = vi.spyOn(store, "syncSources");

    const result = await runNewsRefresh(
      { trigger: "cron", scheduledAt: new Date(now.getTime() + 15 * 60_000), idempotencyKey: "refresh:no-sources" },
      { store, now: () => new Date(now.getTime() + 15 * 60_000), collect: collection([]) },
    );
    const after = await store.readState();

    expect(result.status).toBe("unchanged");
    expect(after.latest?.reportId).toBe(before.latest?.reportId);
    expect(after.latest?.dataAsOf).toBe(before.latest?.dataAsOf);
    expect(syncSources).toHaveBeenCalledOnce();
  });

  it("retries pending translations every cron tick even when no source is due", async () => {
    const initial = readBundledReport();
    const now = new Date("2026-08-03T00:00:00.000Z");
    const scheduledAt = new Date(now.getTime() + 5 * 60_000);
    let storeNow = now;
    const store = new InMemoryNewsStore(initial, () => storeNow);
    const source = newsSources.find((candidate) => candidate.source_id === "xinhua")!;
    const oldEventAt = new Date(now.getTime() - 48 * 60 * 60_000);
    const pendingCandidate: RawNewsItem = {
      id: "pending-no-source-due",
      title: "Original title awaiting translation",
      url: "https://www.news.cn/world/20260803/pending-translation.htm",
      sourceId: source.source_id,
      sourceName: source.name,
      language: "en-US",
      region: "china",
      categories: ["international"],
      primaryCategory: "international",
      summary: "A complete factual summary remains visible while the Chinese translation is pending.",
      publishedAt: oldEventAt.toISOString(),
      discoveredAt: oldEventAt.toISOString(),
      extractedAt: oldEventAt.toISOString(),
      qualityStatus: "degraded",
      rejectionReasons: ["translation_failed"],
      translationStatus: "pending",
      summaryStatus: "complete",
      timeStatus: "verified",
    };
    const recentCandidate: RawNewsItem = {
      ...pendingCandidate,
      id: "current-control-story",
      title: "当前中文新闻标题",
      url: "https://www.news.cn/world/20260803/current-control-story.htm",
      language: "zh-CN",
      summary: "当前中文新闻摘要包含主体、事实、时间和后续安排。",
      publishedAt: now.toISOString(),
      discoveredAt: now.toISOString(),
      extractedAt: now.toISOString(),
      qualityStatus: "display_ready",
      rejectionReasons: [],
      translationStatus: "original",
    };
    const seedLease = await store.tryAcquireRefresh({
      ownerId: "00000000-0000-4000-8000-000000000005",
      idempotencyKey: "refresh:pending-translation-seed",
      trigger: "local",
      scheduledAt: now.toISOString(),
      leaseSeconds: 120,
    });
    const seedIdentity = {
      ownerId: seedLease.ownerId,
      runId: seedLease.runId,
      fencingToken: seedLease.fencingToken,
    };
    await store.syncSources(seedIdentity, [{ sourceId: source.source_id, enabled: true, intervalMinutes: 30 }], now.toISOString());
    await store.completeRefreshWithoutPublish(
      seedIdentity,
      { outcome: "unchanged" },
      [{
        sourceId: source.source_id,
        status: "success",
        attemptedAt: now.toISOString(),
        nextDueAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
        discoveredCount: 2,
        acceptedCount: 2,
        errorCode: null,
      }],
      [pendingCandidate, recentCandidate],
    );
    storeNow = scheduledAt;

    const previousKey = process.env.DAILY_NEWS_TRANSLATION_API_KEY;
    process.env.DAILY_NEWS_TRANSLATION_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({
          title: "补译后的中文标题",
          summary: "补译更新同一候选和事件，不需要等待任何新闻来源再次到期。",
        }) } }],
      }),
    } as Response));
    const collect = vi.fn(collection([]));

    try {
      const result = await runNewsRefresh(
        { trigger: "cron", scheduledAt, idempotencyKey: "refresh:pending-translation-retry" },
        { store, now: () => scheduledAt, sources: [source], collect },
      );
      const latest = (await store.readState()).latest?.report;

      expect(collect).not.toHaveBeenCalled();
      expect(result.status).toBe("published");
      expect(latest?.stories).toHaveLength(2);
      const translatedStory = latest?.stories.find((story) =>
        story.evidence.some((evidence) => evidence.candidateId === pendingCandidate.id),
      );
      expect(translatedStory).toMatchObject({
        title: "补译后的中文标题",
        translationStatus: "translated",
        updatedAt: oldEventAt.toISOString(),
      });
      const translatedItem = latest?.items.find((item) => item.id === translatedStory?.itemId);
      expect(translatedItem?.enrichmentUpdatedAt).toBe(scheduledAt.toISOString());
      expect(latest?.latestStories?.flatMap((story) => story.evidence.map((evidence) => evidence.candidateId))).toEqual([
        recentCandidate.id,
      ]);
    } finally {
      if (previousKey === undefined) delete process.env.DAILY_NEWS_TRANSLATION_API_KEY;
      else process.env.DAILY_NEWS_TRANSLATION_API_KEY = previousKey;
      vi.unstubAllGlobals();
    }
  });

  it("selects a source that becomes due while refresh setup is running", async () => {
    const initial = readBundledReport();
    const previousAttemptAt = new Date("2026-07-15T08:30:01.518Z");
    const scheduledAt = new Date("2026-07-15T10:00:01.514Z");
    const selectionAt = new Date("2026-07-15T10:00:03.547Z");
    let storeNow = previousAttemptAt;
    const store = new InMemoryNewsStore(initial, () => storeNow);
    const source = newsSources.find((candidate) => candidate.enabled)!;
    const seedLease = await store.tryAcquireRefresh({
      ownerId: "00000000-0000-4000-8000-000000000002",
      idempotencyKey: "refresh:source-boundary-seed",
      trigger: "local",
      scheduledAt: previousAttemptAt.toISOString(),
      leaseSeconds: 120,
    });
    expect(seedLease.acquired).toBe(true);
    const seedIdentity = {
      ownerId: seedLease.ownerId,
      runId: seedLease.runId,
      fencingToken: seedLease.fencingToken,
    };
    await store.syncSources(
      seedIdentity,
      [{ sourceId: source.source_id, enabled: true, intervalMinutes: 90 }],
      previousAttemptAt.toISOString(),
    );
    await store.recordSourceResults(seedIdentity, [{
      sourceId: source.source_id,
      status: "empty",
      attemptedAt: previousAttemptAt.toISOString(),
      nextDueAt: "2026-07-15T10:00:01.518Z",
      discoveredCount: 0,
      acceptedCount: 0,
      errorCode: null,
    }]);
    await store.completeRefreshWithoutPublish(seedIdentity, { outcome: "source_boundary_seed" });
    storeNow = selectionAt;

    const result = await runNewsRefresh(
      { trigger: "cron", scheduledAt, idempotencyKey: "refresh:source-boundary", maxSources: 1 },
      {
        store,
        now: () => selectionAt,
        sources: [source],
        collect: async () => ({
          items: [],
          mode: "No live data",
          sourceOutcomes: [{
            sourceId: source.source_id,
            status: "empty",
            discoveredCount: 0,
            errorCode: null,
          }],
        }),
      },
    );

    expect(result.selectedSourceIds).toEqual([source.source_id]);
    const sourceState = (await store.readState()).sources[0];
    expect(sourceState?.lastAttemptAt).toBe(scheduledAt.toISOString());
    expect(sourceState?.nextDueAt).toBe(new Date(scheduledAt.getTime() + 30 * 60_000).toISOString());
  });

  it("fits a half-open recovery alongside a nine-source healthy cohort", () => {
    const enabledSources = newsSources.filter((source) => source.enabled);
    const now = new Date("2026-07-15T15:45:01.790Z");
    const recoveringSource = enabledSources[0];
    const healthyCohort = enabledSources.slice(1, 10);
    const expectedSourceIds = new Set([recoveringSource.source_id, ...healthyCohort.map((source) => source.source_id)]);
    const health = enabledSources.map((source) => ({
      sourceId: source.source_id,
      consecutiveFailures: source === recoveringSource ? 4 : 0,
      nextDueAt:
        source === recoveringSource
          ? "2026-07-15T14:15:01.790Z"
          : healthyCohort.includes(source)
            ? "2026-07-15T15:45:01.599Z"
            : "2026-07-15T16:00:00.000Z",
      circuitOpenUntil: source === recoveringSource ? now.toISOString() : null,
      intervalMinutes: 90,
    }));

    const selected = selectSourcesForCoverage(enabledSources, defaultServerlessMaxSources, { health, now });

    expect(selected).toHaveLength(10);
    expect(new Set(selected.map((source) => source.source_id))).toEqual(expectedSourceIds);
  });

  it("does not advance source state for skipped or missing collection outcomes", async () => {
    const initial = readBundledReport();
    const now = new Date(initial.generatedAt);
    const store = new InMemoryNewsStore(initial, () => now);
    const sources = newsSources.filter((source) => source.enabled).slice(0, 3);

    const result = await runNewsRefresh(
      { trigger: "cron", scheduledAt: now, idempotencyKey: "refresh:skipped-source", maxSources: 3 },
      {
        store,
        now: () => now,
        sources,
        collect: async () => ({
          items: [],
          mode: "No live data",
          sourceOutcomes: [
            { sourceId: sources[0].source_id, status: "empty", discoveredCount: 0, errorCode: null },
            { sourceId: sources[1].source_id, status: "skipped", discoveredCount: 0, errorCode: "collection_deadline" },
          ],
        }),
      },
    );
    const state = await store.readState();
    const attempted = state.sources.find((source) => source.sourceId === sources[0].source_id);
    const skipped = state.sources.find((source) => source.sourceId === sources[1].source_id);
    const missing = state.sources.find((source) => source.sourceId === sources[2].source_id);

    expect(result.selectedSourceIds).toEqual([sources[0].source_id]);
    expect(result.status).toBe("partial");
    expect(attempted?.lastAttemptAt).toBe(now.toISOString());
    expect(skipped?.lastAttemptAt).toBeNull();
    expect(skipped?.nextDueAt).toBe(now.toISOString());
    expect(missing?.lastAttemptAt).toBeNull();
    expect(missing?.nextDueAt).toBe(now.toISOString());
  });

  it("does not report planned sources as attempted when collection throws", async () => {
    const initial = readBundledReport();
    const now = new Date(initial.generatedAt);
    const store = new InMemoryNewsStore(initial, () => now);
    const sources = newsSources.filter((source) => source.enabled).slice(0, 2);

    const result = await runNewsRefresh(
      { trigger: "cron", scheduledAt: now, idempotencyKey: "refresh:collector-error", maxSources: 2 },
      {
        store,
        now: () => now,
        sources,
        collect: async () => {
          throw new Error("collector failed");
        },
      },
    );
    const state = await store.readState();

    expect(result.status).toBe("failed");
    expect(result.selectedSourceIds).toEqual([]);
    expect(state.sources.every((source) => source.lastAttemptAt === null)).toBe(true);
  });

  it("terminalizes an acquired lease when the first state read fails", async () => {
    const initial = readBundledReport();
    const now = new Date("2026-08-03T12:00:00.000Z");
    const store = new InMemoryNewsStore(initial, () => now);
    const originalReadState = store.readState.bind(store);
    vi.spyOn(store, "readState").mockRejectedValueOnce(new Error("state read failed")).mockImplementation(originalReadState);
    const markRefreshFailed = vi.spyOn(store, "markRefreshFailed");

    const result = await runNewsRefresh(
      { trigger: "cron", scheduledAt: now, idempotencyKey: "refresh:state-read-failure" },
      { store, now: () => now },
    );

    expect(result.status).toBe("failed");
    expect(markRefreshFailed).toHaveBeenCalledOnce();
    expect((await originalReadState()).runtime.lastErrorCode).toBe("refresh_failed");
    const retry = await store.tryAcquireRefresh({
      ownerId: "00000000-0000-4000-8000-000000000099",
      idempotencyKey: "refresh:state-read-retry",
      trigger: "cron",
      scheduledAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
      leaseSeconds: 120,
    });
    expect(retry.acquired).toBe(true);
  });

  it("does not partially persist collection data when report building fails", async () => {
    const initial = readBundledReport();
    const now = new Date("2026-08-03T12:00:00.000Z");
    const store = new InMemoryNewsStore(initial, () => now);
    const recordSourceResults = vi.spyOn(store, "recordSourceResults");
    const upsertCandidates = vi.spyOn(store, "upsertCandidates");
    const candidates = recentCandidates(now, "构建失败前发现的候选").slice(0, 1);

    const result = await runNewsRefresh(
      { trigger: "cron", scheduledAt: now, idempotencyKey: "refresh:build-failure" },
      {
        store,
        now: () => now,
        collect: collection(candidates),
        buildReport: () => { throw new Error("report build failed"); },
      },
    );

    expect(result.status).toBe("failed");
    expect(recordSourceResults).not.toHaveBeenCalled();
    expect(upsertCandidates).not.toHaveBeenCalled();
    expect(await store.readRecentCandidates("2026-08-01T00:00:00.000Z")).toEqual([]);
  });

  it("does not partially persist collection data when report invariants fail", async () => {
    const initial = readBundledReport();
    const now = new Date("2026-08-03T12:00:00.000Z");
    const store = new InMemoryNewsStore(initial, () => now);
    const recordSourceResults = vi.spyOn(store, "recordSourceResults");
    const upsertCandidates = vi.spyOn(store, "upsertCandidates");
    const candidates = recentCandidates(now, "结构校验失败前发现的候选").slice(0, 2);
    const valid = buildDailyReport(candidates, defaultPreferences, now);
    const invalid = { ...valid, stories: [...valid.stories, valid.stories[0]!] };

    const result = await runNewsRefresh(
      { trigger: "cron", scheduledAt: now, idempotencyKey: "refresh:invariant-failure" },
      { store, now: () => now, collect: collection(candidates), buildReport: () => invalid },
    );

    expect(result).toMatchObject({ status: "rejected", errorCode: "report_invariant_failed" });
    expect(recordSourceResults).not.toHaveBeenCalled();
    expect(upsertCandidates).not.toHaveBeenCalled();
    expect(await store.readRecentCandidates("2026-08-01T00:00:00.000Z")).toEqual([]);
  });

  it("publishes a structurally valid small candidate pool", async () => {
    const initial = readBundledReport();
    const now = new Date("2026-07-13T08:00:00.000Z");
    const store = new InMemoryNewsStore(initial, () => now);
    const before = await store.readState();
    const oneCandidate = recentCandidates(now, "单条候选").slice(0, 1);

    const result = await runNewsRefresh(
      { trigger: "cron", scheduledAt: now, idempotencyKey: "refresh:rejected" },
      { store, now: () => now, collect: collection(oneCandidate) },
    );

    expect(result.status).toBe("published");
    expect((await store.readState()).latest?.reportId).not.toBe(before.latest?.reportId);
  });

  it("allows stale candidates without treating the service as failed", async () => {
    const initial = readBundledReport();
    const now = new Date("2026-07-13T08:00:00.000Z");
    const store = new InMemoryNewsStore(initial, () => now);
    const before = await store.readState();
    const staleCandidates = recentCandidates(now, "旧候选不能生成一份当前时间的报告").map((item) => ({
      ...item,
      publishedAt: new Date(now.getTime() - 121 * 60_000).toISOString(),
    }));

    const result = await runNewsRefresh(
      { trigger: "cron", scheduledAt: now, idempotencyKey: "refresh:stale-pool" },
      { store, now: () => now, collect: collection(staleCandidates) },
    );
    const after = await store.readState();

    expect(result).toMatchObject({ status: "published", errorCode: null });
    expect(after.latest?.reportId).not.toBe(before.latest?.reportId);
    expect(after.runtime.lastErrorCode).toBeNull();
  });

  it("publishes a structurally valid stale pool when no last-known-good exists", async () => {
    const now = new Date("2026-07-13T08:00:00.000Z");
    const store = new InMemoryNewsStore(null, () => now);
    const staleCandidates = recentCandidates(now, "无可用报告时拒绝旧候选").map((item) => ({
      ...item,
      publishedAt: new Date(now.getTime() - 121 * 60_000).toISOString(),
    }));

    const result = await runNewsRefresh(
      { trigger: "cron", scheduledAt: now, idempotencyKey: "refresh:stale-pool-without-lkg" },
      { store, now: () => now, collect: collection(staleCandidates) },
    );

    expect(result).toMatchObject({ status: "published", errorCode: null });
    expect((await store.readState()).latest).not.toBeNull();
  });

  it("does not let curated homepage freshness block a valid report", async () => {
    const initial = readBundledReport();
    const now = new Date("2026-07-13T08:00:00.000Z");
    const store = new InMemoryNewsStore(initial, () => now);
    const before = await store.readState();
    const candidates = recentCandidates(now, "候选池包含新的实时事件");
    const freshReport = buildDailyReport(candidates, defaultPreferences, now);
    const topIds = new Set(freshReport.topStories.map((story) => story.id));
    const staleAt = new Date(now.getTime() - 121 * 60_000).toISOString();
    const stories = freshReport.stories.map((story) =>
      topIds.has(story.id)
        ? {
            ...story,
            startedAt: staleAt,
            publishedAt: staleAt,
            updatedAt: staleAt,
            evidence: story.evidence.map((evidence) => ({ ...evidence, publishedAt: staleAt })),
          }
        : story,
    );
    const storyById = new Map(stories.map((story) => [story.id, story]));
    const latestStories = selectLatestStories(stories, now);
    const staleHomepage = {
      ...freshReport,
      stories,
      latestStories,
      topStories: freshReport.topStories.map((story) => storyById.get(story.id)!),
      importantStories: [],
      watchlist: [],
      quality: { ...freshReport.quality, latestEventCount: latestStories.length },
    };

    const result = await runNewsRefresh(
      { trigger: "cron", scheduledAt: now, idempotencyKey: "refresh:stale-homepage" },
      { store, now: () => now, collect: collection(candidates), buildReport: () => staleHomepage },
    );

    expect(result).toMatchObject({ status: "published", errorCode: null });
    expect((await store.readState()).latest?.reportId).not.toBe(before.latest?.reportId);
  });

  it("changes the content hash when homepage curation changes but ignores generatedAt alone", () => {
    const report = readBundledReport();
    const generatedLater = { ...report, generatedAt: new Date(Date.parse(report.generatedAt) + 60_000).toISOString() };
    const reordered = { ...report, topStories: [...report.topStories].reverse() };
    const summaryChanged = {
      ...report,
      stories: report.stories.map((story, index) => index === 0 ? { ...story, whatHappened: `${story.whatHappened} 补充。` } : story),
    };
    const translationChanged = {
      ...report,
      stories: report.stories.map((story, index) => index === 0 ? { ...story, translationStatus: "translated" as const } : story),
    };
    const latestReordered = { ...report, latestStories: [...(report.latestStories ?? [])].reverse() };
    const volatileRefresh = {
      ...report,
      refresh: {
        ...report.refresh,
        lastCheckedAt: "2026-08-03T01:00:00.000Z",
        activeRunId: "run-1",
      },
    };
    const volatileRefreshLater = {
      ...volatileRefresh,
      refresh: {
        ...volatileRefresh.refresh,
        lastCheckedAt: "2026-08-03T01:05:00.000Z",
        activeRunId: "run-2",
      },
    };

    expect(hashReportContent(generatedLater)).toBe(hashReportContent(report));
    expect(hashReportContent(reordered)).not.toBe(hashReportContent(report));
    expect(hashReportContent(summaryChanged)).not.toBe(hashReportContent(report));
    expect(hashReportContent(translationChanged)).not.toBe(hashReportContent(report));
    expect(hashReportContent(latestReordered)).not.toBe(hashReportContent(report));
    expect(hashReportContent(volatileRefreshLater)).toBe(hashReportContent(volatileRefresh));
  });
});

function recentCandidates(now: Date, title: string): RawNewsItem[] {
  const sourceItems = expandLegacyItems(readBundledReport().items).map((item, index) => ({
    ...item,
    title: index === 0 ? title : item.title,
    summary:
      index === 0
        ? "公开机构在今日发布了新的安排，内容包含具体时间、参与范围、执行步骤以及后续观察重点。"
        : item.summary,
    publishedAt: new Date(now.getTime() - (index + 1) * 60_000).toISOString(),
    extractedAt: now.toISOString(),
  }));
  return sourceItems;
}

function collection(items: RawNewsItem[]): (options: NewsCollectionOptions) => Promise<NewsCollectionResult> {
  return async (options) => ({
    items,
    mode: items.length > 0 ? "Direct source fetch" : "No live data",
    sourceOutcomes: (options.sources ?? []).map((source) => ({
        sourceId: source.source_id,
        status: items.some((item) => item.sourceId === source.source_id) ? "success" : "empty",
        discoveredCount: items.filter((item) => item.sourceId === source.source_id).length,
        errorCode: null,
      })),
  });
}
