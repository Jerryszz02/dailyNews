import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { SlotAudit } from "./productionAcceptanceRules";

const RESPONSE_KEYS = [
  "candidateCount",
  "discoveredCount",
  "error",
  "generatedAt",
  "ok",
  "reportId",
  "runId",
  "selectedSourceCount",
  "status",
];

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const iso = (value: unknown): string | null => {
  const time = value instanceof Date ? value.getTime() : Date.parse(String(value ?? ""));
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};
const slot = (value: unknown): string => {
  const date = new Date(String(value));
  date.setUTCSeconds(0, 0);
  date.setUTCMinutes(Math.floor(date.getUTCMinutes() / 15) * 15);
  return date.toISOString();
};
const normalize = (value: unknown): string =>
  typeof value === "string" ? value.trim().toLowerCase().replace(/\s+/g, " ") : "";
const duplicates = (values: unknown[]): number => {
  const counts = new Map<string, number>();
  for (const value of values.map(normalize).filter(Boolean)) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
};
const maxIso = (values: unknown[]): string | null => {
  const times = values.map((value) => Date.parse(String(value))).filter(Number.isFinite);
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
};
const ageMinutes = (now: string, then: string | null): number | null =>
  then ? Math.round(((Date.parse(now) - Date.parse(then)) / 60_000) * 1000) / 1000 : null;
const percentile = (values: number[], value: number): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * value) - 1)] ?? null;
};
const metricIds = (metrics: Record<string, unknown>, key: string): string[] =>
  list(metrics[key]).filter((value): value is string => typeof value === "string");

function parseBody(content: unknown): Record<string, unknown> | null {
  if (content == null) return null;
  let text = Buffer.isBuffer(content) ? content.toString("utf8") : String(content);
  if (text.startsWith("\\x") && /^[0-9a-f]+$/i.test(text.slice(2))) {
    text = Buffer.from(text.slice(2), "hex").toString("utf8");
  }
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function exactNineKeys(body: Record<string, unknown> | null): boolean {
  return Boolean(
    body &&
      JSON.stringify(Object.keys(body).sort()) === JSON.stringify(RESPONSE_KEYS),
  );
}

function reportId(body: unknown): string | null {
  const value = body as {
    refresh?: { reportId?: unknown };
    reportId?: unknown;
    latestReportId?: unknown;
  } | null;
  const id = value?.refresh?.reportId ?? value?.reportId ?? value?.latestReportId;
  return typeof id === "string" ? id : null;
}

function cacheClass(value: string | null): string {
  const header = String(value ?? "").toLowerCase();
  if (header.includes("no-store")) return "no-store";
  if (header.includes("public") && header.includes("max-age=0")) return "public-max-age-0";
  return header ? "other" : "missing";
}

function officialDatabaseUrl(raw: unknown, ref: string): string | null {
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw);
    if (!["postgres:", "postgresql:"].includes(url.protocol)) return null;
    const host = url.hostname.toLowerCase();
    const user = decodeURIComponent(url.username || "");
    const direct = host === `db.${ref}.supabase.co`;
    const pooler =
      host.endsWith(".pooler.supabase.com") &&
      (user === `postgres.${ref}` || user.endsWith(`.${ref}`));
    if (!direct && !pooler) return null;
    for (const key of [...url.searchParams.keys()]) {
      if (key.toLowerCase().startsWith("ssl")) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return null;
  }
}

interface ExternalModules {
  dotenv: {
    parse(source: Buffer): Record<string, string>;
  };
  Client: new (options: Record<string, unknown>) => {
    connection?: { stream?: { encrypted?: boolean } };
    connect(): Promise<void>;
    end(): Promise<void>;
    query(query: string, values?: unknown[]): Promise<{ rows: Array<Record<string, any>> }>;
  };
}

function loadExternalModules(nodeModules: string): ExternalModules {
  const requireFromClient = createRequire(path.join(nodeModules, "package.json"));
  const dotenv = requireFromClient("dotenv") as ExternalModules["dotenv"];
  const { Client } = requireFromClient("pg") as { Client: ExternalModules["Client"] };
  return { dotenv, Client };
}

