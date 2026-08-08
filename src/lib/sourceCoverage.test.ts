import { describe, expect, it } from "vitest";
import { newsSources } from "../config/sources";
import {
  coverageBeatOrder,
  defaultSourceIntervalMinutes,
  normalRotationSlots,
  retrySlots,
  selectSourcesForCoverage,
  sourceBeats,
  type SourceHealthState,
} from "./sourceCoverage";

describe("source coverage scheduling", () => {
  it("keeps every approved enabled source for full static or manual collection", () => {
    const collectible = newsSources.filter((source) => source.enabled && source.admission === "approved");
    const selected = selectSourcesForCoverage(newsSources, collectible.length);

    expect(selected.map((source) => source.source_id)).toEqual(collectible.map((source) => source.source_id));
  });

  it("uses all eleven slots for healthy due sources when no retry is needed", () => {
    const selected = selectSourcesForCoverage(newsSources, 11, {
      now: new Date("2026-07-10T00:00:00.000Z"),
      health: [],
    });

    expect(selected).toHaveLength(11);
  });

  it("covers every configured beat within the serverless six-source budget", () => {
    const selected = selectSourcesForCoverage(newsSources, 6, { now: new Date("2026-07-10T00:00:00.000Z") });
    const covered = new Set(selected.flatMap(sourceBeats));

    expect(selected).toHaveLength(6);
    expect(coverageBeatOrder.every((beat) => covered.has(beat))).toBe(true);
  });

  it("does not leave finance dependent on a single source", () => {
    const selected = selectSourcesForCoverage(newsSources, 6);
    const financeSources = selected.filter((source) => sourceBeats(source).includes("finance"));
    expect(financeSources.length).toBeGreaterThanOrEqual(2);
  });

  it("does not let an open circuit suppress the 30-minute coverage attempt", () => {
    const selected = selectSourcesForCoverage(newsSources, 6, {
      now: new Date("2026-07-10T00:00:00.000Z"),
      health: [
        {
          sourceId: "xinhua",
          consecutiveFailures: 3,
          circuitOpenUntil: "2026-07-10T01:00:00.000Z",
        },
      ],
    });

    expect(selected.some((source) => source.source_id === "xinhua")).toBe(true);
  });

  it("keeps a due failed source eligible before and after its circuit timestamp", () => {
    const source = newsSources.find((candidate) => candidate.source_id === "xinhua");
    expect(source).toBeDefined();

    const health: SourceHealthState[] = [
      {
        sourceId: "xinhua",
        consecutiveFailures: 3,
        nextDueAt: "2026-07-10T00:00:00.000Z",
        circuitOpenUntil: "2026-07-10T01:00:00.000Z",
      },
    ];

    expect(
      selectSourcesForCoverage([source!], 1, {
        now: new Date("2026-07-10T00:59:59.999Z"),
        health,
      }).map((candidate) => candidate.source_id),
    ).toEqual(["xinhua"]);
    expect(
      selectSourcesForCoverage([source!], 1, {
        now: new Date("2026-07-10T01:00:00.000Z"),
        health,
      }).map((candidate) => candidate.source_id),
    ).toEqual(["xinhua"]);
  });

  it("selects missing and most-overdue source state before future work", () => {
    const sources = newsSources.filter((source) => source.enabled).slice(0, 3);
    const now = new Date("2026-07-10T02:00:00.000Z");
    const selected = selectSourcesForCoverage(sources, 2, {
      now,
      health: [
        {
          sourceId: sources[0].source_id,
          consecutiveFailures: 0,
          nextDueAt: "2026-07-10T02:30:00.000Z",
        },
        {
          sourceId: sources[1].source_id,
          consecutiveFailures: 0,
          nextDueAt: "2026-07-10T01:00:00.000Z",
        },
      ],
    });

    expect(selected.map((source) => source.source_id)).toEqual([sources[2].source_id, sources[1].source_id]);
  });

  it("attempts every approved enabled source in each rolling 30-minute window", () => {
    const enabledSources = newsSources.filter(
      (source) => source.enabled && source.admission === "approved",
    );
    const start = Date.parse("2026-07-10T00:00:00.000Z");
    const health = new Map<string, SourceHealthState>();
    const attempts = new Map(enabledSources.map((source) => [source.source_id, [] as number[]]));

    for (let tick = 0; tick <= 12; tick += 1) {
      const now = new Date(start + tick * 5 * 60_000);
      const selected = selectSourcesForCoverage(enabledSources, 11, {
        now,
        health: Array.from(health.values()),
        defaultIntervalMinutes: defaultSourceIntervalMinutes,
      });

      expect(selected.length).toBeLessThanOrEqual(normalRotationSlots + retrySlots);
      selected.forEach((source) => {
        attempts.get(source.source_id)!.push(now.getTime());
        health.set(source.source_id, {
          sourceId: source.source_id,
          consecutiveFailures: 0,
          lastAttemptAt: now.toISOString(),
          lastSuccessAt: now.toISOString(),
          nextDueAt: new Date(now.getTime() + defaultSourceIntervalMinutes * 60_000).toISOString(),
          intervalMinutes: defaultSourceIntervalMinutes,
        });
      });
    }

    for (let windowTick = 0; windowTick <= 6; windowTick += 1) {
      const windowStart = start + windowTick * 5 * 60_000;
      const windowEnd = windowStart + defaultSourceIntervalMinutes * 60_000;
      enabledSources.forEach((source) => {
        expect(
          attempts.get(source.source_id)!.some((attemptedAt) => attemptedAt >= windowStart && attemptedAt <= windowEnd),
          `${source.source_id} should be attempted in the window starting at ${new Date(windowStart).toISOString()}`,
        ).toBe(true);
      });
    }
  });

  it("uses an idle slot to stagger a 12-source cohort before it exceeds the next slot budget", () => {
    const sources = newsSources.filter((source) => source.enabled).slice(0, 12);
    const idleSlot = new Date("2026-07-23T15:25:00.000Z");
    const dueSlot = new Date("2026-07-23T15:30:00.000Z");
    const health = new Map<string, SourceHealthState>(
      sources.map((source) => [
        source.source_id,
        {
          sourceId: source.source_id,
          consecutiveFailures: 0,
          nextDueAt: dueSlot.toISOString(),
          intervalMinutes: defaultSourceIntervalMinutes,
        },
      ]),
    );

    const early = selectSourcesForCoverage(sources, 11, {
      now: idleSlot,
      health: Array.from(health.values()),
      lookaheadMinutes: 5,
    });
    expect(early).toHaveLength(normalRotationSlots + retrySlots);

    early.forEach((source) => {
      health.set(source.source_id, {
        sourceId: source.source_id,
        consecutiveFailures: 0,
        lastAttemptAt: idleSlot.toISOString(),
        lastSuccessAt: idleSlot.toISOString(),
        nextDueAt: new Date(idleSlot.getTime() + defaultSourceIntervalMinutes * 60_000).toISOString(),
        intervalMinutes: defaultSourceIntervalMinutes,
      });
    });

    const next = selectSourcesForCoverage(sources, 11, {
      now: dueSlot,
      health: Array.from(health.values()),
      lookaheadMinutes: 5,
    });
    expect(next).toHaveLength(1);
  });

  it("adds at most two failed sources after the nine normal rotation slots", () => {
    const sources = newsSources.filter(
      (source) => source.enabled && source.admission === "approved",
    ).slice(0, 14);
    const now = new Date("2026-07-23T15:30:00.000Z");
    const health: SourceHealthState[] = sources.map((source, index) => ({
      sourceId: source.source_id,
      consecutiveFailures: index >= 9 ? 1 : 0,
      lastErrorCode: index >= 9 ? "source_timeout" : null,
      nextDueAt: now.toISOString(),
      intervalMinutes: defaultSourceIntervalMinutes,
    }));

    const selected = selectSourcesForCoverage(sources, 11, { now, health });
    const additionalSlots = selected.slice(normalRotationSlots);
    const selectedRetries = additionalSlots.filter((source) => {
      const state = health.find((candidate) => candidate.sourceId === source.source_id);
      return (state?.consecutiveFailures ?? 0) > 0;
    });

    expect(selected).toHaveLength(11);
    expect(additionalSlots).toHaveLength(retrySlots);
    expect(selectedRetries).toHaveLength(retrySlots);
  });

  it("is deterministic for the same inputs", () => {
    const left = selectSourcesForCoverage(newsSources, 6).map((source) => source.source_id);
    const right = selectSourcesForCoverage(newsSources, 6).map((source) => source.source_id);
    expect(left).toEqual(right);
  });
});
