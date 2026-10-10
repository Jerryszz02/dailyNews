// Durable generation is authoritative. Duplicate/lost queue wake-ups cannot lose changes.
import { sql, type Tx } from "../db.ts";
import { enqueue, QUEUES } from "../jobs/queue.ts";
import { reconcileEditorialPoliciesTx } from "./editorial.ts";

export const EDITORIAL_BATCH_WINDOW_MS = 2_000;
export const EDITORIAL_BATCH_EVENTS = 100;
interface BatchState {
  generation: number;
  applied_generation: number;
  pending_events: number;
  first_dirty_at: Date | null;
}

/** Publication lock must precede the state row, preserving the global lock order. */
export async function markEditorialDirtyTx(tx: Tx, now: Date): Promise<void> {
  const [state] = await tx<BatchState[]>`
    UPDATE editorial_batch_state SET generation = generation + 1, pending_events = pending_events + 1,
      first_dirty_at = coalesce(first_dirty_at, ${now}) WHERE id = true
    RETURNING generation, applied_generation, pending_events, first_dirty_at`;
  if (!state) throw new Error("editorial batch state missing");
  const firstGeneration = state.generation - state.pending_events + 1;
  await enqueue(QUEUES.editorialBatch, {}, {
    singletonKey: `editorial:${firstGeneration}`,
    startAfter: new Date(state.first_dirty_at!.getTime() + EDITORIAL_BATCH_WINDOW_MS),
  }, tx);
  if (state.pending_events === EDITORIAL_BATCH_EVENTS) {
    await enqueue(QUEUES.editorialBatch, {}, {
      singletonKey: `editorial:threshold:${state.generation}`, priority: 1,
    }, tx);
  }
}

/** A <=2s worker timer repairs missing wake-ups. Queue backlog is measured separately. */
export async function recoverEditorialBatch(now: Date = new Date()): Promise<boolean> {
  const [state] = await sql<BatchState[]>`SELECT * FROM editorial_batch_state WHERE id = true`;
  if (!state?.first_dirty_at || state.generation === state.applied_generation ||
    now.getTime() - state.first_dirty_at.getTime() < EDITORIAL_BATCH_WINDOW_MS) return false;
  await enqueue(QUEUES.editorialBatch, {}, {
    singletonKey: `editorial:recovery:${state.generation}`, priority: 1,
  });
  return true;
}

export async function reconcileEditorialBatch(now?: Date) {
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('dailynews-editorial-projection'))`;
    await tx`SELECT pg_advisory_xact_lock_shared(hashtext('report_candidates'))`;
    const [state] = await tx<BatchState[]>`SELECT * FROM editorial_batch_state WHERE id = true FOR UPDATE`;
    if (!state || state.generation === state.applied_generation) {
      return { facts: 0, selected: 0, requeued: 0, events: 0, generation: state?.generation ?? 0 };
    }
    const result = await reconcileEditorialPoliciesTx(tx, now ?? new Date());
    // All producers hold the publication lock. Writes after commit form a new window.
    await tx`UPDATE editorial_batch_state SET applied_generation = ${state.generation},
      pending_events = 0, first_dirty_at = NULL WHERE id = true`;
    return { ...result, events: state.pending_events, generation: state.generation };
  });
}
