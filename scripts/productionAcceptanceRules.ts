export const SLOT_MINUTES = 5;
export const SLOT_MS = SLOT_MINUTES * 60 * 1000;
export const SLOTS_PER_DAY = (24 * 60) / SLOT_MINUTES;
export const BURN_IN_STRICT_SLOTS = SLOTS_PER_DAY;
export const SOAK_DAYS = 7;
export const SOURCE_ATTEMPT_WINDOW_MINUTES = 30;
export const MAX_REFRESH_DURATION_SECONDS = 60;

export type MonitorPhase = "seeking_baseline" | "burn_in" | "soak" | "passed" | "needs_review";

export interface SlotAudit {
  auditAt: string;
  targetSlot: string;
  security: {
    readOnly: boolean;
    tlsEncrypted: boolean;
    strictCert: boolean;
    rolledBack: boolean;
  };
  deployment: {
    expected: string;
    aliasExact: boolean;
  };
  schedule: {
    expectedSlots: number;
    cron: number;
    durable: number;
    missingCron: string[];
    missingDurable: string[];
    duplicateCron: number;
    duplicateDurable: number;
  };
  cron: Array<{
    runId: number;
    slot: string;
    status: string;
    startedAt: string | null;
    finishedAt: string | null;
  }>;
  pgNet: {
    rows: Array<{
      responseId: number;
      statusCode: number | null;
      exact9: boolean;
      networkError: boolean;
      runId: string | null;
      reportId: string | null;
      bodyStatus: string | null;
      selectedSourceCount: number | null;
      discoveredCount: number | null;
      candidateCount: number | null;
      bodyError: string | null;
    }>;
    http200: number;
    exact9: number;
    networkErrors: number;
  };
  durable: Array<{
    slot: string;
    runId: string;
    status: string;
    startedAt: string | null;
    finishedAt: string | null;
    duration: number | null;
    plannedCount: number;
    attemptedCount: number;
    skippedCount: number;
    missingCount: number;
    discovered: number;
    accepted: number;
    reportId: string | null;
    errorCode: string | null;
    setMismatch: number;
    overlap: number;
    responseId: number | null;
    responseOk: boolean;
    responseReportId: string | null;
    responseBodyStatus: string | null;
    bodyCountsMatch: boolean;
    snapshotLinked: boolean;
    storageView: string | null;
    encoding: string | null;
    encodedLength: number;
    outcome: "published" | "unchanged" | "partial" | "failed" | null;
  }>;
  atomic: {
    runtimeSingleton: number;
    leaseSingleton: number;
    latestReportId: string | null;
    latestRunId: string | null;
    latestPublishedReportId: string | null;
    runtimeMatches: boolean;
    latestSnapshotLinked: boolean;
    leaseReleased: boolean;
    lastErrorCode: string | null;
  };
  sources: {
    enabled: number;
    registered: number;
    missingState: number;
    attemptWindowMinutes: number;
    healthy: number;
    circuitOpen: number;
    halfOpenDue: number;
    rollingAttempted: number;
    rollingSucceeded: number;
    overdue: number;
    backlog: number;
    currentAttemptMismatch: number | null;
    currentSkippedAdvanced: number | null;
    anthropic: {
      planned: boolean;
      attempted: boolean;
      skipped: boolean;
      lastAttemptAt: string | null;
      lastSuccessAt: string | null;
      nextDueAt: string | null;
      failures: number;
      circuitOpenUntil: string | null;
      lastErrorCode: string | null;
    } | null;
  };
  public: {
    errors: Record<string, string | null>;
    statuses: {
      health: number | null;
      full: number | null;
      compact: number | null;
      reload: number | null;
      invalid: number | null;
    };
    cache: {
      health: string;
      full: string;
      compact: string;
      reload: string;
      invalid: string;
    };
    storage: string | null;
    healthError: string | null;
    reportIds: Array<string | null>;
    atomicReport: boolean;
    counts: {
      full: number;
      compact: number;
      reload: number;
    };
    candidateLatest: string | null;
    candidateAge: number | null;
    homepageLatest: string | null;
    homepageAge: number | null;
    duplicates: {
      storyId: number;
      title: number;
      summary: number;
      combination: number;
      tier: number;
    };
    tiers: {
      top: number;
      important: number;
      watch: number;
    };
    core: {
      count: number;
      confirmed: number;
    };
    publisherShare: number;
    declaredPublisherShare: number | null;
    sourceCount: number | null;
    beats: {
      covered: number | null;
      total: number | null;
    };
    latest: {
      eligible24h: number;
      visible24h: number;
      missing24h: number;
      recall: number;
      duplicateIds: number;
      fallbackWindowHours: 24 | 72 | null;
      eligibleFallback: number;
      visibleFallback: number;
      missingFallback: number;
    };
    unmappedCandidateCount: number | null;
    statusMetadata: {
      servingMode: string | null;
      pipelineStatus: string | null;
      contentStatus: string | null;
      coverageStatus: string | null;
      lastCheckedAt: string | null;
      lastFullSweepAt: string | null;
      lastPublishedAt: string | null;
      newestContentAt: string | null;
      lastOutcomeCode: string | null;
      truthful: boolean;
    };
  };
  rolling24h: {
    expectedSlots: number;
    cron: number;
    cronSucceeded: number;
    durable: number;
    durableSucceeded: number;
    durableFailed: number;
    durableRunning: number;
    missingCron: number;
    missingDurable: number;
    duplicateCron: number;
    duplicateDurable: number;
    skippedSources: number;
    missingSourceOutcomes: number;
    durationP95: number | null;
    durationMax: number | null;
    over30Seconds: number;
    over60Seconds: number;
    maxSuccessfulGapMinutes: number | null;
  } | null;
}

