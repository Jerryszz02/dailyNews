import { describe, expect, it } from "vitest";
import {
  BURN_IN_STRICT_SLOTS,
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
      finishedAt: "2026-07-24T06:00:28.000Z",
      duration: 28,
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
      enabled: 49,
      healthy: 46,
      circuitOpen: 3,
      halfOpenDue: 0,
      rollingAttempted: 46,
      rollingSucceeded: 46,
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
      duplicates: { title: 0, summary: 0, combination: 0, tier: 0 },
      tiers: { top: 10, important: 13, watch: 8 },
      core: { count: 23, confirmed: 23 },
      publisherShare: 0.13,
      declaredPublisherShare: 0.13,
      sourceCount: 23,
      beats: { covered: 10, total: 10 },
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
      duration: 28,
    });
  });

  it("rejects skipped sources, stale content, and a slow durable run", () => {
    const audit = passingAudit();
    audit.durable[0].duration = 30.001;
    audit.durable[0].skippedCount = 1;
    audit.public.homepageAge = 120.001;

    expect(evaluateSlotAudit(audit).failures).toEqual(
      expect.arrayContaining(["durable_over_30_seconds", "durable_skipped", "public_homepage_stale"]),
    );
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
    };
    audit.atomic.latestPublishedReportId = null;
    audit.atomic.runtimeMatches = false;
    audit.atomic.latestSnapshotLinked = false;

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
      nextSlot: "2026-07-24T06:15:00.000Z",
    });

    const failedAudit = passingAudit("2026-07-24T06:15:00.000Z");
    failedAudit.public.homepageAge = 121;
    state = advanceMonitorState(state, failedAudit, evaluateSlotAudit(failedAudit));

    expect(state).toMatchObject({
      phase: "seeking_baseline",
      attempt: 2,
      baselineSlot: null,
      burnInStrictPassed: 0,
      nextSlot: "2026-07-24T06:30:00.000Z",
    });
  });

  it("transitions from 96 strict slots to seven daily soak checks", () => {
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
      expectedSlots: 96,
      cron: 96,
      cronSucceeded: 96,
      durable: 96,
      durableSucceeded: 96,
      durableFailed: 0,
      durableRunning: 0,
      missingCron: 0,
      missingDurable: 0,
      duplicateCron: 0,
      duplicateDurable: 0,
      skippedSources: 0,
      missingSourceOutcomes: 0,
      durationP95: 28,
      durationMax: 29,
      over30Seconds: 0,
      maxSuccessfulGapMinutes: 15.1,
    };
    expect(evaluateSlotAudit(audit, { requireRolling24h: true }).passed).toBe(true);

    audit.rolling24h.durableFailed = 1;
    expect(evaluateSlotAudit(audit, { requireRolling24h: true }).failures).toContain(
      "rolling_24h_failed_runs",
    );
  });
});
