import { describe, expect, it, vi } from "vitest";
import { newsSources } from "../src/config/sources";
import { selectSourcesForCoverage } from "../src/lib/sourceCoverage";
import type { RawNewsItem } from "../src/types";
import { InMemoryNewsStore } from "./inMemoryNewsStore";
import { defaultRefreshCandidateLimit, defaultServerlessMaxSources, hashReportContent, runNewsRefresh } from "./newsRefresh";
import type { NewsCollectionOptions, NewsCollectionResult } from "./newsService";
import { expandLegacyItems, readBundledReport } from "./reportStore";

describe("durable news refresh", () => {
  it.each([
    ["the production default", undefined, 12_000],
    ["an explicit override", 9_000, 9_000],
  ])("forwards %s collection budget while keeping the eleven-source recovery slot", async (_label, override, expected) => {
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
    expect(readRecentCandidates).toHaveBeenCalledWith(expect.any(String), defaultRefreshCandidateLimit);
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

    now = new Date("2026-07-13T08:15:00.000Z");
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
    expect(syncSources).not.toHaveBeenCalled();
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
    expect(sourceState?.nextDueAt).toBe(new Date(scheduledAt.getTime() + 90 * 60_000).toISOString());
  });

  it("fits a half-open recovery alongside a ten-source healthy cohort", () => {
    const enabledSources = newsSources.filter((source) => source.enabled);
    const now = new Date("2026-07-15T15:45:01.790Z");
    const recoveringSource = enabledSources[0];
    const healthyCohort = enabledSources.slice(1, 11);
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

    expect(selected).toHaveLength(11);
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

  it("rejects a collapsed candidate pool without replacing last-known-good", async () => {
    const initial = readBundledReport();
    const now = new Date("2026-07-13T08:00:00.000Z");
    const store = new InMemoryNewsStore(initial, () => now);
    const before = await store.readState();
    const oneCandidate = recentCandidates(now, "单条候选").slice(0, 1);

    const result = await runNewsRefresh(
      { trigger: "cron", scheduledAt: now, idempotencyKey: "refresh:rejected" },
      { store, now: () => now, collect: collection(oneCandidate) },
    );

    expect(result.status).toBe("rejected");
    expect((await store.readState()).latest?.reportId).toBe(before.latest?.reportId);
  });

  it("marks a stale candidate pool as failed without changing last-known-good dataAsOf", async () => {
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

    expect(result).toMatchObject({ status: "failed", errorCode: "stale_candidate_pool" });
    expect(after.latest?.reportId).toBe(before.latest?.reportId);
    expect(after.latest?.dataAsOf).toBe(before.latest?.dataAsOf);
    expect(after.runtime.lastErrorCode).toBe("stale_candidate_pool");
  });

  it("rejects a stale candidate pool when no last-known-good exists", async () => {
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

    expect(result).toMatchObject({ status: "rejected", errorCode: "stale_candidate_pool", reportId: null });
    expect((await store.readState()).latest).toBeNull();
  });

  it("rejects a report whose selected homepage content is stale even when the pool has a fresh candidate", async () => {
    const initial = readBundledReport();
    const now = new Date("2026-07-13T08:00:00.000Z");
    const store = new InMemoryNewsStore(initial, () => now);
    const before = await store.readState();
    const candidates = recentCandidates(now, "候选池包含新的实时事件");
    const staleHomepage = {
      ...initial,
      generatedAt: now.toISOString(),
      topStories: initial.topStories.map((story) => ({
        ...story,
        updatedAt: new Date(now.getTime() - 121 * 60_000).toISOString(),
        evidence: story.evidence.map((evidence) => ({
          ...evidence,
          publishedAt: new Date(now.getTime() - 121 * 60_000).toISOString(),
        })),
      })),
      importantStories: [],
      watchlist: [],
    };

    const result = await runNewsRefresh(
      { trigger: "cron", scheduledAt: now, idempotencyKey: "refresh:stale-homepage" },
      { store, now: () => now, collect: collection(candidates), buildReport: () => staleHomepage },
    );

    expect(result).toMatchObject({ status: "failed", errorCode: "stale_homepage_selection" });
    expect((await store.readState()).latest?.reportId).toBe(before.latest?.reportId);
  });

  it("changes the content hash when homepage curation changes but ignores generatedAt alone", () => {
    const report = readBundledReport();
    const generatedLater = { ...report, generatedAt: new Date(Date.parse(report.generatedAt) + 60_000).toISOString() };
    const reordered = { ...report, topStories: [...report.topStories].reverse() };

    expect(hashReportContent(generatedLater)).toBe(hashReportContent(report));
    expect(hashReportContent(reordered)).not.toBe(hashReportContent(report));
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

function collection(items: RawNewsItem[]): () => Promise<NewsCollectionResult> {
  return async () => ({
    items,
    mode: items.length > 0 ? "Direct source fetch" : "No live data",
    sourceOutcomes: newsSources
      .filter((source) => source.enabled)
      .slice(0, 10)
      .map((source) => ({
        sourceId: source.source_id,
        status: items.some((item) => item.sourceId === source.source_id) ? "success" : "empty",
        discoveredCount: items.filter((item) => item.sourceId === source.source_id).length,
        errorCode: null,
      })),
  });
}
