import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import type { RawNewsItem } from "../src/types";
import { SupabaseNewsStore } from "./supabaseNewsStore";

describe("SupabaseNewsStore RPC mapping", () => {
  it("retries transient read failures before starting a refresh", async () => {
    vi.useFakeTimers();
    try {
      let latestAttempts = 0;
      const rpc = vi.fn(async (name: string) => {
        if (name === "daily_news_read_latest") {
          latestAttempts += 1;
          if (latestAttempts === 1) return { data: null, error: { code: "" } };
          if (latestAttempts === 2) return { data: null, error: { code: "PGRST001" } };
          return { data: [], error: null };
        }
        return { data: [], error: null };
      });
      const store = new SupabaseNewsStore({ rpc } as unknown as SupabaseClient);

      const statePromise = store.readState();
      await vi.runAllTimersAsync();

      await expect(statePromise).resolves.toMatchObject({ latest: null, sources: [] });
      expect(latestAttempts).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry deterministic read failures", async () => {
    let latestAttempts = 0;
    const rpc = vi.fn(async (name: string) => {
      if (name === "daily_news_read_latest") {
        latestAttempts += 1;
        return { data: null, error: { code: "42501" } };
      }
      return { data: [], error: null };
    });
    const store = new SupabaseNewsStore({ rpc } as unknown as SupabaseClient);

    await expect(store.readState()).rejects.toMatchObject({ code: "supabase_permission_denied" });
    expect(latestAttempts).toBe(1);
  });

  it("retries transient JWT claim parsing failures from the Supabase gateway", async () => {
    vi.useFakeTimers();
    try {
      let latestAttempts = 0;
      const rpc = vi.fn(async (name: string) => {
        if (name === "daily_news_read_latest") {
          latestAttempts += 1;
          if (latestAttempts === 1) return { data: null, error: { code: "PGRST303" } };
        }
        return { data: [], error: null };
      });
      const store = new SupabaseNewsStore({ rpc } as unknown as SupabaseClient);

      const statePromise = store.readState();
      await vi.runAllTimersAsync();

      await expect(statePromise).resolves.toMatchObject({ latest: null, sources: [] });
      expect(latestAttempts).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry unknown deterministic database errors", async () => {
    let latestAttempts = 0;
    const rpc = vi.fn(async (name: string) => {
      if (name === "daily_news_read_latest") {
        latestAttempts += 1;
        return { data: null, error: { code: "22P02" } };
      }
      return { data: [], error: null };
    });
    const store = new SupabaseNewsStore({ rpc } as unknown as SupabaseClient);

    await expect(store.readState()).rejects.toMatchObject({ code: "supabase_request_failed", sourceCode: "22P02" });
    expect(latestAttempts).toBe(1);
  });

  it("stops after three transient read attempts", async () => {
    vi.useFakeTimers();
    try {
      let latestAttempts = 0;
      const rpc = vi.fn(async (name: string) => {
        if (name === "daily_news_read_latest") {
          latestAttempts += 1;
          return { data: null, error: { code: "PGRST000" } };
        }
        return { data: [], error: null };
      });
      const store = new SupabaseNewsStore({ rpc } as unknown as SupabaseClient);

      const rejection = expect(store.readState()).rejects.toMatchObject({ code: "supabase_request_failed" });
      await vi.runAllTimersAsync();

      await rejection;
      expect(latestAttempts).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out hanging read attempts before retrying", async () => {
    vi.useFakeTimers();
    try {
      let latestAttempts = 0;
      const rpc = vi.fn((name: string) => {
        if (name === "daily_news_read_latest") {
          latestAttempts += 1;
          return new Promise(() => undefined);
        }
        return Promise.resolve({ data: [], error: null });
      });
      const store = new SupabaseNewsStore({ rpc } as unknown as SupabaseClient);

      const rejection = expect(store.readState()).rejects.toMatchObject({ code: "supabase_request_failed" });
      await vi.runAllTimersAsync();

      await rejection;
      expect(latestAttempts).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never retries write RPC failures", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { code: "PGRST000" } }));
    const store = new SupabaseNewsStore({ rpc } as unknown as SupabaseClient);
    const lease = { ownerId: "00000000-0000-4000-8000-000000000001", runId: "00000000-0000-4000-8000-000000000002", fencingToken: 4 };

    await expect(store.syncSources(lease, [], "2026-07-13T08:00:00.000Z")).rejects.toMatchObject({
      code: "supabase_request_failed",
    });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("preserves enabled state when synchronizing the source registry", async () => {
    const rpc = vi.fn(async () => ({ data: [{ upserted_count: 2 }], error: null }));
    const store = new SupabaseNewsStore({ rpc } as unknown as SupabaseClient);
    const lease = { ownerId: "00000000-0000-4000-8000-000000000001", runId: "00000000-0000-4000-8000-000000000002", fencingToken: 4 };

    await store.syncSources(
      lease,
      [
        { sourceId: "source-on", enabled: true, intervalMinutes: 90 },
        { sourceId: "source-off", enabled: false, intervalMinutes: 120 },
      ],
      "2026-07-13T08:00:00.000Z",
    );

    expect(rpc).toHaveBeenCalledWith("daily_news_sync_sources", {
      lease_owner: lease.ownerId,
      run_id: lease.runId,
      fencing_token: lease.fencingToken,
      sources: [
        { source_id: "source-on", enabled: true, interval_minutes: 90 },
        { source_id: "source-off", enabled: false, interval_minutes: 120 },
      ],
      observed_at: "2026-07-13T08:00:00.000Z",
    });
  });

  it("maps source outcomes and candidates to the SQL contract", async () => {
    const rpc = vi.fn(async (name: string, _args?: Record<string, unknown>) => {
      if (name === "daily_news_upsert_candidates") return { data: [{ upserted_count: 1 }], error: null };
      return { data: [{ updated_count: 1 }], error: null };
    });
    const store = new SupabaseNewsStore({ rpc } as unknown as SupabaseClient);
    const lease = { ownerId: "00000000-0000-4000-8000-000000000001", runId: "00000000-0000-4000-8000-000000000002", fencingToken: 4 };

    await store.recordSourceResults(lease, [
      {
        sourceId: "xinhua",
        status: "empty",
        attemptedAt: "2026-07-13T08:00:00.000Z",
        nextDueAt: "2026-07-13T09:30:00.000Z",
        discoveredCount: 0,
        acceptedCount: 0,
        errorCode: null,
      },
    ]);
    await store.upsertCandidates(lease, [candidate()]);

    expect(rpc.mock.calls[0]).toEqual([
      "daily_news_record_source_results",
      expect.objectContaining({
        results: [
          expect.objectContaining({
            source_id: "xinhua",
            status: "empty",
            success: true,
            last_error_code: null,
          }),
        ],
      }),
    ]);
    const candidateArgs = rpc.mock.calls[1][1] as unknown as { candidates: Array<Record<string, unknown>> };
    expect(candidateArgs.candidates[0]).toMatchObject({
      source_id: "xinhua",
      canonical_url: "https://example.com/article",
      discovered_at: "2026-07-13T08:00:00.000Z",
      language: "zh-CN",
    });
    expect(candidateArgs.candidates[0]).not.toHaveProperty("candidate_id");
  });

  it("pages candidate reads beyond the PostgREST max_rows boundary", async () => {
    const available = Array.from({ length: 1_250 }, (_, index) => ({
      candidate: { ...candidate(), id: `candidate-${index}`, url: `https://example.com/article/${index}` },
    }));
    const ranges: Array<[number, number]> = [];
    let secondPageAttempts = 0;
    const rpc = vi.fn((_name: string, _args?: Record<string, unknown>) => ({
      range: async (from: number, to: number) => {
        ranges.push([from, to]);
        if (from === 1_000 && secondPageAttempts++ === 0) {
          return { data: null, error: { code: "PGRST003" } };
        }
        return { data: available.slice(from, to + 1), error: null };
      },
    }));
    const store = new SupabaseNewsStore({ rpc } as unknown as SupabaseClient);

    const result = await store.readRecentCandidates("2026-07-12T00:00:00.000Z", 2_000);

    expect(result).toHaveLength(1_250);
    expect(ranges).toEqual([
      [0, 999],
      [1_000, 1_999],
      [1_000, 1_999],
    ]);
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(rpc).toHaveBeenLastCalledWith("daily_news_read_candidates", {
      since: "2026-07-12T00:00:00.000Z",
      candidate_limit: 2_000,
    });
  });
});

function candidate(): RawNewsItem {
  return {
    id: "xinhua-existing-string-id",
    title: "测试新闻",
    url: "https://example.com/article?utm_source=test",
    sourceId: "xinhua",
    sourceName: "新华网",
    language: "zh-CN",
    region: "china",
    categories: ["china"],
    primaryCategory: "china",
    summary: "测试摘要包含足够事实信息。",
    publishedAt: "2026-07-13T07:55:00.000Z",
    extractedAt: "2026-07-13T08:00:00.000Z",
  };
}
