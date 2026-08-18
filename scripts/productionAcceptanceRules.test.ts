import { describe, expect, it } from "vitest";
import {
  BURN_IN_STRICT_SLOTS,
  SLOTS_PER_DAY,
  SOAK_DAYS,
  advanceMonitorState,
  createMonitorState,
  evaluateSlotAudit,
  type SlotAudit,
} from "./productionAcceptanceRules";

function passingAudit(slot = "2026-07-24T06:00:00.000Z"): SlotAudit {
  const reportId = "report-public-id";
  const runId = "run-public-id";
  return {
    auditAt: "2026-07-24T06:01:15.000Z",
    targetSlot: slot,
    security: { readOnly: true, tlsEncrypted: true, strictCert: true, rolledBack: true },
    deployment: { expected: "dpl_public", aliasExact: true },
    schedule: {
      expectedSlots: 1,
      cron: 1,
      durable: 1,
      missingCron: [],
      missingDurable: [],
      duplicateCron: 0,
      duplicateDurable: 0,
    },
    cron: [{ runId: 1, slot, status: "succeeded", startedAt: slot, finishedAt: slot }],
    pgNet: {
      rows: [{
        responseId: 2,
        statusCode: 200,
        exact9: true,
        networkError: false,
        runId,
        reportId,
        bodyStatus: "published",
        selectedSourceCount: 11,
        discoveredCount: 5,
        candidateCount: 300,
        bodyError: null,
      }],
      http200: 1,
      exact9: 1,
      networkErrors: 0,
    },
    durable: [{
      slot,
      runId,
      status: "published",
      startedAt: slot,
      finishedAt: "2026-07-24T06:00:55.000Z",
      duration: 55,
      plannedCount: 11,
      attemptedCount: 11,
      skippedCount: 0,
      missingCount: 0,
      discovered: 5,
      accepted: 5,
      reportId,
      errorCode: null,
      setMismatch: 0,
      overlap: 0,
      responseId: 2,
      responseOk: true,
      responseReportId: reportId,
      responseBodyStatus: "published",
      bodyCountsMatch: true,
      snapshotLinked: true,
      storageView: "2",
      encoding: "gzip-base64",
      encodedLength: 100,
      outcome: "published",
    }],
    atomic: {
      runtimeSingleton: 1,
      leaseSingleton: 1,
      latestReportId: reportId,
      latestRunId: runId,
      latestPublishedReportId: reportId,
      runtimeMatches: true,
      latestSnapshotLinked: true,
      leaseReleased: true,
      lastErrorCode: null,
    },
    sources: {
      enabled: 7,
      registered: 7,
      missingState: 0,
      attemptWindowMinutes: 30,
      healthy: 6,
      circuitOpen: 1,
      halfOpenDue: 0,
      rollingAttempted: 7,
      rollingSucceeded: 6,
      overdue: 0,
      backlog: 0,
      currentAttemptMismatch: 0,
      currentSkippedAdvanced: 0,
      anthropic: {
        planned: true,
        attempted: true,
        skipped: false,
        lastAttemptAt: slot,
        lastSuccessAt: slot,
        nextDueAt: "2026-07-24T07:30:00.000Z",
        failures: 0,
        circuitOpenUntil: null,
        lastErrorCode: null,
      },
    },
    public: {
      errors: { health: null, full: null, compact: null, reload: null, invalid: null },
      statuses: { health: 200, full: 200, compact: 200, reload: 200, invalid: 400 },
      cache: {
        health: "no-store",
        full: "public-max-age-0",
        compact: "public-max-age-0",
        reload: "no-store",
        invalid: "no-store",
      },
      storage: "supabase",
      healthError: null,
      reportIds: [reportId, reportId, reportId, reportId],
      atomicReport: true,
      counts: { full: 333, compact: 333, reload: 333 },
      candidateLatest: "2026-07-24T05:30:00.000Z",
      candidateAge: 31.25,
      homepageLatest: "2026-07-24T05:30:00.000Z",
      homepageAge: 31.25,
      duplicates: { storyId: 0, title: 0, summary: 0, combination: 0, tier: 0 },
      tiers: { top: 10, important: 13, watch: 8 },
      core: { count: 23, confirmed: 23 },
      publisherShare: 0.13,
      declaredPublisherShare: 0.13,
      sourceCount: 23,
      beats: { covered: 10, total: 10 },
      latest: {
        eligible24h: 333,
        visible24h: 333,
        missing24h: 0,
        recall: 1,
        duplicateIds: 0,
        fallbackWindowHours: 24,
        eligibleFallback: 0,
        visibleFallback: 0,
        missingFallback: 0,
      },
      unmappedCandidateCount: 0,
      statusMetadata: {
        servingMode: "durable",
        pipelineStatus: "healthy",
        contentStatus: "current",
        coverageStatus: "current",
        lastCheckedAt: slot,
        lastFullSweepAt: slot,
        lastPublishedAt: slot,
        newestContentAt: "2026-07-24T05:30:00.000Z",
        lastOutcomeCode: "published",
        truthful: true,
      },
    },
    rolling24h: null,
  };
}

