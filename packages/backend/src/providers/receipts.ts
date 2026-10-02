// Paid requests (models, SocialData, Jina, Dajiala) go through here.
//
// 1. A logical request has a stable key bound to task, input revision, provider, model, prompt and config.
// 2. Before calling, a placeholder row and an attempt row are persisted; budgets count attempts.
// 3. The raw response is saved before any business write; recovery reuses a received response.
// 4. A request whose outcome is unknown (timeout after sending, crash mid-flight) is not re-sent by the
//    caller. ops.recover releases it once after 30 minutes (operations/recover.ts), so a lost answer
//    costs at most one repeat; after that it waits for the admin.
import { sql, type Db } from "../db.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { shutdownSignal } from "../lib/shutdown.ts";
import { setTimeout as wait } from "node:timers/promises";
import { observedTokens } from "./pricing.ts";
import { assertTrialPaidSubject, boundedTrialEnabled } from "../dailynews/trial.ts";

export class BudgetExceededError extends Error {
  readonly service: string;
  readonly retryAfterSeconds: number;
  constructor(service: string, window: string, retryAfterSeconds: number) {
    super(`Budget for ${service} exhausted (${window})`);
    this.service = service;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class ReceiptBusyError extends Error {}

export class ReceiptUnknownError extends Error {
  readonly receiptId: number;
  constructor(receiptId: number, message: string) {
    super(message);
    this.receiptId = receiptId;
  }
}

/** Raised by a call when the provider clearly did not accept (and will not bill) the request. */
export class ProviderRejectedError extends Error {
  readonly status: number | null;
  readonly retryable: boolean;
  constructor(message: string, status: number | null, retryable: boolean) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

export interface CallOutcome {
  response: unknown;
  requestId?: string | null;
  responseModel?: string | null;
  usage?: Record<string, unknown> | null;
  cost?: { amount: number; currency: string; basis: "actual" | "estimated"; snapshot?: Record<string, unknown>; pricedAt?: Date } | null;
}

export interface ReceiptRequest {
  service: string;
  /** Count this call in the global cross-provider LLM concurrency gate. */
  resourceKind?: "llm";
  /** Resolved model endpoint for the trial gate only; never persisted in receipt rows. */
  providerBaseUrl?: string;
  model?: string | null;
  purpose: string;
  subject?: string | null;
  /** Everything that determines the output. Hashed into the logical key; only a redacted summary is stored. */
  identity: unknown;
  /** Stored for diagnosis; must not contain secrets. */
  requestSummary?: Record<string, unknown>;
  /** Distinguishes an explicit re-run (e.g. admin "re-evaluate") from recovery of the same request. */
  attemptTag?: string;
}

export interface ReceiptResult {
  receiptId: number;
  response: unknown;
  reused: boolean;
}

const PENDING_STALE_MS = 10 * 60 * 1000;
const MAX_ACTIVE_LLM = 2;
const MAX_LLM_WAIT_MS = 4 * 60 * 1000;
const TRIAL_LLM_LIMITS = { per_minute: 20, per_hour: 200, per_day: 1000 } as const;

export function logicalKeyFor(req: ReceiptRequest): string {
  const identity = sha256(stableJson(req.identity));
  return [req.service, req.purpose, req.model ?? "-", identity, req.attemptTag ?? "0"].join(":");
}

interface ReceiptRow {
  id: number;
  status: string;
  response: unknown;
  created_at: Date;
  updated_at: Date;
}

async function checkBudget(tx: Db, service: string): Promise<void> {
  const [budget] = await tx<{ per_minute: number; per_hour: number; per_day: number }[]>`
    SELECT per_minute, per_hour, per_day FROM budgets WHERE service = ${service}`;
  if (!budget) throw new BudgetExceededError(service, "missing", 3600);
  // Every request sent counts, retries of the same logical request included.
  const [counts] = await tx<{ minute: number; hour: number; day: number }[]>`
    SELECT
      count(*) FILTER (WHERE started_at > now() - interval '1 minute') AS minute,
      count(*) FILTER (WHERE started_at > now() - interval '1 hour') AS hour,
      count(*) AS day
    FROM receipt_attempts
    WHERE service = ${service} AND origin = 'live' AND started_at > now() - interval '1 day'`;
  const c = counts!;
  if (budget.per_minute <= 0 || budget.per_hour <= 0 || budget.per_day <= 0) {
    throw new BudgetExceededError(service, "stopped", 3600);
  }
  if (c.minute >= budget.per_minute) throw new BudgetExceededError(service, "minute", 60);
  if (c.hour >= budget.per_hour) throw new BudgetExceededError(service, "hour", 600);
  if (c.day >= budget.per_day) throw new BudgetExceededError(service, "day", 3600);
}

/** The bounded trial has one explicit model budget across all chat providers, not a budget per alias. */
async function checkTrialLlmBudget(tx: Db): Promise<void> {
  if (!boundedTrialEnabled()) return;
  const [budget] = await tx<{ per_minute: number; per_hour: number; per_day: number }[]>`
    SELECT per_minute, per_hour, per_day FROM budgets WHERE service='llm-global'`;
  if (!budget || Object.entries(TRIAL_LLM_LIMITS).some(([key, max]) => {
    const limit = budget[key as keyof typeof TRIAL_LLM_LIMITS];
    return limit <= 0 || limit > max;
  })) throw new BudgetExceededError("llm-global", "missing-or-outside-trial-limit", 3600);
  const [counts] = await tx<{ minute: number; hour: number; day: number }[]>`
    SELECT count(*) FILTER (WHERE started_at > now()-interval '1 minute')::int AS minute,
           count(*) FILTER (WHERE started_at > now()-interval '1 hour')::int AS hour,
           count(*)::int AS day
    FROM receipt_attempts
    WHERE is_llm AND origin='live' AND started_at > now()-interval '1 day'`;
  if (counts!.minute >= budget.per_minute) throw new BudgetExceededError("llm-global", "minute", 60);
  if (counts!.hour >= budget.per_hour) throw new BudgetExceededError("llm-global", "hour", 600);
  if (counts!.day >= budget.per_day) throw new BudgetExceededError("llm-global", "day", 3600);
}

async function checkLlmReservation(tx: Db): Promise<boolean> {
  await checkTrialLlmBudget(tx);
  await markStaleLlmAttempts(tx);
  const [active] = await tx<{ n: number }[]>`
    SELECT count(*)::int AS n FROM receipt_attempts WHERE is_llm AND origin='live' AND status='pending'`;
  return active!.n < MAX_ACTIVE_LLM;
}

/** A crashed LLM call cannot own a slot forever; recovery still leaves its receipt unknown. */
async function markStaleLlmAttempts(tx: Db): Promise<void> {
  const cutoff = new Date(Date.now() - PENDING_STALE_MS);
  const stale = await tx<{ id: number }[]>`
    UPDATE receipts r SET status='unknown', error='placeholder went stale without a recorded result', updated_at=now()
    WHERE r.status='pending' AND r.updated_at < ${cutoff} AND EXISTS (
      SELECT 1 FROM receipt_attempts a WHERE a.receipt_id=r.id AND a.is_llm AND a.status='pending' AND a.started_at < ${cutoff})
    RETURNING r.id`;
  if (stale.length) await tx`
    UPDATE receipt_attempts SET status='unknown', error='placeholder went stale without a recorded result', finished_at=now()
    WHERE receipt_id IN ${tx(stale.map((r) => r.id))} AND is_llm AND status='pending'`;
}

/**
 * Runs a paid request at most once per logical key and returns its raw response.
 * The caller parses the response and commits business results, then calls completeReceipt.
 */
export async function paidRequest(req: ReceiptRequest, call: () => Promise<CallOutcome>): Promise<ReceiptResult> {
  const logicalKey = logicalKeyFor(req);
  const waitStarted = Date.now();
  let claimed: Awaited<ReturnType<typeof claimPaidRequest>>;
  while (true) {
    // The trial cohort/settings can be revoked while a call waits for a shared slot.
    await assertTrialPaidSubject(req.purpose, req.subject ?? "", sql, req);
    claimed = await claimPaidRequest(req, logicalKey);
    if (claimed.kind !== "capacity") break;
    shutdownSignal.signal.throwIfAborted();
    if (Date.now() - waitStarted >= MAX_LLM_WAIT_MS) throw new BudgetExceededError("llm-global", "concurrency", 5);
    await wait(250, undefined, { signal: shutdownSignal.signal });
  }

  if (claimed.kind === "reuse") return { receiptId: claimed.row.id, response: claimed.row.response, reused: true };
  if (claimed.kind === "busy") throw new ReceiptBusyError(`Receipt ${claimed.row.id} is in flight`);
  if (claimed.kind === "unknown") {
    throw new ReceiptUnknownError(claimed.row.id, `Receipt ${claimed.row.id} has an unknown outcome; it is released once automatically, then from the admin`);
  }

  const { id: receiptId, attemptId } = claimed;
  const started = Date.now();
  let outcome: CallOutcome;
  try {
    outcome = await call();
  } catch (error) {
    const status = error instanceof ProviderRejectedError ? "failed" : "unknown";
    // "unknown": the request may have reached the provider (timeout, reset): do not re-send automatically.
    const message = (error instanceof ProviderRejectedError ? error.message : String(error)).slice(0, 2000);
    await sql.begin(async (tx) => {
      await tx`UPDATE receipts SET status = ${status}, error = ${message}, updated_at = now() WHERE id = ${receiptId}`;
      await tx`UPDATE receipt_attempts SET status = ${status}, error = ${message}, latency_ms = ${Date.now() - started}, finished_at = now() WHERE id = ${attemptId}`;
    });
    throw error;
  }

  const observed = observedTokens(outcome.usage);
  await sql.begin(async (tx) => {
    await tx`
      UPDATE receipts SET
        status = 'received',
        response = ${tx.json((outcome.response ?? null) as never)},
        request_id = ${outcome.requestId ?? null},
        response_model = ${outcome.responseModel ?? null},
        usage = ${outcome.usage ? tx.json(outcome.usage as never) : null},
        prompt_tokens = ${observed.promptTokens}, cache_hit_tokens = ${observed.cacheHitTokens},
        cache_miss_tokens = ${observed.cacheMissTokens}, completion_tokens = ${observed.completionTokens},
        cost = ${outcome.cost?.amount ?? null},
        currency = ${outcome.cost?.currency ?? null},
        cost_basis = ${outcome.cost?.basis ?? null},
        price_snapshot = ${outcome.cost?.snapshot ? tx.json(outcome.cost.snapshot as never) : null},
        priced_at = ${outcome.cost?.pricedAt ?? null},
        received_at = now(),
        updated_at = now()
      WHERE id = ${receiptId}`;
    await tx`
      UPDATE receipt_attempts SET
        status = 'received', request_id = ${outcome.requestId ?? null}, response_model = ${outcome.responseModel ?? null},
        usage = ${outcome.usage ? tx.json(outcome.usage as never) : null},
        prompt_tokens = ${observed.promptTokens}, cache_hit_tokens = ${observed.cacheHitTokens},
        cache_miss_tokens = ${observed.cacheMissTokens}, completion_tokens = ${observed.completionTokens},
        cost = ${outcome.cost?.amount ?? null}, currency = ${outcome.cost?.currency ?? null}, cost_basis = ${outcome.cost?.basis ?? null},
        price_snapshot = ${outcome.cost?.snapshot ? tx.json(outcome.cost.snapshot as never) : null},
        priced_at = ${outcome.cost?.pricedAt ?? null},
        latency_ms = ${Date.now() - started}, finished_at = now()
      WHERE id = ${attemptId}`;
  });
  return { receiptId, response: outcome.response, reused: false };
}

async function claimPaidRequest(req: ReceiptRequest, logicalKey: string) {
  return sql.begin(async (tx) => {
    // All model presets, including default, take the same distributed lock before reserving a slot.
    if (req.resourceKind === "llm") await tx`SELECT pg_advisory_xact_lock(hashtext('budget:llm-global'))`;
    // Serialise budget checks per service so concurrent workers cannot overshoot.
    await tx`SELECT pg_advisory_xact_lock(hashtext(${"budget:" + req.service}))`;
    if (boundedTrialEnabled()) {
      // A close updates this row. Hold its shared lock through attempt insertion so a
      // close cannot commit between the trial check and the paid reservation.
      await tx`SELECT id FROM dailynews_trials WHERE id=${process.env.DAILYNEWS_TRIAL_ID ?? ""} FOR SHARE`;
      await assertTrialPaidSubject(req.purpose, req.subject ?? "", tx, req);
    }
    const [existing] = await tx<ReceiptRow[]>`
      SELECT id, status, response, created_at, updated_at FROM receipts WHERE logical_key = ${logicalKey} FOR UPDATE`;
    if (existing?.status === "received" || existing?.status === "completed") return { kind: "reuse" as const, row: existing };
    // Finish business writes from saved answers during shutdown, but never reserve or send the
    // next paid page/batch. An answer already in flight still saves below, without this check.
    shutdownSignal.signal.throwIfAborted();
    if (existing) {
      if (existing.status === "pending") {
        if (Date.now() - existing.updated_at.getTime() < PENDING_STALE_MS) return { kind: "busy" as const, row: existing };
        await markUnknown(tx, existing.id, "placeholder went stale without a recorded result");
        return { kind: "unknown" as const, row: existing };
      }
      if (existing.status === "unknown") return { kind: "unknown" as const, row: existing };
      // failed: the provider did not take the request, or its answer was unusable; a new attempt is allowed.
      await checkBudget(tx, req.service);
      if (req.resourceKind === "llm") {
        if (!await checkLlmReservation(tx)) return { kind: "capacity" as const };
      }
      const [r] = await tx<{ attempts: number }[]>`
        UPDATE receipts SET status = 'pending', attempts = attempts + 1, error = NULL, updated_at = now() WHERE id = ${existing.id} RETURNING attempts`;
      const attemptId = await startAttempt(tx, existing.id, r!.attempts, req);
      return { kind: "call" as const, id: existing.id, attemptId };
    }
    await checkBudget(tx, req.service);
    if (req.resourceKind === "llm") {
      if (!await checkLlmReservation(tx)) return { kind: "capacity" as const };
    }
    const [row] = await tx<{ id: number }[]>`
      INSERT INTO receipts (logical_key, service, model, purpose, subject, status, request, attempts)
      VALUES (${logicalKey}, ${req.service}, ${req.model ?? null}, ${req.purpose}, ${req.subject ?? null}, 'pending',
              ${tx.json((req.requestSummary ?? {}) as never)}, 1)
      RETURNING id`;
    const attemptId = await startAttempt(tx, row!.id, 1, req);
    return { kind: "call" as const, id: row!.id, attemptId };
  });
}

async function startAttempt(tx: Db, receiptId: number, attempt: number, req: ReceiptRequest): Promise<number> {
  const [row] = await tx<{ id: number }[]>`
    INSERT INTO receipt_attempts (receipt_id, attempt, service, model, status, is_llm) VALUES (${receiptId}, ${attempt}, ${req.service}, ${req.model ?? null}, 'pending', ${req.resourceKind === "llm"})
    RETURNING id`;
  return row!.id;
}

async function markUnknown(tx: Db, receiptId: number, reason: string) {
  await tx`UPDATE receipts SET status = 'unknown', error = ${reason}, updated_at = now() WHERE id = ${receiptId}`;
  await tx`UPDATE receipt_attempts SET status = 'unknown', error = ${reason}, finished_at = now() WHERE receipt_id = ${receiptId} AND status = 'pending'`;
}

/**
 * Placeholders left behind by a process that stopped mid-request (crash, kill) become "unknown", so
 * they are released like any other unknown outcome even when nothing retries them.
 */
export async function markStalePendingReceipts(): Promise<number> {
  const reason = "placeholder went stale without a recorded result";
  return sql.begin(async (tx) => {
    // Recheck status and age when the row lock is acquired: a response may commit while we wait.
    const stale = await tx<{ id: number }[]>`
      UPDATE receipts SET status = 'unknown', error = ${reason}, updated_at = now()
      WHERE status = 'pending' AND updated_at < ${new Date(Date.now() - PENDING_STALE_MS)} RETURNING id`;
    if (stale.length) {
      await tx`UPDATE receipt_attempts SET status = 'unknown', error = ${reason}, finished_at = now()
               WHERE receipt_id IN ${tx(stale.map((r) => r.id))} AND status = 'pending'`;
    }
    return stale.length;
  });
}

/**
 * Releases an unknown receipt: marked failed, so the next attempt of its request calls again (who
 * releases and when: operations/recover.ts). Null when the receipt is not, or no longer, unknown.
 */
export async function releaseUnknownReceipt(db: Db, id: number, error: string): Promise<{ subject: string | null; purpose: string } | null> {
  const [released] = await db<{ subject: string | null; purpose: string }[]>`
    UPDATE receipts SET status = 'failed', error = ${error}, updated_at = now() WHERE id = ${id} AND status = 'unknown' RETURNING subject, purpose`;
  if (released) await db`UPDATE receipt_attempts SET status = 'failed', error = ${error} WHERE receipt_id = ${id} AND status = 'unknown'`;
  return released ?? null;
}

export async function completeReceipt(db: Db, receiptId: number): Promise<void> {
  await db`UPDATE receipts SET status = 'completed', completed_at = coalesce(completed_at, now()), updated_at = now() WHERE id = ${receiptId}`;
}

/** Marks a received response that could not be used (e.g. unparsable) so a fresh attempt can be made. */
export async function rejectReceivedResponse(receiptId: number, reason: string): Promise<void> {
  await sql`UPDATE receipts SET status = 'failed', error = ${reason.slice(0, 2000)}, updated_at = now() WHERE id = ${receiptId}`;
}
