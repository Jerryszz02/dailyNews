// Explicit invalidation, limited to current work. Public reads never call a model.
import { sql, type Tx } from "../db.ts";
import { currentAnalysisSignature } from "../editorial/policy.ts";
import { enqueue, QUEUES } from "../jobs/queue.ts";
import { publishArticleTx } from "./publish.ts";

export interface ReprocessScope {
  sourceId?: string;
  articleIds?: string[];
  now?: Date;
  reason: string;
}

/** Caller must acquire this before article/source locks when it will publish in that transaction. */
export async function lockEditorialProjection(tx: Tx): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtext('dailynews-editorial-projection'))`;
}

/**
 * Only the last 72 hours are automatically re-evaluated. Explicit ids may address older material;
 * neither path rewrites an immutable report. A signature-specific singleton reuses paid receipts.
 */
export async function reprocessAnalysesTx(tx: Tx, scope: ReprocessScope): Promise<{ invalidated: number }> {
  await lockEditorialProjection(tx);
  const now = scope.now ?? new Date();
  const since = new Date(now.getTime() - 72 * 3_600_000);
  const rows = await tx<{ id: string; revision: number; input_revision: number; input_signature: string | null; processing_attempt_tag: string | null }[]>`
    SELECT a.id, a.revision, n.input_revision, n.input_signature, a.processing_attempt_tag
    FROM articles a JOIN sources s ON s.id = a.source_id
    JOIN LATERAL (SELECT input_revision, input_signature, origin FROM analyses
      WHERE article_id = a.id ORDER BY input_revision DESC, id DESC LIMIT 1) n ON true
    WHERE s.participation_mode = 'editorial' AND n.origin = 'model'
      AND (${scope.sourceId ?? null}::text IS NULL OR a.source_id = ${scope.sourceId ?? null})
      AND (${scope.articleIds ?? null}::text[] IS NULL AND NOT a.backfill AND a.discovered_at >= ${since}
        OR a.id = ANY(${scope.articleIds ?? []}::text[]))
    ORDER BY a.discovered_at DESC, a.id FOR UPDATE OF a`;
  let invalidated = 0;
  for (const row of rows) {
    const signature = await currentAnalysisSignature(row.id, tx);
    if (!signature || (row.input_revision === row.revision && row.input_signature === signature)) continue;
    const attemptTag = `policy:${signature}`;
    // The sweep may revisit a queued or exhausted request. A fixed signature is attempted once;
    // normal retry/unknown-receipt recovery, not this sweep, owns retries after dispatch.
    if (row.processing_attempt_tag === attemptTag) continue;
    await publishArticleTx(tx, row.id, { now, queueStaleAnalysis: false });
    await tx`UPDATE articles SET processing_state = 'new', processing_attempts = 0,
      processing_error = ${`policy invalidated: ${scope.reason}`}, processing_retry_at = NULL,
      processing_queued_at = ${now}, processing_attempt_tag = ${attemptTag},
      classification_retry_revision = revision, classification_retry_count = 0
      WHERE id = ${row.id}`;
    await enqueue(QUEUES.analyze, { articleId: row.id, attemptTag },
      { singletonKey: `${row.id}:${attemptTag}`, priority: 0 }, tx);
    invalidated++;
  }
  return { invalidated };
}

export async function reprocessActiveAnalyses(scope: Omit<ReprocessScope, "reason"> & { reason?: string } = {}) {
  return sql.begin((tx) => reprocessAnalysesTx(tx, { ...scope, reason: scope.reason ?? "active-window signature sweep" }));
}
