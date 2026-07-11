import { describe, expect, it } from "vitest";
import { newsSources } from "../config/sources";
import { coverageBeatOrder, selectSourcesForCoverage, sourceBeats } from "./sourceCoverage";

describe("source coverage scheduling", () => {
  it("covers every configured beat using primary sections within the serverless source budget", () => {
    const selected = selectSourcesForCoverage(newsSources, 10, { now: new Date("2026-07-10T00:00:00.000Z") });
    const covered = new Set(selected.flatMap(sourceBeats));

    expect(selected).toHaveLength(10);
    expect(coverageBeatOrder.every((beat) => covered.has(beat))).toBe(true);
    expect(selected.reduce((count, source) => count + source.sections.length, 0)).toBeLessThanOrEqual(20);
    expect(selected.filter((source) => !source.language.startsWith("zh")).length).toBeLessThanOrEqual(2);
  });

  it("does not count auxiliary tags as primary coverage", () => {
    const xinhua = newsSources.find((source) => source.source_id === "xinhua");
    expect(xinhua).toBeDefined();
    expect(sourceBeats(xinhua!)).toEqual(["china", "international", "sports", "science"]);
    expect(sourceBeats(xinhua!)).not.toContain("policy");
  });

  it("skips a source while its circuit is open", () => {
    const selected = selectSourcesForCoverage(newsSources, 10, {
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
    const left = selectSourcesForCoverage(newsSources, 10).map((source) => source.source_id);
    const right = selectSourcesForCoverage(newsSources, 10).map((source) => source.source_id);
    expect(left).toEqual(right);
  });
});
