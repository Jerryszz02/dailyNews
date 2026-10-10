/** Persisted admission and execution boundary for the local P5 bounded trial. */
import { sql, type Db } from "../db.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { credential } from "../config.ts";

const MODEL_ENV = [
  "LLM_MODEL", "LLM_BASE_URL", "LLM_EXTRA_JSON", "LLM_JSON_MODE", "LLM_VISION",
  "DEEPSEEK_BASE_URL", "ZHIPU_BASE_URL", "DASHSCOPE_BASE_URL", "XIAOMI_MIMO_BASE_URL",
  "PREFILTER_MODEL", "SCORE_MODEL", "UNDERSTAND_MODEL", "SUMMARIZE_MODEL", "STRUCTURE_MODEL",
  "GROUP_MODEL", "GROUP_REVIEW_MODEL", "DIGEST_MODEL", "REPORT_MODEL", "TRANSLATE_MODEL",
  "EMBEDDING_MODEL", "EMBEDDING_BASE_URL", "EMBEDDING_DIMS",
  "DAILYNEWS_DEEPSEEK_PRICE_BAND", "DAILYNEWS_DEEPSEEK_PRICE_VALID_FROM", "DAILYNEWS_DEEPSEEK_PRICE_VALID_UNTIL",
] as const;

export class TrialBoundaryError extends Error {
  constructor(message: string) { super(`Daily News trial: ${message}`); this.name = "TrialBoundaryError"; }
}

export function boundedTrialEnabled(): boolean {
  const mode = process.env.DAILYNEWS_TRIAL_MODE;
  if (!mode && !process.env.DAILYNEWS_TRIAL_ID && !process.env.DAILYNEWS_TRIAL_SETTINGS_HASH &&
    !process.env.DAILYNEWS_TRIAL_DB_NAME) return false;
  if (mode !== "bounded") throw new TrialBoundaryError("DAILYNEWS_TRIAL_MODE must be bounded");
  return true;
}

function runtimeConfig(): { id: string; expectedHash: string; databaseName: string } | null {
  if (!boundedTrialEnabled()) return null;
  const id = process.env.DAILYNEWS_TRIAL_ID;
  const expectedHash = process.env.DAILYNEWS_TRIAL_SETTINGS_HASH;
  const databaseName = process.env.DAILYNEWS_TRIAL_DB_NAME;
  if (!id || !expectedHash || !databaseName) throw new TrialBoundaryError("trial ID, settings hash and dedicated DB name are required");
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id) || !/^[0-9a-f]{64}$/.test(expectedHash)) throw new TrialBoundaryError("invalid trial ID or settings hash");
  return { id, expectedHash, databaseName };
}

type Source = { id: string; kind: string; tier: string; participation_mode: string; config: unknown;
  site_fulltext: boolean; syndicate_fulltext: boolean; enabled: boolean };
function sourceHash(source: Source): string {
  return sha256(stableJson({ id: source.id, kind: source.kind, tier: source.tier,
    participationMode: source.participation_mode, config: source.config, siteFulltext: source.site_fulltext,
    syndicateFulltext: source.syndicate_fulltext, enabled: source.enabled }));
}

/** Hash only public runtime configuration; credentials are never copied to the cohort ledger. */
export async function currentTrialSettingsHash(db: Db = sql): Promise<string> {
  const models = await db<{ key: string; value: unknown }[]>`SELECT key,value FROM settings WHERE key LIKE 'models.%' ORDER BY key`;
  const budgets = await db<{ service: string; per_minute: number; per_hour: number; per_day: number }[]>`
    SELECT service,per_minute,per_hour,per_day FROM budgets ORDER BY service`;
  const env = Object.fromEntries(MODEL_ENV.map((key) => [key, process.env[key] ?? null]));
  const [{ MODELS }, { CAPABILITIES }] = await Promise.all([
    import("../providers/llm.ts"), import("../editorial/models.ts"),
  ]);
  const actualModels = Object.fromEntries(Object.entries(MODELS).map(([key, spec]) => [key, {
    service: spec.service, model: spec.model, baseUrl: credential("models", spec.baseUrlEnv) ?? null,
    extra: spec.extra ?? null, jsonMode: spec.jsonMode, vision: !!spec.vision,
    credentialPresent: !!credential("models", spec.apiKeyEnv),
  }]));
  return sha256(stableJson({ modelSettings: models, capabilities: CAPABILITIES, actualModels, budgets, env }));
}