async function connectReadOnly(
  env: Record<string, string>,
  ref: string,
  Client: ExternalModules["Client"],
) {
  const candidates = [
    ...new Set(
      Object.values(env)
        .map((value) => officialDatabaseUrl(value, ref))
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  let lastCode = "NO_OFFICIAL_DB_URL";

  for (const connectionString of candidates) {
    const strictClient = new Client({
      connectionString,
      ssl: { rejectUnauthorized: true },
      connectionTimeoutMillis: 6_000,
      query_timeout: 15_000,
      keepAlive: false,
    });
    try {
      await strictClient.connect();
      if (strictClient.connection?.stream?.encrypted !== true) {
        throw Object.assign(new Error("TLS_REQUIRED"), { code: "TLS_REQUIRED" });
      }
      return { client: strictClient, strictCert: true };
    } catch (error) {
      await strictClient.end().catch(() => {});
      lastCode = String((error as { code?: unknown })?.code ?? "CONNECT_ERROR");
      const message = String((error as { message?: unknown })?.message ?? "");
      const selfSigned =
        lastCode === "SELF_SIGNED_CERT_IN_CHAIN" ||
        message.includes("self signed certificate in certificate chain");
      if (!selfSigned) continue;
    }

    const fallbackClient = new Client({
      connectionString,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 6_000,
      query_timeout: 15_000,
      keepAlive: false,
    });
    try {
      await fallbackClient.connect();
      if (fallbackClient.connection?.stream?.encrypted !== true) {
        throw Object.assign(new Error("TLS_REQUIRED"), { code: "TLS_REQUIRED" });
      }
      return { client: fallbackClient, strictCert: false };
    } catch (error) {
      await fallbackClient.end().catch(() => {});
      lastCode = String((error as { code?: unknown })?.code ?? "CONNECT_ERROR");
    }
  }

  throw Object.assign(new Error("DB_CONNECT_FAILED"), { code: lastCode });
}

interface FetchResult {
  status: number | null;
  cache: string;
  body: Record<string, any> | null;
  error: string | null;
}

async function fetchJson(url: string): Promise<FetchResult> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(30_000),
      headers: { "cache-control": "no-cache" },
    });
    const text = await response.text();
    let body: Record<string, any> | null = null;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed;
    } catch {
      // Status and cache evidence remain useful even when the public body is malformed.
    }
    return {
      status: response.status,
      cache: cacheClass(response.headers.get("cache-control")),
      body,
      error: null,
    };
  } catch (error) {
    const code = String((error as { name?: unknown })?.name ?? "FETCH_ERROR")
      .toUpperCase()
      .replace(/[^A-Z0-9_]/g, "_");
    return { status: null, cache: "missing", body: null, error: code };
  }
}

export interface CollectSlotAuditOptions {
  targetSlot: string;
  expectedDeployment: string;
  alias: string;
  envFile: string;
  nodeModules: string;
  inspectedDeploymentId: string | null;
  includeRolling24h?: boolean;
}

