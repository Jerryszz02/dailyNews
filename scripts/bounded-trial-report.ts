// Read-only evidence for a fixed P5 cohort. Null means the information was not observed.
import { sql } from "@aihot/backend/db";
import { listedCondition, selectedCondition } from "@aihot/backend/publication/scope";

export function modelExecutionBounds(attempts: Array<{ started_at: Date; finished_at: Date | null }>, now: Date) {
  const starts = attempts.map((row) => row.started_at.getTime()).sort((a, b) => a - b);
  const peakWithin = (windowMs: number) => {
    let left = 0, peak = 0;
    for (let right = 0; right < starts.length; right++) {
      while (starts[left]! <= starts[right]! - windowMs) left++;
      peak = Math.max(peak, right - left + 1);
    }
    return peak;
  };
  // A reservation stops occupying a slot when its provider outcome is recorded. Finish first
  // when two events share a timestamp, matching the persisted active-slot boundary.
  const events = attempts.flatMap((row) => [
    { at: row.started_at.getTime(), delta: 1 },
    { at: (row.finished_at ?? now).getTime(), delta: -1 },
  ]).sort((a, b) => a.at - b.at || a.delta - b.delta);
  let active = 0, peak = 0;
  for (const event of events) { active += event.delta; peak = Math.max(peak, active); }
  return { attempts: starts.length, peakReservedSlots: peak,
    peakPerMinute: peakWithin(60_000), peakPerHour: peakWithin(3_600_000), peakPerDay: peakWithin(86_400_000) };
}