type Trial = { id: string; status: "open" | "frozen" | "closed"; normal_limit: number; backfill_limit: number;
  manifest_hash: string; settings_hash: string; created_at: Date };

async function verifyDatabase(db: Db, expected: string): Promise<void> {
  const [row] = await db<{ name: string }[]>`SELECT current_database() AS name`;
  if (row?.name !== expected) throw new TrialBoundaryError(`database mismatch: expected ${expected}`);
}

async function manifestHash(trialId: string, db: Db): Promise<string> {
  const rows = await db<Array<Source & { source_config_hash: string }>>`
    SELECT s.id,s.kind,s.tier,s.participation_mode,s.config,s.site_fulltext,s.syndicate_fulltext,s.enabled,
      ts.source_config_hash
    FROM dailynews_trial_sources ts JOIN sources s ON s.id=ts.source_id WHERE ts.trial_id=${trialId} ORDER BY s.id`;
  if (rows.length < 10 || rows.length > 15) throw new TrialBoundaryError("source manifest is incomplete");
  for (const row of rows) if (row.source_config_hash !== sourceHash(row)) {
    throw new TrialBoundaryError(`source configuration changed: ${row.id}`);
  }
  return sha256(stableJson(rows.map((r) => [r.id, r.source_config_hash])));
}

