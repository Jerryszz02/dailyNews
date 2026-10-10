// Durable listing handoff. Queue payloads contain IDs; large source responses stay in PostgreSQL.
import { sql, type Db } from "../db.ts";
import { collectionDomain } from "../lib/collection-domain.ts";
import { withRequestDeadline } from "../lib/request-scope.ts";
import { upsertMaterial, contentHash } from "../content/materials.ts";
import { admitArticle, assertTrialRuntime } from "../dailynews/trial.ts";
import { queueProcessing } from "../jobs/content.ts";
import { enqueue, QUEUES, shutdownSignal } from "../jobs/queue.ts";
import {
  completeReceipt,
  BudgetExceededError,
  ReceiptUnknownError,
  ReceiptBusyError,
} from "../providers/receipts.ts";
import { lockEditorialProjection } from "../publication/reprocess.ts";
import { fetchDetail, type DetailNeed } from "./web-list.ts";
import { FetchError, type Candidate, type SourceRow } from "./types.ts";

export interface IntakeCandidate {
  candidate: Candidate;
  need: DetailNeed | null;
}
const restore = (raw: Candidate): Candidate => ({
  ...raw,
  publishedAt: raw.publishedAt ? new Date(raw.publishedAt) : null,
  sourceUpdatedAt: raw.sourceUpdatedAt ? new Date(raw.sourceUpdatedAt) : null,
  ...(raw.discoveredAt ? { discoveredAt: new Date(raw.discoveredAt) } : {}),
  ...(raw.detailCheckedAt
    ? { detailCheckedAt: new Date(raw.detailCheckedAt) }
    : {}),
});

