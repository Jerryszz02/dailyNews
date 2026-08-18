import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  connectReadOnly,
  minIsoTimestamp,
  summarizePublicReport,
  timestampMs,
} from "./productionAcceptanceAudit";
import {
  bootoutLaunchAgent,
  buildLaunchAgentPlist,
} from "./productionAcceptanceLaunchAgent";

const now = "2026-08-03T12:00:00.000Z";

function story(id: string, updatedAt: string) {
  return {
    id,
    updatedAt,
    evidence: [{ candidateId: `candidate-${id}` }],
  };
}

describe("production acceptance audit summaries", () => {
  it("preserves PostgreSQL Date milliseconds when finding the earliest source attempt", () => {
    const earliest = new Date("2026-08-08T16:30:01.712Z");
    const later = new Date("2026-08-08T16:45:04.321Z");

    expect(timestampMs(earliest)).toBe(earliest.getTime());
    expect(timestampMs("2026-08-08T16:30:01.712+00:00")).toBe(earliest.getTime());
    expect(minIsoTimestamp([later, earliest])).toBe("2026-08-08T16:30:01.712Z");
  });

  it("detects a missing event in the explicit 24-hour latest list", () => {
    const recentA = story("recent-a", "2026-08-03T11:00:00.000Z");
    const recentB = story("recent-b", "2026-08-02T13:00:00.000Z");
    const older = story("older", "2026-08-01T13:00:00.000Z");

    expect(
      summarizePublicReport(
        {
          stories: [recentA, recentB, older],
          latestStories: [recentA],
          quality: { acceptedCandidateCount: 3, unmappedCandidateCount: 0 },
        },
        now,
      ),
    ).toEqual({
      latest: {
        eligible24h: 2,
        visible24h: 1,
        missing24h: 1,
        recall: 0.5,
        duplicateIds: 0,
        fallbackWindowHours: 24,
        eligibleFallback: 0,
        visibleFallback: 0,
        missingFallback: 0,
      },
      unmappedCandidateCount: 0,
    });
  });

  it("derives latest and candidate mapping for an older V2 report", () => {
    const recent = story("recent", "2026-08-03T11:00:00.000Z");

    expect(
      summarizePublicReport(
        {
          stories: [recent],
          quality: { acceptedCandidateCount: 1 },
        },
        now,
      ),
    ).toEqual({
      latest: {
        eligible24h: 1,
        visible24h: 1,
        missing24h: 0,
        recall: 1,
        duplicateIds: 0,
        fallbackWindowHours: 24,
        eligibleFallback: 0,
        visibleFallback: 0,
        missingFallback: 0,
      },
      unmappedCandidateCount: 0,
    });
  });

  it("uses the 72-hour fallback only when the 24-hour window is empty", () => {
    const older = story("older", "2026-08-01T13:00:00.000Z");

    expect(
      summarizePublicReport(
        {
          stories: [older],
          quality: { acceptedCandidateCount: 1 },
        },
        now,
      ).latest,
    ).toMatchObject({
      eligible24h: 0,
      visible24h: 0,
      missing24h: 0,
      recall: 1,
      fallbackWindowHours: 72,
      eligibleFallback: 1,
      visibleFallback: 1,
      missingFallback: 0,
    });
  });

  it("does not let declared quality metadata hide an unmapped candidate", () => {
    const recent = story("recent", "2026-08-03T11:00:00.000Z");

    expect(
      summarizePublicReport(
        {
          stories: [recent],
          latestStories: [recent],
          quality: { acceptedCandidateCount: 2, unmappedCandidateCount: 0 },
        },
        now,
      ).unmappedCandidateCount,
    ).toBe(1);
  });

  it("detects a missing 72-hour fallback event", () => {
    const older = story("older", "2026-08-01T13:00:00.000Z");

    expect(
      summarizePublicReport(
        {
          stories: [older],
          latestStories: [],
          quality: { acceptedCandidateCount: 1 },
        },
        now,
      ).latest.missingFallback,
    ).toBe(1);
  });
});