/** This check is deliberately uncached: changes to budget, model settings or sources stop the next call. */
export async function assertTrialRuntime(db: Db = sql): Promise<Trial | null> {
  const runtime = runtimeConfig();
  if (!runtime) {
    // An isolated trial database may be restarted with env settings omitted. It must not
    // silently become an unrestricted production worker in that state.
    const [existing] = await db`SELECT 1 FROM dailynews_trials LIMIT 1`;
    if (existing) throw new TrialBoundaryError("trial database requires explicit runtime settings, even after close");
    return null;
  }
  await verifyDatabase(db, runtime.databaseName);
  const [trial] = await db<Trial[]>`SELECT id,status,normal_limit,backfill_limit,manifest_hash,settings_hash,created_at
    FROM dailynews_trials WHERE id=${runtime.id}`;
  if (!trial || trial.status === "closed") throw new TrialBoundaryError("trial is missing or closed");
  if (trial.settings_hash !== runtime.expectedHash || await currentTrialSettingsHash(db) !== trial.settings_hash) {
    throw new TrialBoundaryError("runtime settings changed from the frozen snapshot");
  }
  if (await manifestHash(trial.id, db) !== trial.manifest_hash) throw new TrialBoundaryError("source manifest changed");
  const boundedBudgets = await db<{ service: string; per_minute: number; per_hour: number; per_day: number }[]>`
    SELECT service,per_minute,per_hour,per_day FROM budgets WHERE service IN ('deepseek','llm-global')`;
  if (boundedBudgets.length !== 2 || boundedBudgets.some((budget) => budget.per_minute <= 0 ||
    budget.per_hour <= 0 || budget.per_day <= 0 || budget.per_minute > 20 ||
    budget.per_hour > 200 || budget.per_day > 1000)) {
    throw new TrialBoundaryError("explicit DeepSeek and global LLM budgets must be within 20/min, 200/hour, 1000/day");
  }
  const band = process.env.DAILYNEWS_DEEPSEEK_PRICE_BAND;
  const priceFrom = process.env.DAILYNEWS_DEEPSEEK_PRICE_VALID_FROM;
  const priceUntil = process.env.DAILYNEWS_DEEPSEEK_PRICE_VALID_UNTIL;
  const timestamp = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/;
  if ((band !== "peak" && band !== "off_peak") || !priceFrom || !priceUntil ||
    !timestamp.test(priceFrom) || !timestamp.test(priceUntil) ||
    !Number.isFinite(Date.parse(priceFrom)) || !Number.isFinite(Date.parse(priceUntil)) ||
    Date.now() < Date.parse(priceFrom) || Date.now() >= Date.parse(priceUntil)) {
    throw new TrialBoundaryError("operator-pinned DeepSeek price window is missing or expired");
  }
  const [{ MODELS }, { CAPABILITIES }] = await Promise.all([
    import("../providers/llm.ts"), import("../editorial/models.ts"),
  ]);
  const overrides = await db<{ key: string; value: { model?: string } }[]>`
    SELECT key,value FROM settings WHERE key LIKE 'models.%'`;
  const chosen = new Map(overrides.map((r) => [r.key.slice("models.".length), r.value?.model]));
  const services = new Set<string>();
  for (const key of ["structure", "prefilter", "score", "understand", "summarize", "group", "groupReview", "digest", "report"] as const) {
    const cap = CAPABILITIES[key];
    const model = chosen.get(key) ?? process.env[cap.env] ?? cap.default;
    const spec = MODELS[model] ?? MODELS[cap.default]!;
    const base = credential("models", spec.baseUrlEnv);
    let official = false;
    try {
      if (base) {
        const url = new URL(base);
        official = url.origin === "https://api.deepseek.com" && !url.username && !url.password;
      }
    } catch { /* malformed base URL is not an authorized trial provider */ }
    if (!official || !credential("models", spec.apiKeyEnv) ||
      !["llm", "deepseek"].includes(spec.service) || spec.model !== "deepseek-flash") {
      throw new TrialBoundaryError(`text capability ${key} must use the verified official DeepSeek Flash endpoint`);
    }
    services.add(spec.service);
  }
  const rows = await db<{ service: string; per_minute: number; per_hour: number; per_day: number }[]>`
    SELECT service,per_minute,per_hour,per_day FROM budgets WHERE service IN ${db([...services])}`;
  if (rows.length !== services.size || rows.some((r) => r.per_minute <= 0 || r.per_hour <= 0 || r.per_day <= 0)) {
    throw new TrialBoundaryError("every selected model service requires an explicit positive budget");
  }
  return trial;
}

async function transactional<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  return db === sql ? sql.begin(async (tx) => fn(tx)) as Promise<T> : fn(db);
}

/** Creates one fixed 10–15-source manifest. This never admits or processes an article. */
export async function createTrial(input: { id: string; sourceIds: string[]; normalLimit?: number; backfillLimit?: number }, db: Db = sql) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(input.id)) throw new TrialBoundaryError("invalid trial ID");
  const ids = [...new Set(input.sourceIds)].sort();
  if (ids.length < 10 || ids.length > 15 || ids.length !== input.sourceIds.length) throw new TrialBoundaryError("manifest must contain 10–15 distinct sources");
  const normalLimit = input.normalLimit ?? 100;
  const backfillLimit = input.backfillLimit ?? 20;
  if (!Number.isInteger(normalLimit) || normalLimit < 1 || normalLimit > 100 ||
    !Number.isInteger(backfillLimit) || backfillLimit < 0 || backfillLimit > 20) throw new TrialBoundaryError("invalid cohort limits");
  return transactional(db, async (tx) => {
    const namedDb = process.env.DAILYNEWS_TRIAL_DB_NAME;
    if (!namedDb) throw new TrialBoundaryError("dedicated DB name is required before trial creation");
    await verifyDatabase(tx, namedDb);
    const sources = await tx<Source[]>`
      SELECT id,kind,tier,participation_mode,config,site_fulltext,syndicate_fulltext,enabled
      FROM sources WHERE id IN ${tx(ids)} ORDER BY id`;
    if (sources.length !== ids.length || sources.some((s) => !s.enabled ||
      (s.config as { dailyNews?: { migrationStatus?: string } } | null)?.dailyNews?.migrationStatus !== "verified")) {
      throw new TrialBoundaryError("source manifest includes missing, disabled or unverified source");
    }
    const entries = sources.map((s) => [s.id, sourceHash(s)] as const);
    const manifest = sha256(stableJson(entries));
    const settings = await currentTrialSettingsHash(tx);
    await tx`INSERT INTO dailynews_trials (id,normal_limit,backfill_limit,manifest_hash,settings_hash)
      VALUES (${input.id},${normalLimit},${backfillLimit},${manifest},${settings})`;
    for (const [sourceId, configHash] of entries) await tx`
      INSERT INTO dailynews_trial_sources (trial_id,source_id,source_config_hash)
      VALUES (${input.id},${sourceId},${configHash})`;
    return { id: input.id, status: "open" as const, sourceIds: ids, normalLimit, backfillLimit,
      manifestHash: manifest, settingsHash: settings };
  });
}