export async function receiveCollection(
  runId: number,
  sourceId: string,
  items: IntakeCandidate[],
  opts: {
    trialId: string | null;
    backfill: string | null;
    cursor: Record<string, unknown>;
    receiptIds: number[];
    detail: Record<string, unknown>;
  },
) {
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('collection-source'),hashtext(${sourceId}))`;
    const [owner] =
      await tx`SELECT collection_run_id FROM sources WHERE id=${sourceId}`;
    if (Number(owner?.collection_run_id) !== Number(runId))
      throw new Error("collection run superseded");
    await tx`INSERT INTO collection_intakes (run_id,source_id,trial_id,backfill,cursor,receipt_ids,detail)
      VALUES (${runId},${sourceId},${opts.trialId},${opts.backfill},${tx.json(opts.cursor as never)},${tx.json(opts.receiptIds)},${tx.json(opts.detail as never)})`;
    for (let offset = 0; offset < items.length; offset += 50) {
      const [batch] =
        await tx`INSERT INTO collection_batches(run_id) VALUES (${runId}) RETURNING id`;
      const batchId = Number(batch!.id);
      const rows = items.slice(offset, offset + 50).map((item) => ({
        batch_id: batchId,
        candidate: tx.json(item.candidate as never),
        need: item.need ? tx.json(item.need as never) : null,
      }));
      await tx`INSERT INTO collection_items ${tx(rows, "batch_id", "candidate", "need")}`;
      await enqueue(
        QUEUES.storeCollection,
        { batchId },
        { singletonKey: String(batchId) },
        tx,
      );
    }
    if (!items.length) await finishCollection(tx, runId);
  });
}

async function finishCollection(tx: Db, runId: number) {
  const [run] =
    await tx`SELECT * FROM collection_intakes WHERE run_id=${runId} FOR UPDATE`;
  if (!run || run.finished_at) return;
  const [pending] =
    await tx`SELECT 1 FROM collection_items i JOIN collection_batches b ON b.id=i.batch_id WHERE b.run_id=${runId} AND i.completed_at IS NULL LIMIT 1`;
  if (pending) return;
  const [counts] = await tx`SELECT count(*)::int AS saved,
    count(*) FILTER (WHERE (i.result->>'created')::boolean)::int AS created,
    count(*) FILTER (WHERE (i.result->>'revised')::boolean)::int AS revised,
    count(*) FILTER (WHERE i.result->>'unchanged'='true')::int AS unchanged,
    coalesce(sum((i.result->>'admittedNormal')::int),0)::int AS normal,
    coalesce(sum((i.result->>'admittedBackfill')::int),0)::int AS backfill,
    coalesce(sum((i.result->>'notAdmitted')::int),0)::int AS refused,
    coalesce(sum((i.result->>'storeMs')::int),0)::int AS store_ms,
    coalesce(sum((i.result->>'detailMs')::int),0)::int AS detail_ms
    FROM collection_items i JOIN collection_batches b ON b.id=i.batch_id WHERE b.run_id=${runId}`;
  const detail = {
    ...run.detail,
    stages: {
      ...run.detail.stages,
      saved: counts!.saved,
      storeMs: counts!.store_ms,
      detailMs: counts!.detail_ms,
      revised: counts!.revised,
      unchanged: counts!.unchanged,
    },
    ...(run.trial_id
      ? {
          boundedTrial: {
            id: run.trial_id,
            revised: counts!.revised,
            admittedNormal: counts!.normal,
            admittedBackfill: counts!.backfill,
            notAdmitted: counts!.refused,
            unchanged: counts!.unchanged,
          },
        }
      : {}),
  };
  const changed =
    await tx`UPDATE sources SET last_fetch_at=now(),last_ok_at=now(),fail_count=0,last_error=NULL,health='ok',
    cursor=${tx.json(run.cursor)},updated_at=now(),next_fetch_at=now()+make_interval(mins=>interval_minutes)
    WHERE id=${run.source_id} AND collection_run_id=${runId} RETURNING id`;
  if (!changed.length)
    throw new Error("collection run superseded before cursor commit");
  await tx`UPDATE collection_intakes SET finished_at=now() WHERE run_id=${runId}`;
  await tx`UPDATE fetch_runs SET status='ok',finished_at=now(),new_count=${counts!.created},detail=${tx.json(detail as never)} WHERE id=${runId}`;
  for (const receiptId of run.receipt_ids as number[])
    await completeReceipt(tx, receiptId);
}

async function saveInput(
  tx: Db,
  input: any,
  enriched?: Candidate,
  detailMs = 0,
) {
  const started = performance.now();
  const c = enriched ?? restore(input.candidate);
  const res = await upsertMaterial(
    { ...c, sourceId: input.source_id, via: "fetch", backfill: input.backfill },
    tx,
  );
  const result = {
    created: res.created,
    revised: res.revised,
    unchanged: !res.created && !res.revised,
    detailMs,
    storeMs: 0,
    admittedNormal: 0,
    admittedBackfill: 0,
    notAdmitted: 0,
  };
  let process = res.created || res.revised;
  if (process && input.trial_id) {
    const lane = res.backfill ? "backfill" : "normal";
    const admission = await admitArticle(res.articleId, { lane }, tx);
    if (
      !admission.admitted &&
      admission.reason !== "quota" &&
      admission.reason !== "not-new"
    )
      throw new Error(`bounded trial admission failed: ${admission.reason}`);
    if (!admission.admitted) {
      result.notAdmitted++;
      process = false;
    } else if (admission.reason === "admitted") {
      if (lane === "normal") result.admittedNormal++;
      else result.admittedBackfill++;
    }
  }
  if (process) await queueProcessing(res.articleId, { db: tx });
  result.storeMs = Math.round(performance.now() - started);
  await tx`UPDATE collection_items SET completed_at=now(),result=${tx.json(result)} WHERE id=${input.id}`;
  return { state: "saved", ...result };
}

async function ownRun(
  tx: Db,
  sourceId: string,
  runId: number,
  trialId: string | null,
) {
  // Separate collection lease avoids source row -> editorial lock inversion with admin edits.
  await tx`SELECT pg_advisory_xact_lock(hashtext('collection-source'),hashtext(${sourceId}))`;
  const [source] =
    await tx`SELECT collection_run_id FROM sources WHERE id=${sourceId}`;
  if (Number(source?.collection_run_id) !== Number(runId))
    throw new Error("collection run superseded");
  const trial = await assertTrialRuntime(tx);
  if ((trial?.id ?? null) !== trialId || (trial && trial.status !== "open"))
    throw new Error("collection intake trial boundary changed");
}

async function saveItem(itemId: number, enriched?: Candidate, detailMs = 0) {
  return sql.begin(async (tx) => {
    const [input] =
      await tx`SELECT i.*,b.run_id,r.source_id,r.trial_id,r.backfill FROM collection_items i
      JOIN collection_batches b ON b.id=i.batch_id JOIN collection_intakes r ON r.run_id=b.run_id WHERE i.id=${itemId}`;
    if (!input || input.completed_at) return { state: "complete" };
    await ownRun(tx, input.source_id, Number(input.run_id), input.trial_id);
    const [item] =
      await tx`SELECT completed_at FROM collection_items WHERE id=${itemId} FOR UPDATE`;
    if (item!.completed_at) return { state: "complete" };
    const result = await saveInput(tx, input, enriched, detailMs);
    await finishCollection(tx, Number(input.run_id));
    return result;
  });
}

export async function storeCollectionBatch(batchId: number) {
  return sql.begin(async (tx) => {
    const [batch] =
      await tx`SELECT b.*,r.source_id,r.trial_id,r.backfill FROM collection_batches b JOIN collection_intakes r ON r.run_id=b.run_id WHERE b.id=${batchId}`;
    if (!batch) return { items: 0 };
    await ownRun(tx, batch.source_id, Number(batch.run_id), batch.trial_id);
    const items =
      await tx`SELECT * FROM collection_items WHERE batch_id=${batchId} AND completed_at IS NULL ORDER BY id FOR UPDATE`;
    const ordinary = items.filter((item) => !item.need);
    if (ordinary.length) {
      const identities = ordinary.map((item) => item.candidate.identityKey);
      const existing =
        await tx`SELECT identity_key,source_id,content_hash,body_text,excerpt FROM articles WHERE identity_key=ANY(${identities}::text[])`;
      const known = new Map(existing.map((row) => [row.identity_key, row]));
      // A batch may insert a new FK before revising another article. Take the editorial lock
      // before either write when any input may change; repeated no-op batches avoid this lock.
      if (
        ordinary.some((item) => {
          const a = known.get(item.candidate.identityKey);
          return (
            !!(
              item.candidate.detailCheckedAt && item.candidate.listingSignature
            ) ||
            !a ||
            (a.source_id === batch.source_id &&
              a.content_hash !==
                contentHash({
                  title: item.candidate.title,
                  bodyText: item.candidate.bodyText ?? a.body_text,
                  excerpt: item.candidate.excerpt ?? a.excerpt,
                }))
          );
        })
      )
        await lockEditorialProjection(tx);
    }
    for (const item of items) {
      if (item.need)
        await enqueue(
          QUEUES.detailCollection,
          { itemId: Number(item.id) },
          {
            singletonKey: String(item.id),
            group: { id: collectionDomain(item.candidate.url) },
            ...(item.detail_retry_at
              ? { startAfter: new Date(item.detail_retry_at) }
              : {}),
          },
          tx,
        );
      else await saveInput(tx, { ...item, ...batch, id: item.id });
    }
    await tx`UPDATE collection_batches SET dispatched_at=now() WHERE id=${batchId}`;
    await finishCollection(tx, Number(batch.run_id));
    return { items: items.length };
  });
}

export function enrichCollectionItem(itemId: number) {
  return withRequestDeadline(90_000, shutdownSignal.signal, () =>
    enrichItem(itemId),
  );
}
async function enrichItem(itemId: number) {
  const [item] =
    await sql`SELECT i.*,s.id,s.name,s.kind,s.config,s.tier,s.participation_mode,s.first_party,s.interval_minutes,s.enabled,s.cursor,s.fail_count
    FROM collection_items i JOIN collection_batches b ON b.id=i.batch_id JOIN collection_intakes r ON r.run_id=b.run_id JOIN sources s ON s.id=r.source_id WHERE i.id=${itemId}`;
  if (!item || item.completed_at) return { state: "complete" };
  if (item.detail_retry_at && new Date(item.detail_retry_at) > new Date()) {
    await enqueue(
      QUEUES.detailCollection,
      { itemId },
      {
        singletonKey: String(itemId),
        group: { id: collectionDomain(item.candidate.url) },
        startAfter: new Date(item.detail_retry_at),
      },
    );
    return { state: "waiting" };
  }
  const candidate = restore(item.candidate);
  const started = performance.now();
  let got;
  try {
    got = await fetchDetail(
      candidate.url,
      item as unknown as SourceRow,
      item.need as DetailNeed,
      { strictHttp: true },
    );
  } catch (error) {
    if (shutdownSignal.signal.aborted || error instanceof ReceiptUnknownError)
      throw error;
    if (
      error instanceof BudgetExceededError ||
      error instanceof ReceiptBusyError
    ) {
      const retryAt = new Date(
        Date.now() +
          (error instanceof BudgetExceededError
            ? error.retryAfterSeconds
            : 60) *
            1000,
      );
      await sql.begin(async (tx) => {
        await tx`UPDATE collection_items SET detail_retry_at=${retryAt},detail_error=${String(error).slice(0, 500)} WHERE id=${itemId} AND completed_at IS NULL`;
        await enqueue(
          QUEUES.detailCollection,
          { itemId },
          {
            singletonKey: String(itemId),
            startAfter: retryAt,
            group: { id: collectionDomain(candidate.url) },
          },
          tx,
        );
      });
      return { state: "waiting", retryAt };
    }
    const [attempt] =
      await sql`UPDATE collection_items SET detail_attempts=detail_attempts+1,detail_error=${String(error).slice(0, 500)}
      WHERE id=${itemId} AND completed_at IS NULL RETURNING detail_attempts`;
    if (!attempt) return { state: "complete" };
    const permanent =
      error instanceof FetchError &&
      error.status !== null &&
      error.status !== 429 &&
      error.status < 500;
    const retryAfter = (error as { retryAfterSeconds?: number })
      .retryAfterSeconds;
    if (
      attempt.detail_attempts < 3 &&
      !permanent &&
      !(retryAfter && retryAfter > 6 * 3600)
    ) {
      const retryAt = new Date(
        Date.now() +
          Math.max(
            30 * 2 ** (attempt.detail_attempts - 1),
            Number.isFinite(retryAfter) ? retryAfter! : 0,
          ) *
            1000,
      );
      await sql.begin(async (tx) => {
        await tx`UPDATE collection_items SET detail_retry_at=${retryAt} WHERE id=${itemId} AND completed_at IS NULL`;
        await enqueue(
          QUEUES.detailCollection,
          { itemId },
          {
            singletonKey: String(itemId),
            startAfter: retryAt,
            group: { id: collectionDomain(candidate.url) },
          },
          tx,
        );
      });
      return { state: "retrying", retryAt };
    }
    // Match the original best-effort detail behavior only after bounded retries. Missing
    // authoritative dates remain missing, so existing archive/publication gates still apply.
    return saveItem(itemId, candidate, Math.round(performance.now() - started));
  }
  candidate.detailCheckedAt = new Date();
  if (got.title) candidate.title = got.title;
  if (got.summary) candidate.excerpt = got.summary;
  if (got.body) {
    candidate.bodyHtml = got.body.html;
    candidate.bodyText = got.body.text;
    candidate.bodyStatus = "ok";
    if (!candidate.media?.length) candidate.media = got.body.images;
  }
  if (
    got.publishedAt &&
    (!candidate.publishedAt ||
      Math.abs(got.publishedAt.getTime() - candidate.publishedAt.getTime()) <
        86_400_000)
  )
    candidate.publishedAt = got.publishedAt;
  return saveItem(itemId, candidate, Math.round(performance.now() - started));
}

/** Re-dispatch pending intake after a crash/lost queue job; singleton keys avoid active duplicates. */
export async function recoverCollections(): Promise<{ enqueued: number }> {
  const batches =
    await sql`SELECT b.id FROM collection_batches b JOIN collection_intakes r ON r.run_id=b.run_id
    WHERE r.finished_at IS NULL AND EXISTS(SELECT 1 FROM collection_items i WHERE i.batch_id=b.id AND i.completed_at IS NULL) ORDER BY b.id LIMIT 200`;
  for (const batch of batches)
    await enqueue(
      QUEUES.storeCollection,
      { batchId: Number(batch.id) },
      { singletonKey: String(batch.id) },
    );
  return { enqueued: batches.length };
}
