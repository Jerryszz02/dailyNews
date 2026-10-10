// Read-only local operational summary. No bodies, provider requests, credentials or remote telemetry.
// node --env-file=.env scripts/refresh-metrics.ts --hours=24
import { sql, closeDb } from "@aihot/backend/db";

const hours = Number(process.argv.find((arg) => arg.startsWith("--hours="))?.slice(8) ?? 24);
if (!Number.isFinite(hours) || hours <= 0 || hours > 720) throw new Error("--hours must be >0 and <=720");
const since = new Date(Date.now() - hours * 3_600_000);
try {
  const [queue] = await sql<{ present: boolean }[]>`SELECT to_regclass('pgboss.job') IS NOT NULL AS present`;
  const stages = queue?.present ? await sql`
    SELECT name, state, count(*)::int AS jobs,
      sum(retry_count)::int AS retries,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY (output->'metrics'->>'elapsedMs')::numeric) AS work_p50_ms,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY (output->'metrics'->>'elapsedMs')::numeric) AS work_p95_ms,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY (output->'metrics'->>'queueWaitMs')::numeric) AS wait_p95_ms
    FROM pgboss.job WHERE created_on>=${since} GROUP BY name,state ORDER BY name,state` : [];
  const backlog = queue?.present ? await sql`
    SELECT name,count(*)::int AS pending,
      max(greatest(0,extract(epoch FROM (now()-greatest(start_after,created_on)))*1000)) AS oldest_eligible_ms
    FROM pgboss.job WHERE state IN ('created','retry','active') GROUP BY name ORDER BY name` : [];
  const fetches = await sql`
    SELECT status,count(*)::int AS runs,sum(found_count)::int AS returned,sum(new_count)::int AS created,
      sum((detail->'stages'->>'saved')::bigint) AS saved,
      sum((detail->'stages'->>'revised')::bigint) AS revised,
      sum((detail->'stages'->>'unchanged')::bigint) AS unchanged,
      sum((detail->'stages'->>'detailQueued')::bigint) AS detail_queued,
      sum((detail->'stages'->>'fetchMs')::bigint) AS fetch_ms,
      sum((detail->'stages'->>'storeMs')::bigint) AS store_ms,
      sum((detail->'stages'->>'detailMs')::bigint) AS detail_ms,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM finished_at-started_at)*1000) AS p50_ms,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM finished_at-started_at)*1000) AS p95_ms
    FROM fetch_runs WHERE started_at>=${since} GROUP BY status ORDER BY status`;
  const scheduled = await sql`
    SELECT job,status,count(*)::int AS runs,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM finished_at-started_at)*1000) AS p95_ms
    FROM job_runs WHERE started_at>=${since} GROUP BY job,status ORDER BY job,status`;
  const firstVersions = await sql`
    SELECT count(*)::int AS samples,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM p.public_ready_at-a.discovered_at)*1000) AS public_p50_ms,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM p.public_ready_at-a.discovered_at)*1000) AS public_p95_ms,
      count(*) FILTER (WHERE a.published_at IS NULL)::int AS missing_source_time
    FROM articles a JOIN publications p ON p.article_id=a.id
    WHERE a.created_at>=${since} AND a.revision=1 AND NOT a.backfill
      AND p.public_ready_at>=a.discovered_at AND p.visibility='public'`;
  const providerAttempts = await sql`
    SELECT service,currency,cost_basis,status,count(*)::int AS attempts,
      count(*) FILTER (WHERE attempt>1)::int AS repeat_attempts,
      count(*) FILTER (WHERE cost IS NULL)::int AS unpriced_attempts,sum(cost) AS known_cost
    FROM receipt_attempts WHERE started_at>=${since} AND origin='live'
    GROUP BY service,currency,cost_basis,status ORDER BY service,currency,cost_basis,status`;
  const [unknownReleases] = await sql`
    SELECT count(*)::int AS automatic_releases FROM audit_log
    WHERE created_at>=${since} AND action='receipt.release' AND actor='ops.recover'`;
  const [editorial] = await sql`
    SELECT generation,applied_generation,pending_events,first_dirty_at,
      greatest(0,extract(epoch FROM (now()-first_dirty_at))*1000) AS pending_age_ms
    FROM editorial_batch_state WHERE id=true`;
  console.log(JSON.stringify({ since: since.toISOString(), until: new Date().toISOString(), stages, backlog,
    fetches, scheduled, editorial, firstVersions, providerAttempts, unknownReleases,
    notes: ["Timings are backend processing, not browser visibility or source-to-discovery latency.",
      "Queue work/wait timings require jobs processed by the new worker; null is not zero.",
      "Public latency covers first revisions only; updated/withdrawn/backfill items are excluded.",
      "Costs count attempts; unknown or unpriced attempts remain unknown, not free."] }, null, 2));
} finally { await closeDb(); }