export interface SlotVerdict {
  passed: boolean;
  failures: string[];
  runId: string | null;
  reportId: string | null;
  duration: number | null;
}

export interface MonitorState {
  schemaVersion: 1;
  status: "running" | "passed" | "needs_review" | "stopped";
  phase: MonitorPhase;
  expectedDeployment: string;
  alias: string;
  createdAt: string;
  updatedAt: string;
  deadlineAt: string;
  nextSlot: string;
  attempt: number;
  baselineSlot: string | null;
  burnInStrictPassed: number;
  burnInPassedAt: string | null;
  soakDaysPassed: number;
  soakStartedAt: string | null;
  completedAt: string | null;
  totalSlotsAudited: number;
  totalPassedSlots: number;
  totalFailedSlots: number;
  latestVerdict: SlotVerdict | null;
  latestAuditAt: string | null;
}

export function floorSlot(value: Date | string | number): string {
  const time = new Date(value).getTime();
  return new Date(Math.floor(time / SLOT_MS) * SLOT_MS).toISOString();
}

export function addSlots(slot: string, count: number): string {
  return new Date(Date.parse(slot) + count * SLOT_MS).toISOString();
}

export function createMonitorState(options: {
  deployment: string;
  alias: string;
  now?: Date;
  firstSlot?: string;
  maxRuntimeDays?: number;
}): MonitorState {
  const now = options.now ?? new Date();
  const firstSlot = options.firstSlot ?? addSlots(floorSlot(now), 1);
  const maxRuntimeDays = options.maxRuntimeDays ?? 21;

  return {
    schemaVersion: 1,
    status: "running",
    phase: "seeking_baseline",
    expectedDeployment: options.deployment,
    alias: options.alias,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    deadlineAt: new Date(now.getTime() + maxRuntimeDays * 24 * 60 * 60 * 1000).toISOString(),
    nextSlot: firstSlot,
    attempt: 1,
    baselineSlot: null,
    burnInStrictPassed: 0,
    burnInPassedAt: null,
    soakDaysPassed: 0,
    soakStartedAt: null,
    completedAt: null,
    totalSlotsAudited: 0,
    totalPassedSlots: 0,
    totalFailedSlots: 0,
    latestVerdict: null,
    latestAuditAt: null,
  };
}

