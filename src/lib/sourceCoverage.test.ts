import { describe, expect, it } from "vitest";
import { newsSources } from "../config/sources";
import { coverageBeatOrder, selectSourcesForCoverage, sourceBeats } from "./sourceCoverage";

describe("source coverage scheduling", () => {
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

  it("skips a source while its circuit is open", () => {
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

    expect(selected.some((source) => source.source_id === "xinhua")).toBe(false);
  });

  it("is deterministic for the same inputs", () => {
    const left = selectSourcesForCoverage(newsSources, 6).map((source) => source.source_id);
    const right = selectSourcesForCoverage(newsSources, 6).map((source) => source.source_id);
    expect(left).toEqual(right);
  });
});