describe("production acceptance rules", () => {
  it("accepts a complete published slot", () => {
    expect(evaluateSlotAudit(passingAudit())).toEqual({
      passed: true,
      failures: [],
      runId: "run-public-id",
      reportId: "report-public-id",
      duration: 55,
    });
  });

  it("fails closed when the database certificate was not strictly verified", () => {
    const audit = passingAudit();
    audit.security.strictCert = false;

    expect(evaluateSlotAudit(audit).failures).toContain("security_certificate_not_verified");
  });

  it("rejects structural coverage gaps while allowing old curated content", () => {
    const audit = passingAudit();
    audit.durable[0].duration = 60.001;
    audit.public.homepageAge = 10_000;
    audit.public.unmappedCandidateCount = 1;
    audit.public.latest.missing24h = 1;
    audit.public.latest.recall = 0.99;

    const failures = evaluateSlotAudit(audit).failures;
    expect(failures).toEqual(
      expect.arrayContaining([
        "durable_over_60_seconds",
        "public_unmapped_candidates",
        "public_latest_missing_24h",
        "public_latest_recall",
      ]),
    );
    expect(failures).not.toContain("public_homepage_stale");
  });

  it("allows a source-level partial refresh to serve the last-known-good report", () => {
    const audit = passingAudit();
    audit.durable[0].outcome = "partial";
    audit.durable[0].responseBodyStatus = "partial";
    audit.pgNet.rows[0].bodyStatus = "partial";
    audit.public.healthError = "source_partial";
    audit.public.statusMetadata.pipelineStatus = "degraded";
    audit.public.statusMetadata.lastOutcomeCode = "partial";

    expect(evaluateSlotAudit(audit).passed).toBe(true);
  });

  it("allows completed slots to retain the previously published report", () => {
    const audit = passingAudit();
    audit.durable[0] = {
      ...audit.durable[0],
      status: "completed",
      plannedCount: 0,
      attemptedCount: 0,
      reportId: null,
      snapshotLinked: false,
      responseBodyStatus: "unchanged",
      outcome: "unchanged",
    };
    audit.atomic.latestPublishedReportId = null;
    audit.atomic.runtimeMatches = false;
    audit.atomic.latestSnapshotLinked = false;
    audit.public.statusMetadata.lastOutcomeCode = "unchanged";

    expect(evaluateSlotAudit(audit).passed).toBe(true);
  });

  it("starts a burn-in at the first passing baseline and resets after a failed strict slot", () => {
    const audit = passingAudit();
    const baselineVerdict = evaluateSlotAudit(audit);
    let state = createMonitorState({
      deployment: "dpl_public",
      alias: "https://example.com",
      now: new Date("2026-07-24T05:50:00.000Z"),
      firstSlot: audit.targetSlot,
    });
    state = advanceMonitorState(state, audit, baselineVerdict);

    expect(state).toMatchObject({
      phase: "burn_in",
      baselineSlot: audit.targetSlot,
      burnInStrictPassed: 0,
      nextSlot: "2026-07-24T06:05:00.000Z",
    });

    const failedAudit = passingAudit("2026-07-24T06:05:00.000Z");
    failedAudit.public.latest.missing24h = 1;
    failedAudit.public.latest.recall = 0.99;
    state = advanceMonitorState(state, failedAudit, evaluateSlotAudit(failedAudit));

    expect(state).toMatchObject({
      phase: "seeking_baseline",
      attempt: 2,
      baselineSlot: null,
      burnInStrictPassed: 0,
      nextSlot: "2026-07-24T06:10:00.000Z",
    });
  });

  it("transitions from a 24-hour five-minute burn-in to seven daily soak checks", () => {
    let audit = passingAudit();
    let state = createMonitorState({
      deployment: "dpl_public",
      alias: "https://example.com",
      now: new Date("2026-07-24T05:50:00.000Z"),
      firstSlot: audit.targetSlot,
    });
    state = advanceMonitorState(state, audit, evaluateSlotAudit(audit));

    for (let index = 0; index < BURN_IN_STRICT_SLOTS; index += 1) {
      audit = passingAudit(state.nextSlot);
      audit.auditAt = new Date(Date.parse(audit.targetSlot) + 75_000).toISOString();
      state = advanceMonitorState(state, audit, evaluateSlotAudit(audit));
    }
    expect(state.phase).toBe("soak");

    for (let index = 0; index < SOAK_DAYS; index += 1) {
      audit = passingAudit(state.nextSlot);
      audit.auditAt = new Date(Date.parse(audit.targetSlot) + 75_000).toISOString();
      state = advanceMonitorState(state, audit, evaluateSlotAudit(audit));
    }
    expect(state).toMatchObject({ phase: "passed", status: "passed", soakDaysPassed: 7 });
  });

  it("requires a clean rolling 24-hour summary during soak", () => {
    const audit = passingAudit();
    audit.rolling24h = {
      expectedSlots: SLOTS_PER_DAY,
      cron: SLOTS_PER_DAY,
      cronSucceeded: SLOTS_PER_DAY,
      durable: SLOTS_PER_DAY,
      durableSucceeded: SLOTS_PER_DAY,
      durableFailed: 0,
      durableRunning: 0,
      missingCron: 0,
      missingDurable: 0,
      duplicateCron: 0,
      duplicateDurable: 0,
      skippedSources: 0,
      missingSourceOutcomes: 0,
      durationP95: 28,
      durationMax: 59,
      over30Seconds: SLOTS_PER_DAY,
      over60Seconds: 0,
      maxSuccessfulGapMinutes: 5.1,
    };
    expect(evaluateSlotAudit(audit, { requireRolling24h: true }).passed).toBe(true);

    audit.rolling24h.durableFailed = 1;
    expect(evaluateSlotAudit(audit, { requireRolling24h: true }).failures).toContain(
      "rolling_24h_failed_runs",
    );
  });
});