export async function collectSlotAudit(options: CollectSlotAuditOptions): Promise<SlotAudit> {
  const { dotenv, Client } = loadExternalModules(options.nodeModules);
  const env = dotenv.parse(fs.readFileSync(options.envFile));
  const supabaseUrl = new URL(env.SUPABASE_URL);
  const ref = supabaseUrl.hostname.split(".")[0];
  if (!/^[a-z0-9]{10,40}$/.test(ref) || !supabaseUrl.hostname.endsWith(".supabase.co")) {
    throw Object.assign(new Error("PROJECT_REF_INVALID"), { code: "PROJECT_REF_INVALID" });
  }

  const from = new Date(options.targetSlot).toISOString();
  const until = new Date(Date.parse(from) + 15 * 60 * 1000).toISOString();
  const { client, strictCert } = await connectReadOnly(env, ref, Client);
  let rolledBack = false;

  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    await client.query("SET LOCAL statement_timeout='12000ms'");
    await client.query("SET LOCAL lock_timeout='1000ms'");
    const readOnly =
      (await client.query("SHOW transaction_read_only")).rows[0]?.transaction_read_only === "on";
    const now = iso((await client.query("select clock_timestamp() as now")).rows[0]?.now);
    if (!now) throw Object.assign(new Error("DATABASE_CLOCK_INVALID"), { code: "DATABASE_CLOCK_INVALID" });

    const cron = (
      await client.query(
        "select runid,status,start_time,end_time from cron.job_run_details where jobid=2 and start_time >= $1::timestamptz and start_time < $2::timestamptz order by start_time",
        [from, until],
      )
    ).rows;
    const net = (
      await client.query(
        "select id,status_code,timed_out,error_msg,created,content from net._http_response where created >= $1::timestamptz and created < $2::timestamptz order by created",
        [from, until],
      )
    ).rows;
    const runs = (
      await client.query(
        "select run_id,scheduled_at,status,started_at,finished_at,selected_source_ids,discovered_count,accepted_count,published_report_id,error_code,run_metrics from daily_news.refresh_run where trigger_kind='cron' and scheduled_at >= $1::timestamptz and scheduled_at < $2::timestamptz order by scheduled_at",
        [from, until],
      )
    ).rows;
    const runIds = runs.map((row) => row.run_id);
    const snapshots = runIds.length
      ? (
          await client.query(
            "select report_id,run_id,published_at,payload->>'storageView' storage_view,payload->>'encoding' encoding,length(payload->>'data') encoded_length from daily_news.report_snapshot where run_id=any($1::uuid[])",
            [runIds],
          )
        ).rows
      : [];
    const runtime = (
      await client.query(
        "select singleton_id,latest_report_id,last_error_code from daily_news.runtime_state",
      )
    ).rows;
    const lease = (
      await client.query(
        "select singleton_id,run_id,lease_expires_at from daily_news.refresh_lease",
      )
    ).rows;
    const sources = (
      await client.query(
        "select source_id,enabled,interval_minutes,last_attempt_at,last_success_at,next_due_at,consecutive_failures,circuit_open_until,last_error_code,last_run_id from daily_news.source_state where enabled order by source_id",
      )
    ).rows;
    const rollingFrom = new Date(Date.parse(from) - 95 * 15 * 60 * 1000).toISOString();
    const rollingCron = options.includeRolling24h
      ? (
          await client.query(
            "select runid,status,start_time,end_time from cron.job_run_details where jobid=2 and start_time >= $1::timestamptz and start_time < $2::timestamptz order by start_time",
            [rollingFrom, until],
          )
        ).rows
      : [];
    const rollingRuns = options.includeRolling24h
      ? (
          await client.query(
            "select run_id,scheduled_at,status,started_at,finished_at,run_metrics from daily_news.refresh_run where trigger_kind='cron' and scheduled_at >= $1::timestamptz and scheduled_at < $2::timestamptz order by scheduled_at",
            [rollingFrom, until],
          )
        ).rows
      : [];

    await client.query("ROLLBACK");
    rolledBack = true;

    const responseRows = net.map((row) => {
      const body = parseBody(row.content);
      return {
        responseId: Number(row.id),
        statusCode: row.status_code == null ? null : Number(row.status_code),
        exact9: exactNineKeys(body),
        networkError: Boolean(row.timed_out || row.error_msg),
        runId: typeof body?.runId === "string" ? body.runId : null,
        reportId: typeof body?.reportId === "string" ? body.reportId : null,
        bodyStatus: typeof body?.status === "string" ? body.status : null,
        selectedSourceCount:
          typeof body?.selectedSourceCount === "number" ? body.selectedSourceCount : null,
        discoveredCount: typeof body?.discoveredCount === "number" ? body.discoveredCount : null,
        candidateCount: typeof body?.candidateCount === "number" ? body.candidateCount : null,
        bodyError: typeof body?.error === "string" ? body.error : null,
      };
    });
    const responseByRun = new Map(
      responseRows.filter((row) => row.runId).map((row) => [row.runId, row]),
    );
    const snapshotByRun = new Map(snapshots.map((row) => [row.run_id, row]));
    const runRows = runs.map((row) => {
      const metrics = (row.run_metrics ?? {}) as Record<string, unknown>;
      const planned = metricIds(metrics, "planned_source_ids");
      const attempted = list(row.selected_source_ids).filter(
        (value): value is string => typeof value === "string",
      );
      const skipped = metricIds(metrics, "skipped_source_ids");
      const missing = metricIds(metrics, "missing_source_outcome_ids");
      const response = responseByRun.get(row.run_id);
      const snapshot = snapshotByRun.get(row.run_id);
      const duration = row.finished_at
        ? Math.round(
            ((new Date(row.finished_at).getTime() - new Date(row.started_at).getTime()) / 1000) *
              1000,
          ) / 1000
        : null;
      return {
        slot: slot(row.scheduled_at),
        runId: row.run_id,
        status: row.status,
        startedAt: iso(row.started_at),
        finishedAt: iso(row.finished_at),
        duration,
        plannedCount: planned.length,
        attemptedCount: attempted.length,
        skippedCount: skipped.length,
        missingCount: missing.length,
        discovered: Number(row.discovered_count),
        accepted: Number(row.accepted_count),
        reportId: row.published_report_id,
        errorCode: row.error_code,
        setMismatch:
          [...attempted, ...skipped].filter((id) => !planned.includes(id)).length +
          planned.filter((id) => !attempted.includes(id) && !skipped.includes(id)).length,
        overlap: attempted.filter((id) => skipped.includes(id)).length,
        responseId: response?.responseId ?? null,
        responseOk: Boolean(
          response &&
            response.statusCode === 200 &&
            response.exact9 &&
            !response.networkError &&
            response.runId === row.run_id,
        ),
        responseReportId: response?.reportId ?? null,
        responseBodyStatus: response?.bodyStatus ?? null,
        bodyCountsMatch: Boolean(
          response &&
            response.selectedSourceCount === attempted.length &&
            response.discoveredCount === Number(row.discovered_count) &&
            response.candidateCount === Number(metrics.candidate_count),
        ),
        snapshotLinked: Boolean(snapshot && snapshot.report_id === row.published_report_id),
        storageView: snapshot?.storage_view ?? null,
        encoding: snapshot?.encoding ?? null,
        encodedLength: Number(snapshot?.encoded_length ?? 0),
      };
    });

    const latest = runs.at(-1);
    const current = runRows.at(-1);
    const latestId = latest?.run_id ?? null;
    const bySource = new Map(sources.map((row) => [row.source_id, row]));
    const nowTime = Date.parse(now);
    const open = sources.filter(
      (row) => row.circuit_open_until && Date.parse(row.circuit_open_until) > nowTime,
    );
    const healthy = sources.filter(
      (row) => !row.circuit_open_until || Date.parse(row.circuit_open_until) <= nowTime,
    );
    const halfOpen = sources.filter(
      (row) =>
        row.circuit_open_until &&
        Date.parse(row.circuit_open_until) <= nowTime &&
        Date.parse(row.next_due_at) <= nowTime,
    );
    const rollingAttempted = healthy.filter(
      (row) => row.last_attempt_at && nowTime - Date.parse(row.last_attempt_at) <= 5_400_000,
    );
    const rollingSucceeded = healthy.filter(
      (row) => row.last_success_at && nowTime - Date.parse(row.last_success_at) <= 5_400_000,
    );
    const overdue = healthy.filter(
      (row) =>
        !row.last_attempt_at ||
        nowTime - Date.parse(row.last_attempt_at) > Number(row.interval_minutes) * 60_000,
    );
    const backlog = healthy.filter((row) => Date.parse(row.next_due_at) <= nowTime);
    const anthropic = bySource.get("anthropic");

    const cacheWindow = Math.floor(Date.now() / 30_000);
    const [health, full, compact, reload, invalid] = await Promise.all([
      fetchJson(`${options.alias}/api/health`),
      fetchJson(`${options.alias}/api/news`),
      fetchJson(`${options.alias}/api/news?view=web&window=${cacheWindow}`),
      fetchJson(`${options.alias}/api/news?view=web&reload=1`),
      fetchJson(`${options.alias}/api/news?view=web&window=0002`),
    ]);
    const report = full.body ?? {};
    const stories = list(report.stories) as Array<Record<string, any>>;
    const top = list(report.topStories) as Array<Record<string, any>>;
    const important = list(report.importantStories) as Array<Record<string, any>>;
    const watch = list(report.watchlist) as Array<Record<string, any>>;
    const homepage = [...top, ...important, ...watch];
    const candidateLatest = maxIso(
      (list(report.items) as Array<Record<string, any>>)
        .map((item) => item?.publishedAt)
        .filter(Boolean),
    );
    const homepageLatest = maxIso(
      homepage
        .flatMap((story) => [
          story?.publishedAt,
          story?.updatedAt,
          ...(list(story?.evidence) as Array<Record<string, any>>).map(
            (evidence) => evidence?.publishedAt,
          ),
        ])
        .filter(Boolean),
    );
    const core = [...top, ...important];
    const publisherCounts = new Map<string, number>();
    for (const story of core) {
      const publisher = story?.evidence?.[0]?.sourceId ?? "unknown";
      publisherCounts.set(publisher, (publisherCounts.get(publisher) ?? 0) + 1);
    }
    const share = core.length ? Math.max(...publisherCounts.values()) / core.length : 0;
    const reportIds = [
      reportId(health.body),
      reportId(full.body),
      reportId(compact.body),
      reportId(reload.body),
    ];
    const cronSlots = cron.map((row) => slot(row.start_time));
    const runSlots = runRows.map((row) => row.slot);
    const expectedRollingSlots = options.includeRolling24h
      ? Array.from({ length: 96 }, (_, index) =>
          new Date(Date.parse(rollingFrom) + index * 15 * 60 * 1000).toISOString(),
        )
      : [];
    const rollingCronSlots = rollingCron.map((row) => slot(row.start_time));
    const rollingRunSlots = rollingRuns.map((row) => slot(row.scheduled_at));
    const rollingDurations = rollingRuns
      .filter((row) => row.started_at && row.finished_at)
      .map(
        (row) =>
          Math.round(
            ((Date.parse(row.finished_at) - Date.parse(row.started_at)) / 1000) * 1000,
          ) / 1000,
      );
    const rollingSuccessfulFinishes = rollingRuns
      .filter((row) => ["published", "completed"].includes(row.status) && row.finished_at)
      .map((row) => Date.parse(row.finished_at))
      .sort((left, right) => left - right);
    const rollingGaps = rollingSuccessfulFinishes
      .slice(1)
      .map(
        (finishedAt, index) =>
          Math.round(((finishedAt - rollingSuccessfulFinishes[index]) / 60_000) * 1000) /
          1000,
      );

    return {
      targetSlot: from,
      security: {
        readOnly,
        tlsEncrypted: client.connection?.stream?.encrypted === true,
        strictCert,
        rolledBack,
      },
      deployment: {
        expected: options.expectedDeployment,
        aliasExact: options.inspectedDeploymentId === options.expectedDeployment,
      },
      auditAt: now,
      schedule: {
        expectedSlots: 1,
        cron: cron.length,
        durable: runRows.length,
        missingCron: cronSlots.includes(from) ? [] : [from],
        missingDurable: runSlots.includes(from) ? [] : [from],
        duplicateCron: cronSlots.length - new Set(cronSlots).size,
        duplicateDurable: runSlots.length - new Set(runSlots).size,
      },
      cron: cron.map((row) => ({
        runId: Number(row.runid),
        slot: slot(row.start_time),
        status: row.status,
        startedAt: iso(row.start_time),
        finishedAt: iso(row.end_time),
      })),
      pgNet: {
        rows: responseRows,
        http200: responseRows.filter((row) => row.statusCode === 200).length,
        exact9: responseRows.filter((row) => row.exact9).length,
        networkErrors: responseRows.filter((row) => row.networkError).length,
      },
      durable: runRows,
      atomic: {
        runtimeSingleton: runtime.length,
        leaseSingleton: lease.length,
        latestReportId: runtime[0]?.latest_report_id ?? null,
        latestRunId: latestId,
        latestPublishedReportId: latest?.published_report_id ?? null,
        runtimeMatches: Boolean(
          latest?.published_report_id &&
            runtime[0]?.latest_report_id === latest.published_report_id,
        ),
        latestSnapshotLinked: current?.snapshotLinked ?? false,
        leaseReleased:
          lease.length === 1 &&
          lease[0]?.run_id == null &&
          lease[0]?.lease_expires_at == null,
        lastErrorCode: runtime[0]?.last_error_code ?? null,
      },
      sources: {
        enabled: sources.length,
        healthy: healthy.length,
        circuitOpen: open.length,
        halfOpenDue: halfOpen.length,
        rollingAttempted: rollingAttempted.length,
        rollingSucceeded: rollingSucceeded.length,
        overdue: overdue.length,
        backlog: backlog.length,
        currentAttemptMismatch: current
          ? runs
              .at(-1)
              ?.selected_source_ids.filter(
                (id: string) => bySource.get(id)?.last_run_id !== latestId,
              ).length ?? null
          : null,
        currentSkippedAdvanced: current
          ? metricIds((runs.at(-1)?.run_metrics ?? {}) as Record<string, unknown>, "skipped_source_ids")
              .filter((id) => bySource.get(id)?.last_run_id === latestId).length
          : null,
        anthropic: anthropic
          ? {
              planned: Boolean(
                current &&
                  metricIds(
                    (runs.at(-1)?.run_metrics ?? {}) as Record<string, unknown>,
                    "planned_source_ids",
                  ).includes("anthropic"),
              ),
              attempted: Boolean(
                current && list(runs.at(-1)?.selected_source_ids).includes("anthropic"),
              ),
              skipped: Boolean(
                current &&
                  metricIds(
                    (runs.at(-1)?.run_metrics ?? {}) as Record<string, unknown>,
                    "skipped_source_ids",
                  ).includes("anthropic"),
              ),
              lastAttemptAt: iso(anthropic.last_attempt_at),
              lastSuccessAt: iso(anthropic.last_success_at),
              nextDueAt: iso(anthropic.next_due_at),
              failures: Number(anthropic.consecutive_failures),
              circuitOpenUntil: iso(anthropic.circuit_open_until),
              lastErrorCode: anthropic.last_error_code,
            }
          : null,
      },
      public: {
        errors: {
          health: health.error,
          full: full.error,
          compact: compact.error,
          reload: reload.error,
          invalid: invalid.error,
        },
        statuses: {
          health: health.status,
          full: full.status,
          compact: compact.status,
          reload: reload.status,
          invalid: invalid.status,
        },
        cache: {
          health: health.cache,
          full: full.cache,
          compact: compact.cache,
          reload: reload.cache,
          invalid: invalid.cache,
        },
        storage: health.body?.storage ?? null,
        healthError: health.body?.lastError ?? health.body?.error ?? null,
        reportIds,
        atomicReport: reportIds.every((id) => id && id === reportIds[0]),
        counts: {
          full: stories.length,
          compact: list(compact.body?.stories).length,
          reload: list(reload.body?.stories).length,
        },
        candidateLatest,
        candidateAge: ageMinutes(now, candidateLatest),
        homepageLatest,
        homepageAge: ageMinutes(now, homepageLatest),
        duplicates: {
          title: duplicates(stories.map((story) => story?.title)),
          summary: duplicates(stories.map((story) => story?.whatHappened)),
          combination: duplicates(
            stories.map((story) => `${story?.title ?? ""}\u0000${story?.whatHappened ?? ""}`),
          ),
          tier:
            homepage.length -
            new Set(homepage.map((story) => story?.id).filter(Boolean)).size,
        },
        tiers: {
          top: top.length,
          important: important.length,
          watch: watch.length,
        },
        core: {
          count: core.length,
          confirmed: core.filter((story) => story?.status === "confirmed").length,
        },
        publisherShare: Math.round(share * 1000) / 1000,
        declaredPublisherShare: report.quality?.maxPrimaryPublisherShare ?? null,
        sourceCount: report.coverage?.sourceCount ?? report.sourceCount ?? null,
        beats: {
          covered: report.coverage?.coveredBeatCount ?? null,
          total: report.coverage?.totalBeatCount ?? null,
        },
      },
      rolling24h: options.includeRolling24h
        ? {
            expectedSlots: expectedRollingSlots.length,
            cron: rollingCron.length,
            cronSucceeded: rollingCron.filter((row) => row.status === "succeeded").length,
            durable: rollingRuns.length,
            durableSucceeded: rollingRuns.filter((row) =>
              ["published", "completed"].includes(row.status),
            ).length,
            durableFailed: rollingRuns.filter((row) => row.status === "failed").length,
            durableRunning: rollingRuns.filter((row) => row.status === "running").length,
            missingCron: expectedRollingSlots.filter(
              (expected) => !rollingCronSlots.includes(expected),
            ).length,
            missingDurable: expectedRollingSlots.filter(
              (expected) => !rollingRunSlots.includes(expected),
            ).length,
            duplicateCron: rollingCronSlots.length - new Set(rollingCronSlots).size,
            duplicateDurable: rollingRunSlots.length - new Set(rollingRunSlots).size,
            skippedSources: rollingRuns.reduce(
              (sum, row) =>
                sum +
                metricIds(
                  (row.run_metrics ?? {}) as Record<string, unknown>,
                  "skipped_source_ids",
                ).length,
              0,
            ),
            missingSourceOutcomes: rollingRuns.reduce(
              (sum, row) =>
                sum +
                metricIds(
                  (row.run_metrics ?? {}) as Record<string, unknown>,
                  "missing_source_outcome_ids",
                ).length,
              0,
            ),
            durationP95: percentile(rollingDurations, 0.95),
            durationMax: rollingDurations.length ? Math.max(...rollingDurations) : null,
            over30Seconds: rollingDurations.filter((duration) => duration > 30).length,
            maxSuccessfulGapMinutes: rollingGaps.length ? Math.max(...rollingGaps) : null,
          }
        : null,
    };
  } finally {
    if (!rolledBack) await client.query("ROLLBACK").catch(() => {});
    await client.end().catch(() => {});
  }
}