describe("production acceptance LaunchAgent plist", () => {
  it("keeps logs outside Desktop, escapes XML, and restarts only failed exits", () => {
    const home = "/Users/alice";
    const desktopOutput = "/Users/alice/Desktop/acceptance & evidence";
    const launchAgent = buildLaunchAgentPlist({
      home,
      cwd: "/Users/alice/Desktop/dailyNews <current>",
      label: "com.jerryszz.dailynews.production-acceptance",
      programArguments: ["monitor", "--output", desktopOutput, '<&>"\''],
    });

    expect(launchAgent.logDirectory).toBe(
      path.join(home, "Library", "Logs", "dailyNews-production-acceptance"),
    );
    expect(launchAgent.stdoutPath).not.toContain("Desktop");
    expect(launchAgent.stderrPath).not.toContain("Desktop");
    expect(launchAgent.body).toContain("/Users/alice/Desktop/acceptance &amp; evidence");
    expect(launchAgent.body).toContain("/Users/alice/Desktop/dailyNews &lt;current&gt;");
    expect(launchAgent.body).toContain("&lt;&amp;&gt;&quot;&apos;");
    expect(launchAgent.body).toContain(
      [
        "  <key>KeepAlive</key>",
        "  <dict>",
        "    <key>SuccessfulExit</key>",
        "    <false/>",
        "  </dict>",
        "  <key>ThrottleInterval</key>",
        "  <integer>60</integer>",
      ].join("\n"),
    );
  });

  it("stops cleanly when bootout succeeds", async () => {
    const runLaunchctl = vi.fn(async () => {});

    await expect(bootoutLaunchAgent("gui/501/example", runLaunchctl)).resolves.toBeUndefined();
    expect(runLaunchctl).toHaveBeenCalledTimes(1);
    expect(runLaunchctl).toHaveBeenCalledWith(["bootout", "gui/501/example"]);
  });

  it("accepts only a confirmed missing LaunchAgent", async () => {
    const runLaunchctl = vi.fn(async (arguments_: string[]) => {
      throw Object.assign(new Error("missing"), {
        code: arguments_[0] === "bootout" ? "COMMAND_EXIT_3" : "COMMAND_EXIT_113",
      });
    });

    await expect(bootoutLaunchAgent("gui/501/example", runLaunchctl)).resolves.toBeUndefined();
    expect(runLaunchctl).toHaveBeenNthCalledWith(2, ["print", "gui/501/example"]);
  });

  it("fails closed when bootout does not remove the LaunchAgent", async () => {
    const bootoutError = Object.assign(new Error("still loaded"), { code: "COMMAND_EXIT_3" });
    const runLaunchctl = vi.fn(async (arguments_: string[]) => {
      if (arguments_[0] === "bootout") throw bootoutError;
    });

    await expect(bootoutLaunchAgent("gui/501/example", runLaunchctl)).rejects.toBe(bootoutError);
    expect(runLaunchctl).toHaveBeenNthCalledWith(2, ["print", "gui/501/example"]);
  });

  it("fails closed immediately when bootout times out", async () => {
    const timeoutError = Object.assign(new Error("timeout"), { code: "COMMAND_TIMEOUT" });
    const runLaunchctl = vi.fn(async () => {
      throw timeoutError;
    });

    await expect(bootoutLaunchAgent("gui/501/example", runLaunchctl)).rejects.toBe(timeoutError);
    expect(runLaunchctl).toHaveBeenCalledTimes(1);
  });
});

describe("production acceptance database connection", () => {
  it("does not retry with certificate verification disabled", async () => {
    const clientOptions: Array<Record<string, unknown>> = [];
    class RejectingClient {
      connection = { stream: { encrypted: false } };

      constructor(options: Record<string, unknown>) {
        clientOptions.push(options);
      }

      async connect(): Promise<void> {
        throw Object.assign(new Error("self signed certificate in certificate chain"), {
          code: "SELF_SIGNED_CERT_IN_CHAIN",
        });
      }

      async end(): Promise<void> {}

      async query(): Promise<{ rows: Array<Record<string, unknown>> }> {
        return { rows: [] };
      }
    }

    await expect(connectReadOnly(
      { DATABASE_URL: "postgresql://postgres:secret@db.abcdefghij.supabase.co:5432/postgres" },
      "abcdefghij",
      RejectingClient,
    )).rejects.toMatchObject({ code: "SELF_SIGNED_CERT_IN_CHAIN" });

    expect(clientOptions).toHaveLength(1);
    expect(clientOptions[0]?.ssl).toEqual({ rejectUnauthorized: true });
  });
});
