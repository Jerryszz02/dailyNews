import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { RawNewsItem } from "../src/types";
import { InMemoryNewsStore } from "./inMemoryNewsStore";
import type { LeaseIdentity } from "./newsStore";
import { readBundledReport } from "./reportStore";

describe("NewsStore contract", () => {
  it("deduplicates candidates by source and canonical URL", async () => {
    const now = new Date("2026-07-13T08:00:00.000Z");
    const store = new InMemoryNewsStore(readBundledReport(), () => now);
    const lease = await acquire(store, now);
    const candidate = rawCandidate();

    await store.upsertCandidates(lease, [candidate, { ...candidate, summary: "更新后的摘要" }]);
    const candidates = await store.readRecentCandidates("2026-07-12T00:00:00.000Z");

    expect(candidates).toHaveLength(1);
    expect(candidates[0].summary).toBe("更新后的摘要");
  });

  it("allows only one concurrent lease owner", async () => {
    const now = new Date("2026-07-13T08:00:00.000Z");
    const store = new InMemoryNewsStore(readBundledReport(), () => now);
    const leases = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        store.tryAcquireRefresh({
          ownerId: randomUUID(),
          idempotencyKey: `slot-${index}`,
          trigger: "cron",
          scheduledAt: now.toISOString(),
          leaseSeconds: 120,
        }),
      ),
    );

    expect(leases.filter((lease) => lease.acquired)).toHaveLength(1);
    expect(leases.filter((lease) => lease.outcome === "busy")).toHaveLength(9);
  });

  it("rejects a stale fencing token after lease takeover", async () => {
    let now = new Date("2026-07-13T08:00:00.000Z");
    const store = new InMemoryNewsStore(readBundledReport(), () => now);
    const first = await acquire(store, now, 1);
    now = new Date("2026-07-13T08:00:02.000Z");
    const second = await acquire(store, now, 120, "second-slot");

    expect(second.fencingToken).toBeGreaterThan(first.fencingToken);
    await expect(store.upsertCandidates(first, [rawCandidate()])).rejects.toThrow("refresh_lease_invalid");
    await expect(store.upsertCandidates(second, [rawCandidate()])).resolves.toBe(1);
  });

  it("retries an expired or failed idempotent run but deduplicates a completed run", async () => {
    let now = new Date("2026-07-13T08:00:00.000Z");
    const store = new InMemoryNewsStore(readBundledReport(), () => now);
    const idempotencyKey = "same-slot";
    const first = await acquire(store, now, 1, idempotencyKey);

    now = new Date("2026-07-13T08:00:02.000Z");
    const retried = await store.tryAcquireRefresh({
      ownerId: randomUUID(),
      idempotencyKey,
      trigger: "cron",
      scheduledAt: now.toISOString(),
      leaseSeconds: 120,
    });
    expect(retried.acquired).toBe(true);
    expect(retried.runId).toBe(first.runId);

    await store.completeRefreshWithoutPublish(
      { ownerId: retried.ownerId, runId: retried.runId, fencingToken: retried.fencingToken },
      { outcome: "unchanged" },
    );
    const duplicate = await store.tryAcquireRefresh({
      ownerId: randomUUID(),
      idempotencyKey,
      trigger: "cron",
      scheduledAt: now.toISOString(),
      leaseSeconds: 120,
    });
    expect(duplicate.acquired).toBe(false);
    expect(duplicate.outcome).toBe("duplicate");
  });

  it("updates durable success time without replacing an unchanged report", async () => {
    const initial = readBundledReport();
    let now = new Date("2026-07-13T08:00:00.000Z");
    const store = new InMemoryNewsStore(initial, () => now);
    const before = await store.readState();
    const lease = await acquire(store, now);
    now = new Date("2026-07-13T08:00:10.000Z");

    await store.completeRefreshWithoutPublish(lease, { outcome: "unchanged" });
    const after = await store.readState();

    expect(after.latest?.reportId).toBe(before.latest?.reportId);
    expect(after.latest?.report.generatedAt).toBe(initial.generatedAt);
    expect(after.runtime.lastSuccessAt).toBe("2026-07-13T08:00:10.000Z");
  });

  it("publishes atomically and can roll back to the prior snapshot", async () => {
    const initial = readBundledReport();
    const now = new Date("2026-07-13T08:00:00.000Z");
    const store = new InMemoryNewsStore(initial, () => now);
    const before = await store.readState();
    const lease = await acquire(store, now);
    const report = {
      ...initial,
      generatedAt: now.toISOString(),
      notes: [...initial.notes, "contract publish"],
    };
    const reportId = randomUUID();

    const published = await store.publishRefresh({
      ...lease,
      reportId,
      report,
      dataAsOf: now.toISOString(),
      newestContentAt: report.items[0].publishedAt ?? null,
      contentHash: "content-hash",
      inputFingerprint: "input-fingerprint",
      metrics: {},
    });

    expect(published.published).toBe(true);
    expect((await store.readState()).latest?.reportId).toBe(reportId);
    await store.rollbackLatest(before.latest!.reportId, "contract_test");
    expect((await store.readState()).latest?.reportId).toBe(before.latest?.reportId);
  });
});

async function acquire(
  store: InMemoryNewsStore,
  now: Date,
  leaseSeconds = 120,
  idempotencyKey: string = randomUUID(),
): Promise<LeaseIdentity> {
  const lease = await store.tryAcquireRefresh({
    ownerId: randomUUID(),
    idempotencyKey,
    trigger: "manual",
    scheduledAt: now.toISOString(),
    leaseSeconds,
  });
  if (!lease.acquired) throw new Error("test lease not acquired");
  return { ownerId: lease.ownerId, runId: lease.runId, fencingToken: lease.fencingToken };
}

function rawCandidate(): RawNewsItem {
  return {
    id: "candidate-1",
    title: "测试新闻标题",
    url: "https://example.com/article?utm_source=test",
    sourceId: "xinhua",
    sourceName: "新华网",
    language: "zh-CN",
    region: "china",
    categories: ["china"],
    primaryCategory: "china",
    summary: "这是一条包含明确事实、机构、时间与后续安排的测试新闻摘要。",
    publishedAt: "2026-07-13T07:55:00.000Z",
    extractedAt: "2026-07-13T08:00:00.000Z",
    mayHavePaywall: false,
  };
}