/** First real collection freezes the baseline; the value never moves on subsequent fetches. */
export async function beginTrialSource(sourceId: string, db: Db = sql): Promise<Date | null> {
  const trial = await assertTrialRuntime(db);
  if (!trial) return null;
  return transactional(db, async (tx) => {
    const [locked] = await tx<{ status: Trial["status"] }[]>`
      SELECT status FROM dailynews_trials WHERE id=${trial.id} FOR UPDATE`;
    if (locked?.status !== "open") throw new TrialBoundaryError("collection is closed after trial freeze");
    const [row] = await tx<{ initialized_at: Date | null; cursor: { initializedAt?: string } | null }[]>`
      SELECT ts.initialized_at,s.cursor FROM dailynews_trial_sources ts JOIN sources s ON s.id=ts.source_id
      WHERE ts.trial_id=${trial.id} AND ts.source_id=${sourceId} FOR UPDATE OF ts`;
    if (!row) throw new TrialBoundaryError(`source is outside trial manifest: ${sourceId}`);
    if (row.initialized_at) return row.initialized_at;
    const cursorTime = row.cursor?.initializedAt;
    const fromCursor = cursorTime ? new Date(cursorTime) : null;
    if (fromCursor && !Number.isFinite(fromCursor.getTime())) throw new TrialBoundaryError("invalid source cursor initializedAt");
    const [updated] = await tx<{ initialized_at: Date }[]>`
      UPDATE dailynews_trial_sources SET initialized_at=coalesce(${fromCursor},now())
      WHERE trial_id=${trial.id} AND source_id=${sourceId} AND initialized_at IS NULL RETURNING initialized_at`;
    return updated!.initialized_at;
  });
}

export type Admission = { admitted: boolean; reason: "admitted" | "already-admitted" | "closed" | "outside-manifest" | "not-new" | "not-backfill" | "no-baseline" | "quota" | "missing" };