export function evaluateSlotAudit(
  audit: SlotAudit,
  options: { requireRolling24h?: boolean } = {},
): SlotVerdict {
  const failures: string[] = [];
  const fail = (condition: boolean, code: string) => {
    if (!condition) failures.push(code);
  };
  const durable = audit.durable[0];
  const response = audit.pgNet.rows[0];
  const cron = audit.cron[0];
  const isPublished = durable?.status === "published";
  const isCompleted = durable?.status === "completed";
  const outcome = durable?.outcome ?? response?.bodyStatus ?? null;
  const publicReportId = audit.public.reportIds[0] ?? null;

  fail(audit.security.readOnly, "security_not_read_only");
  fail(audit.security.tlsEncrypted, "security_tls_not_encrypted");
  fail(audit.security.rolledBack, "security_not_rolled_back");
  fail(audit.deployment.aliasExact, "deployment_alias_mismatch");

  fail(audit.schedule.expectedSlots === 1, "schedule_expected_slot_count");
  fail(audit.schedule.cron === 1, "schedule_cron_count");
  fail(audit.schedule.durable === 1, "schedule_durable_count");
  fail(audit.schedule.missingCron.length === 0, "schedule_missing_cron");
  fail(audit.schedule.missingDurable.length === 0, "schedule_missing_durable");
  fail(audit.schedule.duplicateCron === 0, "schedule_duplicate_cron");
  fail(audit.schedule.duplicateDurable === 0, "schedule_duplicate_durable");

  fail(Boolean(cron && cron.slot === audit.targetSlot && cron.status === "succeeded"), "cron_not_succeeded");
  fail(audit.pgNet.rows.length === 1, "pgnet_response_count");
  fail(Boolean(response && response.statusCode === 200), "pgnet_not_http_200");
  fail(Boolean(response?.exact9), "pgnet_body_not_exact_9");
  fail(Boolean(response && !response.networkError), "pgnet_network_error");

  fail(Boolean(durable && durable.slot === audit.targetSlot), "durable_slot_mismatch");
  fail(Boolean(durable && (isPublished || isCompleted)), "durable_terminal_status");
  fail(
    Boolean(
      durable &&
        durable.duration !== null &&
        durable.duration <= MAX_REFRESH_DURATION_SECONDS
    ),
    "durable_over_60_seconds",
  );
  fail(Boolean(durable && durable.missingCount === 0), "durable_missing");
  fail(Boolean(durable && durable.setMismatch === 0), "durable_set_mismatch");
  fail(Boolean(durable && durable.overlap === 0), "durable_attempt_skip_overlap");
  fail(Boolean(durable?.responseOk), "durable_response_mismatch");
  fail(Boolean(durable?.bodyCountsMatch), "durable_body_counts_mismatch");

  fail(audit.atomic.runtimeSingleton === 1, "atomic_runtime_not_singleton");
  fail(audit.atomic.leaseSingleton === 1, "atomic_lease_not_singleton");
  fail(audit.atomic.leaseReleased, "atomic_lease_not_released");
  if (isPublished) {
    fail(Boolean(durable?.reportId), "published_report_missing");
    fail(Boolean(durable?.snapshotLinked), "published_snapshot_not_linked");
    fail(audit.atomic.runtimeMatches, "published_runtime_mismatch");
    fail(audit.atomic.latestSnapshotLinked, "published_latest_snapshot_mismatch");
    fail(durable?.reportId === publicReportId, "published_public_report_mismatch");
  } else if (isCompleted) {
    fail(Boolean(audit.atomic.latestReportId), "completed_latest_report_missing");
    fail(audit.atomic.latestReportId === publicReportId, "completed_public_report_mismatch");
    fail(durable?.responseReportId === audit.atomic.latestReportId, "completed_response_report_mismatch");
  }
  if (outcome === "partial") {
    fail(
      audit.public.statusMetadata.lastOutcomeCode === "partial",
      "partial_outcome_metadata_mismatch",
    );
  }

  fail(audit.sources.enabled > 0, "sources_enabled_empty");
  fail(audit.sources.registered === audit.sources.enabled, "sources_state_count_mismatch");
  fail(audit.sources.missingState === 0, "sources_state_missing");
  fail(
    audit.sources.attemptWindowMinutes === SOURCE_ATTEMPT_WINDOW_MINUTES,
    "sources_attempt_window_mismatch",
  );
  fail(
    audit.sources.healthy + audit.sources.circuitOpen === audit.sources.enabled,
    "sources_partition_mismatch",
  );
  fail(audit.sources.rollingAttempted === audit.sources.enabled, "sources_rolling_attempt_gap");
  fail(audit.sources.overdue === 0, "sources_overdue");
  fail(audit.sources.currentAttemptMismatch === 0, "sources_attempt_state_mismatch");
  fail(audit.sources.currentSkippedAdvanced === 0, "sources_skipped_state_advanced");

  fail(Object.values(audit.public.errors).every((error) => error === null), "public_fetch_error");
  fail(audit.public.statuses.health === 200, "public_health_not_200");
  fail(audit.public.statuses.full === 200, "public_full_not_200");
  fail(audit.public.statuses.compact === 200, "public_compact_not_200");
  fail(audit.public.statuses.reload === 200, "public_reload_not_200");
  fail(audit.public.statuses.invalid === 400, "public_invalid_not_400");
  fail(audit.public.cache.health === "no-store", "public_health_cache_contract");
  fail(audit.public.cache.full === "public-max-age-0", "public_full_cache_contract");
  fail(audit.public.cache.compact === "public-max-age-0", "public_compact_cache_contract");
  fail(audit.public.cache.reload === "no-store", "public_reload_cache_contract");
  fail(audit.public.cache.invalid === "no-store", "public_invalid_cache_contract");
  fail(audit.public.storage === "supabase", "public_storage_not_supabase");
  fail(audit.public.atomicReport, "public_report_not_atomic");
  fail(
    audit.public.counts.full > 0 &&
      audit.public.counts.full === audit.public.counts.compact &&
      audit.public.counts.full === audit.public.counts.reload,
    "public_story_count_mismatch",
  );
  fail(audit.public.unmappedCandidateCount === 0, "public_unmapped_candidates");
  fail(audit.public.latest.missing24h === 0, "public_latest_missing_24h");
  fail(audit.public.latest.recall === 1, "public_latest_recall");
  fail(audit.public.latest.duplicateIds === 0, "public_latest_duplicate_ids");
  fail(audit.public.latest.missingFallback === 0, "public_latest_fallback_missing");
  fail(audit.public.duplicates.storyId === 0, "public_duplicate_story_ids");
  fail(
    audit.public.statusMetadata.servingMode === "durable",
    "public_serving_mode_not_durable",
  );
  fail(
    ["running", "healthy", "degraded", "failed"].includes(
      audit.public.statusMetadata.pipelineStatus ?? "",
    ),
    "public_pipeline_status_invalid",
  );
  fail(
    ["current", "quiet", "stale", "unknown"].includes(
      audit.public.statusMetadata.contentStatus ?? "",
    ),
    "public_content_status_invalid",
  );
  fail(
    ["current", "stale", "incomplete", "unavailable"].includes(
      audit.public.statusMetadata.coverageStatus ?? "",
    ),
    "public_coverage_status_invalid",
  );
  fail(audit.public.statusMetadata.truthful, "public_status_metadata_mismatch");
  if (audit.public.healthError !== null) {
    fail(
      ["degraded", "failed"].includes(audit.public.statusMetadata.pipelineStatus ?? ""),
      "public_health_error_not_degraded",
    );
  }

  if (options.requireRolling24h) {
    const rolling = audit.rolling24h;
    fail(Boolean(rolling), "rolling_24h_missing");
    if (rolling) {
      fail(rolling.expectedSlots === SLOTS_PER_DAY, "rolling_24h_expected_slots");
      fail(rolling.cron === SLOTS_PER_DAY, "rolling_24h_cron_count");
      fail(rolling.cronSucceeded === SLOTS_PER_DAY, "rolling_24h_cron_failures");
      fail(rolling.durable === SLOTS_PER_DAY, "rolling_24h_durable_count");
      fail(rolling.durableSucceeded === SLOTS_PER_DAY, "rolling_24h_durable_failures");
      fail(rolling.durableFailed === 0, "rolling_24h_failed_runs");
      fail(rolling.durableRunning === 0, "rolling_24h_running_runs");
      fail(rolling.missingCron === 0, "rolling_24h_missing_cron");
      fail(rolling.missingDurable === 0, "rolling_24h_missing_durable");
      fail(rolling.duplicateCron === 0, "rolling_24h_duplicate_cron");
      fail(rolling.duplicateDurable === 0, "rolling_24h_duplicate_durable");
      fail(rolling.missingSourceOutcomes === 0, "rolling_24h_missing_source_outcomes");
      fail(rolling.over60Seconds === 0, "rolling_24h_over_60_seconds");
      fail(
        rolling.durationMax !== null && rolling.durationMax <= MAX_REFRESH_DURATION_SECONDS,
        "rolling_24h_duration_max",
      );
      fail(
        rolling.maxSuccessfulGapMinutes !== null &&
          rolling.maxSuccessfulGapMinutes <= SLOT_MINUTES + 1,
        "rolling_24h_success_gap",
      );
    }
  }

  return {
    passed: failures.length === 0,
    failures,
    runId: durable?.runId ?? null,
    reportId: isPublished ? durable?.reportId ?? null : audit.atomic.latestReportId,
    duration: durable?.duration ?? null,
  };
}