export async function trialReport(trialId: string, now = new Date()) {
  const [trial] = await sql<{ id: string; status: string; normal_limit: number; backfill_limit: number;
    manifest_hash: string; settings_hash: string; created_at: Date; frozen_at: Date | null; closed_at: Date | null }[]>`
    SELECT id, status, normal_limit, backfill_limit, manifest_hash, settings_hash, created_at, frozen_at, closed_at
    FROM dailynews_trials WHERE id = ${trialId}`;
  if (!trial) throw new Error(`unknown trial ${trialId}`);

  const sources = await sql<{ source_id: string; initialized_at: Date | null; attempts: number; ok: number; failed: number;
    last_status: string | null; last_error: string | null; found: number; created: number; revised: number;
    unchanged: number; admitted_normal: number; admitted_backfill: number; not_admitted: number }[]>`
    SELECT ts.source_id, ts.initialized_at,
      count(fr.id) AS attempts,
      count(fr.id) FILTER (WHERE fr.status = 'ok') AS ok,
      count(fr.id) FILTER (WHERE fr.status = 'failed') AS failed,
      (array_agg(fr.status ORDER BY fr.started_at DESC) FILTER (WHERE fr.id IS NOT NULL))[1] AS last_status,
      (array_agg(fr.error ORDER BY fr.started_at DESC) FILTER (WHERE fr.error IS NOT NULL))[1] AS last_error,
      coalesce(sum(fr.found_count), 0) AS found,
      coalesce(sum(fr.new_count), 0) AS created,
      coalesce(sum((fr.detail->'boundedTrial'->>'revised')::int), 0) AS revised,
      coalesce(sum((fr.detail->'boundedTrial'->>'unchanged')::int), 0) AS unchanged,
      coalesce(sum((fr.detail->'boundedTrial'->>'admittedNormal')::int), 0) AS admitted_normal,
      coalesce(sum((fr.detail->'boundedTrial'->>'admittedBackfill')::int), 0) AS admitted_backfill,
      coalesce(sum((fr.detail->'boundedTrial'->>'notAdmitted')::int), 0) AS not_admitted
    FROM dailynews_trial_sources ts
    LEFT JOIN fetch_runs fr ON fr.source_id = ts.source_id AND fr.detail #>> '{boundedTrial,id}' = ${trialId}
    WHERE ts.trial_id = ${trialId}
    GROUP BY ts.source_id, ts.initialized_at ORDER BY ts.source_id`;

  const [cohort] = await sql<{ normal: number; backfill: number; publicCount: number; selected: number;
    normalPublic: number; normalSelected: number; backfillPublic: number; backfillSelected: number;
    pending: number; failed: number; unpublished: number; p50_ms: number | null; p95_ms: number | null }[]>`
    SELECT count(*) FILTER (WHERE ta.lane = 'normal') AS normal,
      count(*) FILTER (WHERE ta.lane = 'backfill') AS backfill,
      count(*) FILTER (WHERE ${listedCondition(now)}) AS "publicCount",
      count(*) FILTER (WHERE ${selectedCondition(now)}) AS selected,
      count(*) FILTER (WHERE ta.lane='normal' AND ${listedCondition(now)}) AS "normalPublic",
      count(*) FILTER (WHERE ta.lane='normal' AND ${selectedCondition(now)}) AS "normalSelected",
      count(*) FILTER (WHERE ta.lane='backfill' AND ${listedCondition(now)}) AS "backfillPublic",
      count(*) FILTER (WHERE ta.lane='backfill' AND ${selectedCondition(now)}) AS "backfillSelected",
      count(*) FILTER (WHERE a.processing_state = 'new') AS pending,
      count(*) FILTER (WHERE a.processing_state = 'failed') AS failed,
      count(*) FILTER (WHERE p.article_id IS NULL) AS unpublished,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM
        (greatest(p.public_ready_at, CASE WHEN p.selected THEN p.visible_after END) - a.discovered_at)) * 1000)
        FILTER (WHERE ${listedCondition(now)} AND p.public_ready_at IS NOT NULL) AS p50_ms,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM
        (greatest(p.public_ready_at, CASE WHEN p.selected THEN p.visible_after END) - a.discovered_at)) * 1000)
        FILTER (WHERE ${listedCondition(now)} AND p.public_ready_at IS NOT NULL) AS p95_ms
    FROM dailynews_trial_articles ta
    JOIN articles a ON a.id = ta.article_id
    LEFT JOIN publications p ON p.article_id = a.id
    WHERE ta.trial_id = ${trialId}`;

  const latenciesByLane = await sql<{ lane: "normal" | "backfill"; publicCount: number;
    p50_ms: number | null; p95_ms: number | null }[]>`
    SELECT ta.lane, count(*) AS "publicCount",
      percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM
        (greatest(p.public_ready_at, CASE WHEN p.selected THEN p.visible_after END) - a.discovered_at)) * 1000) AS p50_ms,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM
        (greatest(p.public_ready_at, CASE WHEN p.selected THEN p.visible_after END) - a.discovered_at)) * 1000) AS p95_ms
    FROM dailynews_trial_articles ta JOIN articles a ON a.id=ta.article_id
    JOIN publications p ON p.article_id=a.id
    WHERE ta.trial_id=${trialId} AND ${listedCondition(now)} AND p.public_ready_at IS NOT NULL
    GROUP BY ta.lane ORDER BY ta.lane`;

  const modelAttempts = await sql<{ started_at: Date; finished_at: Date | null }[]>`
    SELECT started_at, finished_at FROM receipt_attempts
    WHERE origin='live' AND is_llm AND started_at >= ${trial.created_at}
    ORDER BY started_at`;

  // A closed cohort cannot legitimately spend again, but the ledger must still expose such a
  // row if an operational bug or manual write creates one. Never hide expense at closed_at.
  const [afterClose] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM receipt_attempts
    WHERE origin='live' AND started_at >= ${trial.created_at}
      AND ${trial.closed_at}::timestamptz IS NOT NULL AND started_at > ${trial.closed_at}`;

  // The isolated trial DB is the accounting boundary. Both article and digest/model jobs may have
  // non-article subjects, so totals since trial creation are shown separately from the cohort.
  const attempts = await sql<{ service: string; purpose: string; model: string | null; response_model: string | null;
    status: string; currency: string | null; cost_basis: string | null; attempts: number; retries: number; prompt_tokens: number | null;
    cache_hit_tokens: number | null; cache_miss_tokens: number | null; completion_tokens: number | null;
    cost: number | null; unpriced: number; unknown: number; price_snapshots: unknown[] | null;
    first_priced_at: Date | null; last_priced_at: Date | null;
    latency_p50_ms: number | null; latency_p95_ms: number | null }[]>`
    SELECT ra.service, r.purpose, ra.model, ra.response_model, ra.status, ra.currency, ra.cost_basis,
      count(*) AS attempts, count(*) FILTER (WHERE ra.attempt > 1) AS retries,
      sum(ra.prompt_tokens) AS prompt_tokens, sum(ra.cache_hit_tokens) AS cache_hit_tokens,
      sum(ra.cache_miss_tokens) AS cache_miss_tokens, sum(ra.completion_tokens) AS completion_tokens,
      sum(ra.cost) AS cost,
      count(*) FILTER (WHERE ra.cost IS NULL) AS unpriced,
      count(*) FILTER (WHERE ra.status = 'unknown') AS unknown,
      jsonb_agg(DISTINCT ra.price_snapshot) FILTER (WHERE ra.price_snapshot IS NOT NULL) AS price_snapshots,
      min(ra.priced_at) AS first_priced_at, max(ra.priced_at) AS last_priced_at,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY ra.latency_ms) FILTER (WHERE ra.latency_ms IS NOT NULL) AS latency_p50_ms,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY ra.latency_ms) FILTER (WHERE ra.latency_ms IS NOT NULL) AS latency_p95_ms
    FROM receipt_attempts ra JOIN receipts r ON r.id = ra.receipt_id
    WHERE ra.started_at >= ${trial.created_at}
      AND ra.origin = 'live'
    GROUP BY ra.service, r.purpose, ra.model, ra.response_model, ra.status, ra.currency, ra.cost_basis
    ORDER BY ra.service, r.purpose, ra.model, ra.status`;

  const directArticleCosts = await sql<{ lane: "normal" | "backfill"; attempts: number; cost: number | null;
    unpriced: number }[]>`
    SELECT ta.lane, count(*) AS attempts, sum(ra.cost) AS cost,
      count(*) FILTER (WHERE ra.cost IS NULL) AS unpriced
    FROM receipt_attempts ra JOIN receipts r ON r.id = ra.receipt_id
    JOIN dailynews_trial_articles ta ON ta.trial_id=${trialId}
      AND ta.article_id=substring(r.subject from '^article:([a-zA-Z0-9_-]+)')
    WHERE ra.started_at >= ${trial.created_at}
      AND ra.origin='live'
    GROUP BY ta.lane ORDER BY ta.lane`;

  const mixedCosts = await sql<{ subject_kind: string; attempts: number; cost: number | null; unpriced: number }[]>`
    SELECT CASE WHEN r.subject LIKE 'story:%' THEN 'story'
      WHEN r.subject LIKE 'report:%' THEN 'report'
      WHEN r.subject LIKE 'source:%' OR r.subject IN
        (SELECT source_id FROM dailynews_trial_sources WHERE trial_id=${trialId}) THEN 'source'
      ELSE 'other-or-unknown' END AS subject_kind,
      count(*) AS attempts, sum(ra.cost) AS cost,
      count(*) FILTER (WHERE ra.cost IS NULL) AS unpriced
    FROM receipt_attempts ra JOIN receipts r ON r.id=ra.receipt_id
    LEFT JOIN dailynews_trial_articles ta ON ta.trial_id=${trialId}
      AND ta.article_id=substring(r.subject from '^article:([a-zA-Z0-9_-]+)')
    WHERE ra.started_at >= ${trial.created_at}
      AND ra.origin='live' AND ta.article_id IS NULL
    GROUP BY subject_kind ORDER BY subject_kind`;

  const totalCost = attempts.reduce((sum, row) => sum + (row.cost ?? 0), 0);
  const currencies = [...new Set(attempts.map((row) => row.currency).filter((v): v is string => !!v))];
  const bases = [...new Set(attempts.map((row) => row.cost_basis).filter((v): v is string => !!v))];
  const costComplete = attempts.every((row) => row.unpriced === 0) && currencies.length === 1;
  const normal = cohort?.normal ?? 0;
  const publiclyListed = cohort?.publicCount ?? 0;
  const selected = cohort?.selected ?? 0;
  const normalArticleCost = directArticleCosts.find((row) => row.lane === "normal");
  return {
    trial: { id: trial.id, status: trial.status, manifestHash: trial.manifest_hash, settingsHash: trial.settings_hash,
      startedAt: trial.created_at, frozenAt: trial.frozen_at, closedAt: trial.closed_at, asOf: now,
      limits: { sources: [10, 15], normal: trial.normal_limit, historical: trial.backfill_limit, collectConcurrency: 4, modelConcurrency: 2 } },
    sources: sources.map((row) => ({ ...row, status: row.last_status ?? "not_attempted", duplicateOrUnchanged: row.unchanged })),
    failedSources: sources.filter((row) => row.failed > 0).map((row) => ({ sourceId: row.source_id, attempts: row.failed, lastError: row.last_error })),
    cohort: cohort ?? { normal: 0, backfill: 0, publicCount: 0, selected: 0, normalPublic: 0, normalSelected: 0,
      backfillPublic: 0, backfillSelected: 0, pending: 0, failed: 0, unpublished: 0, p50_ms: null, p95_ms: null },
    backlog: { processingPending: cohort?.pending ?? 0, failed: cohort?.failed ?? 0, unpublished: cohort?.unpublished ?? 0 },
    latency: { basis: "discovery to current public projection readiness, including its selected release gate; not first visitor delivery",
      byLane: latenciesByLane },
    sample: { normalTarget: trial.normal_limit, normalObserved: normal, sufficientForTarget: normal >= trial.normal_limit },
    provider: { scope: "isolated database, all live attempts since trial creation", attempts, receiptReuseCount: null,
      attemptsStartedAfterClose: afterClose?.n ?? 0,
      executionBounds: modelExecutionBounds(modelAttempts, now),
      accountBilledCost: null, accountBilledDifference: null,
      computedCost: costComplete ? { amount: totalCost, currency: currencies[0], basis: bases.length === 1 ? bases[0] : "mixed" } : null,
      directArticleCosts, mixedCosts,
      directArticleCostPer100Normal: costComplete && normal > 0 && normalArticleCost && normalArticleCost.unpriced === 0
        ? (normalArticleCost.cost ?? 0) * 100 / normal : null,
      totalCostPer100Normal: null,
      blendedSampleCostPerPublic: costComplete && publiclyListed > 0 ? totalCost / publiclyListed : null,
      blendedSampleCostPerSelected: costComplete && selected > 0 ? totalCost / selected : null,
      costNote: "首轮回灌与正常增量分开；总成本含来源与历史调用，混跑时不推算日常每100条费用。" },
    qualityLabels: {
      status: "awaiting-human-review", denominator: 0,
      fields: ["AI误筛", "AI漏选", "非AI规则差异", "分类错误", "错并", "漏并", "摘要事实错误"],
      note: "模板留空；无人工金标准时不得宣称准确率达标。",
    },
  };
}