/** Row-level lock makes concurrent normal/backfill admissions obey their separate lifetime quotas. */
export async function admitArticle(articleId: string, opts: { lane: "normal" | "backfill" }, db: Db = sql): Promise<Admission> {
  const trial = await assertTrialRuntime(db);
  if (!trial) throw new TrialBoundaryError("admission requires bounded trial mode");
  return transactional(db, async (tx) => {
    const [locked] = await tx<Trial[]>`SELECT id,status,normal_limit,backfill_limit,manifest_hash,settings_hash,created_at
      FROM dailynews_trials WHERE id=${trial.id} FOR UPDATE`;
    if (locked?.status !== "open") return { admitted: false, reason: "closed" };
    const [existing] = await tx<{ trial_id: string }[]>`SELECT trial_id FROM dailynews_trial_articles WHERE article_id=${articleId}`;
    if (existing) return existing.trial_id === trial.id ? { admitted: true, reason: "already-admitted" }
      : { admitted: false, reason: "outside-manifest" };
    const [article] = await tx<{ source_id: string; backfill: boolean; published_at: Date | null; revision: number; created_at: Date;
      initialized_at: Date | null }[]>`
      SELECT a.source_id,a.backfill,a.published_at,a.revision,a.created_at,ts.initialized_at FROM articles a
      LEFT JOIN dailynews_trial_sources ts ON ts.source_id=a.source_id AND ts.trial_id=${trial.id}
      WHERE a.id=${articleId}`;
    if (!article) return { admitted: false, reason: "missing" };
    const [source] = await tx`SELECT 1 FROM dailynews_trial_sources WHERE trial_id=${trial.id} AND source_id=${article.source_id}`;
    if (!source) return { admitted: false, reason: "outside-manifest" };
    if (!article.initialized_at) return { admitted: false, reason: "no-baseline" };
    if (opts.lane === "normal") {
      if (article.backfill || !article.published_at || article.created_at < locked.created_at) return { admitted: false, reason: "not-new" };
      if (article.published_at <= article.initialized_at) return { admitted: false, reason: "not-new" };
    } else if (!article.backfill) return { admitted: false, reason: "not-backfill" };
    const [used] = await tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM dailynews_trial_articles WHERE trial_id=${trial.id} AND lane=${opts.lane}`;
    if (used!.n >= (opts.lane === "normal" ? locked.normal_limit : locked.backfill_limit)) return { admitted: false, reason: "quota" };
    await tx`INSERT INTO dailynews_trial_articles
      (trial_id,article_id,source_id,lane,revision_at_admission,published_at_at_admission)
      VALUES (${trial.id},${articleId},${article.source_id},${opts.lane},${article.revision},${article.published_at})`;
    return { admitted: true, reason: "admitted" };
  });
}

export async function freezeTrial(id: string, db: Db = sql): Promise<void> {
  await terminalControl(id, db);
  const [row] = await db`UPDATE dailynews_trials SET status='frozen',frozen_at=coalesce(frozen_at,now())
    WHERE id=${id} AND status='open' RETURNING id`;
  if (!row) {
    const [existing] = await db<{ status: string }[]>`SELECT status FROM dailynews_trials WHERE id=${id}`;
    if (existing?.status !== "frozen") throw new TrialBoundaryError("cannot freeze missing or closed trial");
  }
}

export async function closeTrial(id: string, db: Db = sql): Promise<void> {
  await terminalControl(id, db);
  const [row] = await db`UPDATE dailynews_trials SET status='closed',closed_at=coalesce(closed_at,now())
    WHERE id=${id} AND status<>'closed' RETURNING id`;
  if (!row) {
    const [existing] = await db`SELECT 1 FROM dailynews_trials WHERE id=${id} AND status='closed'`;
    if (!existing) throw new TrialBoundaryError("cannot close missing trial");
  }
}

/** Stopping spend must remain possible when the price window or budget has failed. */
async function terminalControl(id: string, db: Db): Promise<void> {
  const name = process.env.DAILYNEWS_TRIAL_DB_NAME;
  if (!name) throw new TrialBoundaryError("dedicated DB name is required to stop a trial");
  await verifyDatabase(db, name);
  if (process.env.DAILYNEWS_TRIAL_ID && process.env.DAILYNEWS_TRIAL_ID !== id) {
    throw new TrialBoundaryError("trial ID mismatch on terminal control");
  }
  const [row] = await db`SELECT 1 FROM dailynews_trials WHERE id=${id}`;
  if (!row) throw new TrialBoundaryError("trial not found");
}

/** A restart returns exactly the persisted IDs. The caller may requeue these, never add replacements. */
export async function resumeTrial(id: string, db: Db = sql): Promise<string[]> {
  const trial = await assertTrialRuntime(db);
  if (!trial || trial.id !== id) throw new TrialBoundaryError("trial mismatch on resume");
  const rows = await db<{ article_id: string }[]>`
    SELECT article_id FROM dailynews_trial_articles WHERE trial_id=${id} ORDER BY admitted_at,article_id`;
  return rows.map((r) => r.article_id);
}

export async function trialArticleAllowed(articleId: string, db: Db = sql): Promise<boolean> {
  const trial = await assertTrialRuntime(db);
  if (!trial) return true;
  const [row] = await db`SELECT 1 FROM dailynews_trial_articles WHERE trial_id=${trial.id} AND article_id=${articleId}`;
  return !!row;
}

export async function trialSourceAllowed(sourceId: string, db: Db = sql): Promise<boolean> {
  const trial = await assertTrialRuntime(db);
  if (!trial) return true;
  const [row] = await db`SELECT 1 FROM dailynews_trial_sources WHERE trial_id=${trial.id} AND source_id=${sourceId}`;
  return !!row;
}

async function relatedArticlesAllowed(kind: "fact" | "story", id: number, db: Db): Promise<boolean> {
  const trial = await assertTrialRuntime(db);
  if (!trial) return true;
  const [row] = await db<{ total: number; admitted: number }[]>`
    SELECT count(DISTINCT fa.article_id)::int AS total,
      count(DISTINCT ta.article_id)::int AS admitted
    FROM facts f JOIN fact_articles fa ON fa.fact_id=f.id
    LEFT JOIN dailynews_trial_articles ta ON ta.article_id=fa.article_id AND ta.trial_id=${trial.id}
    WHERE (${kind}='fact' AND f.id=${id}) OR (${kind}='story' AND f.story_id=${id})`;
  return !!row && row.total > 0 && row.total === row.admitted;
}

export async function trialStoryAllowed(storyId: number, db: Db = sql): Promise<boolean> {
  return relatedArticlesAllowed("story", storyId, db);
}

export async function trialEmbeddingItemAllowed(kind: "article" | "fact" | "story", id: string, db: Db = sql): Promise<boolean> {
  if (kind === "article") return trialArticleAllowed(id, db);
  const number = Number(id);
  return Number.isSafeInteger(number) && number > 0 && await relatedArticlesAllowed(kind, number, db);
}

/** Queue admission is checked again by handlers, because old jobs can survive a restart. */
export async function trialQueueAllowed(name: string, data: unknown, db: Db = sql): Promise<boolean> {
  const trial = await assertTrialRuntime(db);
  if (!trial) return true;
  const value = data as { articleId?: unknown; storyId?: unknown; sourceId?: unknown; batchId?: unknown; itemId?: unknown };
  if (["content.analyze", "content.extract-body", "events.group"].includes(name)) {
    return typeof value?.articleId === "string" && await trialArticleAllowed(value.articleId, db);
  }
  if (name === "events.digest") return typeof value?.storyId === "number" && await trialStoryAllowed(value.storyId, db);
  if (name === "sources.fetch") return trial.status === "open" && typeof value?.sourceId === "string" &&
    await trialSourceAllowed(value.sourceId, db);
  if (name === "collection.store" || name === "collection.detail") {
    if (trial.status !== "open") return false;
    const id = name === "collection.store" ? value?.batchId : value?.itemId;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) return false;
    const [row] = name === "collection.store"
      ? await db<{ source_id: string }[]>`SELECT i.source_id FROM collection_intakes i
          JOIN collection_batches b ON b.run_id=i.run_id WHERE b.id=${id} AND i.trial_id=${trial.id}`
      : await db<{ source_id: string }[]>`SELECT i.source_id FROM collection_intakes i
          JOIN collection_batches b ON b.run_id=i.run_id JOIN collection_items c ON c.batch_id=b.id
          WHERE c.id=${id} AND i.trial_id=${trial.id}`;
    return !!row && await trialSourceAllowed(row.source_id, db);
  }
  // No automatic X shards, MP account polling, translation, media, notification or republishing.
  return false;
}

export async function admitTrialReportKey(kind: "daily" | "weekly" | "monthly", key: string, db: Db = sql): Promise<void> {
  const trial = await assertTrialRuntime(db);
  if (!trial) throw new TrialBoundaryError("explicit report requires bounded trial mode");
  await transactional(db, async (tx) => {
    const [locked] = await tx<{ status: Trial["status"] }[]>`SELECT status FROM dailynews_trials WHERE id=${trial.id} FOR UPDATE`;
    if (locked?.status !== "open") throw new TrialBoundaryError("explicit report requires open trial");
    await tx`INSERT INTO dailynews_trial_reports (trial_id,kind,report_key) VALUES (${trial.id},${kind},${key}) ON CONFLICT DO NOTHING`;
  });
}

/** Called before receipt reuse and before every paid provider call. Unknown subjects fail closed. */
export async function assertTrialPaidSubject(purpose: string, subject: string, db: Db = sql,
  paid?: { service: string; model?: string | null; resourceKind?: "llm"; providerBaseUrl?: string | null }): Promise<void> {
  const trial = await assertTrialRuntime(db);
  if (!trial) return;
  if (!subject) throw new TrialBoundaryError(`missing paid subject for ${purpose}`);
  const llmPurposes = new Set(["prefilter_article", "score_article", "understand_article", "summarize_article",
    "summarize_non_ai_article", "structure_article", "group_article", "group_review", "group_signal",
    "group_story", "group_story_review", "story_digest", "report_lead", "report_daily", "report_weekly",
    "report_monthly", "translate_body", "translate_quoted"]);
  let officialRequest = false;
  try {
    if (paid?.providerBaseUrl) {
      const url = new URL(paid.providerBaseUrl);
      officialRequest = url.origin === "https://api.deepseek.com" && !url.username && !url.password;
    }
  } catch { /* malformed provider URL is not authorized */ }
  if (llmPurposes.has(purpose) && (paid?.resourceKind !== "llm" ||
    !["llm", "deepseek"].includes(paid.service) || paid.model !== "deepseek-flash" || !officialRequest)) {
    throw new TrialBoundaryError(`unverified model for ${purpose}`);
  }
  let allowed = false;
  const article = /^article:([a-zA-Z0-9_-]{1,80})(?:$|[@:#])/.exec(subject)?.[1];
  const source = /^source:([a-zA-Z0-9_-]{1,80})$/.exec(subject)?.[1];
  const story = /^story:(\d+)(?:@\d+)?$/.exec(subject)?.[1];
  const storyPair = /^story:(\d+):(\d+)$/.exec(subject);
  const report = /^report:(daily|weekly|monthly):([a-zA-Z0-9_-]+)$/.exec(subject);
  const articlePurposes = new Set(["prefilter_article", "score_article", "understand_article", "summarize_article",
    "summarize_non_ai_article", "structure_article", "group_article", "group_review", "group_signal",
    "body_fallback", "x_article", "translate_body"]);
  if (article && (articlePurposes.has(purpose) || purpose === "embedding")) allowed = await trialArticleAllowed(article, db);
  else if (purpose === "embedding" && /^fact:\d+$/.test(subject)) allowed = await relatedArticlesAllowed("fact", Number(subject.slice(5)), db);
  else if (purpose === "embedding" && story) allowed = await trialStoryAllowed(Number(story), db);
  else if (story && purpose === "story_digest") allowed = await trialStoryAllowed(Number(story), db);
  else if (storyPair && (purpose === "group_story" || purpose === "group_story_review")) {
    allowed = await trialStoryAllowed(Number(storyPair[1]), db) && await trialStoryAllowed(Number(storyPair[2]), db);
  } else if (report && (purpose === `report_${report[1]}` || purpose === "report_lead")) {
    const [row] = await db`SELECT 1 FROM dailynews_trial_reports WHERE trial_id=${trial.id} AND kind=${report![1]} AND report_key=${report![2]}`;
    allowed = !!row;
  } else if (source && ["source_listing", "source_detail", "source_search"].includes(purpose)) {
    allowed = trial.status === "open" && await trialSourceAllowed(source, db);
  } else if (["dailynews_source_fallback", "mp_history", "mp_article"].includes(purpose)) {
    allowed = trial.status === "open" && await trialSourceAllowed(subject, db);
  }
  if (!allowed) throw new TrialBoundaryError(`paid subject outside cohort: ${purpose} ${subject}`);
}