export function advanceMonitorState(
  state: MonitorState,
  audit: SlotAudit,
  verdict: SlotVerdict,
): MonitorState {
  const next: MonitorState = {
    ...state,
    updatedAt: audit.auditAt,
    latestAuditAt: audit.auditAt,
    latestVerdict: verdict,
    totalSlotsAudited: state.totalSlotsAudited + 1,
    totalPassedSlots: state.totalPassedSlots + (verdict.passed ? 1 : 0),
    totalFailedSlots: state.totalFailedSlots + (verdict.passed ? 0 : 1),
  };

  if (Date.parse(audit.auditAt) > Date.parse(state.deadlineAt)) {
    return { ...next, status: "needs_review", phase: "needs_review" };
  }

  if (!verdict.passed) {
    if (verdict.failures.includes("deployment_alias_mismatch")) {
      return { ...next, status: "needs_review", phase: "needs_review" };
    }
    if (state.phase === "soak") {
      return {
        ...next,
        attempt: state.attempt + 1,
        soakDaysPassed: 0,
        soakStartedAt: null,
        nextSlot: addSlots(audit.targetSlot, SLOTS_PER_DAY),
      };
    }
    return {
      ...next,
      phase: "seeking_baseline",
      attempt: state.attempt + 1,
      baselineSlot: null,
      burnInStrictPassed: 0,
      nextSlot: addSlots(audit.targetSlot, 1),
    };
  }

  if (state.phase === "seeking_baseline") {
    return {
      ...next,
      phase: "burn_in",
      baselineSlot: audit.targetSlot,
      burnInStrictPassed: 0,
      nextSlot: addSlots(audit.targetSlot, 1),
    };
  }

  if (state.phase === "burn_in") {
    const burnInStrictPassed = state.burnInStrictPassed + 1;
    if (burnInStrictPassed >= BURN_IN_STRICT_SLOTS) {
      return {
        ...next,
        phase: "soak",
        burnInStrictPassed,
        burnInPassedAt: audit.auditAt,
        soakDaysPassed: 0,
        soakStartedAt: audit.auditAt,
        nextSlot: addSlots(audit.targetSlot, SLOTS_PER_DAY),
      };
    }
    return {
      ...next,
      burnInStrictPassed,
      nextSlot: addSlots(audit.targetSlot, 1),
    };
  }

  if (state.phase === "soak") {
    const soakDaysPassed = state.soakDaysPassed + 1;
    if (soakDaysPassed >= SOAK_DAYS) {
      return {
        ...next,
        status: "passed",
        phase: "passed",
        soakDaysPassed,
        completedAt: audit.auditAt,
      };
    }
    return {
      ...next,
      soakDaysPassed,
      nextSlot: addSlots(audit.targetSlot, SLOTS_PER_DAY),
    };
  }

  return next;
}
