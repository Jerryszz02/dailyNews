import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { processArticle, queueProcessing } from "@aihot/backend/jobs/content";
import { paidRequest } from "@aihot/backend/providers/receipts";
import { admitArticle, assertTrialPaidSubject, assertTrialRuntime, beginTrialSource, createTrial,
  closeTrial, freezeTrial, resumeTrial, trialArticleAllowed, trialQueueAllowed } from "@aihot/backend/dailynews/trial";

const suffix = Math.random().toString(36).slice(2, 10);
const id = `trial-${suffix}`;
const sourceIds = Array.from({ length: 10 }, (_, i) => `trial-source-${suffix}-${i}`);
const articles = Array.from({ length: 6 }, (_, i) => `trial-article-${suffix}-${i}`);
const capabilityModelEnv = ["STRUCTURE_MODEL", "PREFILTER_MODEL", "SCORE_MODEL", "UNDERSTAND_MODEL", "SUMMARIZE_MODEL",
  "GROUP_MODEL", "GROUP_REVIEW_MODEL", "DIGEST_MODEL", "REPORT_MODEL"];
const saved = Object.fromEntries(["DAILYNEWS_TRIAL_MODE", "DAILYNEWS_TRIAL_ID", "DAILYNEWS_TRIAL_SETTINGS_HASH",
  "DAILYNEWS_TRIAL_DB_NAME", "DAILYNEWS_DEEPSEEK_PRICE_BAND", "DAILYNEWS_DEEPSEEK_PRICE_VALID_FROM",
  "DAILYNEWS_DEEPSEEK_PRICE_VALID_UNTIL", "LLM_MODEL", "LLM_BASE_URL", "LLM_API_KEY",
  ...capabilityModelEnv].map((name) => [name, process.env[name]]));
let savedDeepSeekBudget: { per_minute: number; per_hour: number; per_day: number } | undefined;
let savedGlobalBudget: { per_minute: number; per_hour: number; per_day: number } | undefined;
const receiptIds: number[] = [];
let priorLiveAttempts: number[] = [];

after(async () => {
  try {
    if (receiptIds.length) {
      await sql`DELETE FROM receipt_attempts WHERE receipt_id IN ${sql(receiptIds)}`;
      await sql`DELETE FROM receipts WHERE id IN ${sql(receiptIds)}`;
    }
    await sql`DELETE FROM dailynews_trial_reports WHERE trial_id=${id}`;
    await sql`DELETE FROM dailynews_trial_articles WHERE trial_id=${id}`;
    await sql`DELETE FROM dailynews_trial_sources WHERE trial_id=${id}`;
    await sql`DELETE FROM dailynews_trials WHERE id=${id}`;
    await sql`DELETE FROM articles WHERE id IN ${sql(articles)}`;
    await sql`DELETE FROM sources WHERE id IN ${sql(sourceIds)}`;
    if (savedDeepSeekBudget) await sql`UPDATE budgets SET per_minute=${savedDeepSeekBudget.per_minute},
      per_hour=${savedDeepSeekBudget.per_hour},per_day=${savedDeepSeekBudget.per_day} WHERE service='deepseek'`;
    if (savedGlobalBudget) await sql`UPDATE budgets SET per_minute=${savedGlobalBudget.per_minute},
      per_hour=${savedGlobalBudget.per_hour},per_day=${savedGlobalBudget.per_day} WHERE service='llm-global'`;
    else await sql`DELETE FROM budgets WHERE service='llm-global'`;
    if (priorLiveAttempts.length) await sql`UPDATE receipt_attempts SET origin='live'
      WHERE id IN ${sql(priorLiveAttempts)}`;
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await stopBoss();
    await closeDb();
  }
});

test("bounded cohort survives restart, separates lanes and rejects later work or settings drift", async () => {
  // The full offline suite shares one database. Earlier synthetic requests must not
  // consume this isolated cohort's budget; restore their provenance after the test.
  priorLiveAttempts = (await sql<{ id: number }[]>`SELECT id FROM receipt_attempts WHERE origin='live'`).map((row) => row.id);
  if (priorLiveAttempts.length) await sql`UPDATE receipt_attempts SET origin='replay'
    WHERE id IN ${sql(priorLiveAttempts)}`;
  const [database] = await sql<{ name: string }[]>`SELECT current_database() AS name`;
  process.env.DAILYNEWS_TRIAL_DB_NAME = database!.name;
  process.env.DAILYNEWS_DEEPSEEK_PRICE_BAND = "peak";
  process.env.DAILYNEWS_DEEPSEEK_PRICE_VALID_FROM = new Date(Date.now() - 3600_000).toISOString();
  process.env.DAILYNEWS_DEEPSEEK_PRICE_VALID_UNTIL = new Date(Date.now() + 86400_000).toISOString();
  process.env.LLM_MODEL = "deepseek-flash";
  process.env.LLM_BASE_URL = "https://api.deepseek.com/v1";
  process.env.LLM_API_KEY = "test-only-key";
  for (const name of capabilityModelEnv) process.env[name] = "default";
  [savedDeepSeekBudget] = await sql<{ per_minute: number; per_hour: number; per_day: number }[]>`
    SELECT per_minute,per_hour,per_day FROM budgets WHERE service='deepseek'`;
  await sql`UPDATE budgets SET per_minute=20,per_hour=200,per_day=1000 WHERE service='deepseek'`;
  [savedGlobalBudget] = await sql<{ per_minute: number; per_hour: number; per_day: number }[]>`
    SELECT per_minute,per_hour,per_day FROM budgets WHERE service='llm-global'`;
  await sql`INSERT INTO budgets (service,per_minute,per_hour,per_day) VALUES ('llm-global',20,200,1000)
    ON CONFLICT (service) DO UPDATE SET per_minute=20,per_hour=200,per_day=1000`;
  for (const [index, sourceId] of sourceIds.entries()) await sql`
    INSERT INTO sources (id,name,kind,config,cursor) VALUES
    (${sourceId},'试运行来源','rss',${sql.json({ dailyNews: { migrationStatus: "verified",
      legacySourceId: `trial-${suffix}`, sectionId: String(index), publisherKey: `trial-${suffix}` } })},
      ${sql.json({ initializedAt: "2026-09-01T00:00:00.000Z" })})`;
  const created = await createTrial({ id, sourceIds, normalLimit: 2, backfillLimit: 1 });
  await assert.rejects(createTrial({ id: `${id}-replacement`, sourceIds }), /duplicate key/,
    "a second trial ID cannot refill the database's lifetime cohort quota");
  process.env.DAILYNEWS_TRIAL_MODE = "bounded";
  process.env.DAILYNEWS_TRIAL_ID = id;
  process.env.DAILYNEWS_TRIAL_SETTINGS_HASH = created.settingsHash;
  assert.equal((await assertTrialRuntime())?.id, id);
  const baseline = await beginTrialSource(sourceIds[0]!);
  assert.equal(baseline?.toISOString(), "2026-09-01T00:00:00.000Z");
  assert.equal((await beginTrialSource(sourceIds[0]!))?.toISOString(), baseline?.toISOString());
  const material = [
    { published: "2026-09-01T01:00:00Z", backfill: false },
    { published: "2026-09-01T02:00:00Z", backfill: false },
    { published: "2026-09-01T03:00:00Z", backfill: false },
    { published: "2026-08-01T00:00:00Z", backfill: true },
    { published: "2026-08-02T00:00:00Z", backfill: true },
    { published: "2026-09-01T04:00:00Z", backfill: false },
  ];
  for (let i = 0; i < articles.length; i++) await sql`
    INSERT INTO articles (id,source_id,identity_key,url,title,discovered_at,timeline_at,published_at,backfill)
    VALUES (${articles[i]!},${sourceIds[i === 5 ? 1 : 0]!},${articles[i]!},${`https://example.com/${articles[i]}`},'试运行文章',now(),now(),
      ${new Date(material[i]!.published)},${material[i]!.backfill})`;
  assert.deepEqual(await admitArticle(articles[5]!, { lane: "normal" }), { admitted: false, reason: "no-baseline" });
  assert.deepEqual(await admitArticle(articles[3]!, { lane: "normal" }), { admitted: false, reason: "not-new" });
  assert.deepEqual(await admitArticle(articles[0]!, { lane: "backfill" }), { admitted: false, reason: "not-backfill" });
  assert.deepEqual(await admitArticle(articles[0]!, { lane: "normal" }), { admitted: true, reason: "admitted" });
  assert.deepEqual(await admitArticle(articles[0]!, { lane: "normal" }), { admitted: true, reason: "already-admitted" });
  assert.deepEqual(await admitArticle(articles[1]!, { lane: "normal" }), { admitted: true, reason: "admitted" });
  assert.deepEqual(await admitArticle(articles[2]!, { lane: "normal" }), { admitted: false, reason: "quota" });
  assert.deepEqual(await admitArticle(articles[3]!, { lane: "backfill" }), { admitted: true, reason: "admitted" });
  assert.deepEqual(await admitArticle(articles[4]!, { lane: "backfill" }), { admitted: false, reason: "quota" });
  await assert.rejects(sql`UPDATE dailynews_trials SET normal_limit=100 WHERE id=${id}`, /immutable/);
  await assert.rejects(sql`UPDATE dailynews_trial_sources SET initialized_at=now() WHERE trial_id=${id} AND source_id=${sourceIds[0]}`, /immutable/);
  await assert.rejects(sql`UPDATE dailynews_trial_articles SET lane='backfill' WHERE article_id=${articles[0]}`, /immutable/);
  assert.equal(await trialArticleAllowed(articles[2]!), false);
  assert.equal(await trialQueueAllowed("content.analyze", { articleId: articles[2] }), false);
  assert.equal(await queueProcessing(articles[2]!), null);
  assert.deepEqual(await processArticle(articles[2]!), { state: "outside-trial" });
  const paid = { service: "deepseek", model: "deepseek-flash", resourceKind: "llm" as const,
    providerBaseUrl: "https://api.deepseek.com/v1" };
  await assert.rejects(assertTrialPaidSubject("structure_article", `article:${articles[2]}`, sql, paid), /outside cohort/);
  await assert.rejects(assertTrialPaidSubject("structure_article", `article:${articles[0]}`, sql,
    { service: "zhipu", model: "glm-5.3-flash", resourceKind: "llm", providerBaseUrl: "https://api.deepseek.com/v1" }), /unverified model/);
  await assert.rejects(assertTrialPaidSubject("structure_article", `article:${articles[0]}`, sql,
    { ...paid, providerBaseUrl: "https://gateway.example/v1" }), /unverified model/);
  await assertTrialPaidSubject("structure_article", `article:${articles[0]}`, sql, paid);
  const request = { service: "deepseek", resourceKind: "llm" as const, model: "deepseek-flash",
    providerBaseUrl: "https://api.deepseek.com/v1", purpose: "structure_article",
    subject: `article:${articles[0]}`, identity: { trial: id, revision: 1 } };
  let calls = 0;
  const fakeCall = async () => { calls += 1; return { response: { ok: true }, usage: { prompt_tokens: 2,
    prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 2, completion_tokens: 1 } }; };
  const first = await paidRequest(request, fakeCall);
  receiptIds.push(first.receiptId);
  await freezeTrial(id);
  assert.deepEqual(await resumeTrial(id), [articles[0], articles[1], articles[3]]);
  await assert.rejects(beginTrialSource(sourceIds[0]!), /collection is closed/);
  assert.equal(await trialQueueAllowed("sources.fetch", { sourceId: sourceIds[0] }), false);
  const second = await paidRequest(request, fakeCall);
  assert.equal(second.receiptId, first.receiptId);
  assert.equal(second.reused, true);
  assert.equal(calls, 1, "restart and freeze reuse the persisted receipt instead of buying again");
  const [attempts] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM receipt_attempts WHERE receipt_id=${first.receiptId}`;
  assert.equal(attempts?.n, 1);
  assert.deepEqual(await admitArticle(articles[2]!, { lane: "normal" }), { admitted: false, reason: "closed" });
  // The worker's future read also rejects a budget/config switch, even if env still points to this trial.
  await sql`UPDATE sources SET tier='T1' WHERE id=${sourceIds[0]}`;
  await assert.rejects(assertTrialRuntime(), /source configuration changed/);
  await sql`UPDATE sources SET tier='T2' WHERE id=${sourceIds[0]}`;
  process.env.DAILYNEWS_TRIAL_SETTINGS_HASH = "0".repeat(64);
  await assert.rejects(assertTrialRuntime(), /runtime settings changed/);
  process.env.DAILYNEWS_TRIAL_SETTINGS_HASH = created.settingsHash;
  let providerEntered!: () => void;
  let releaseProvider!: () => void;
  const entered = new Promise<void>((resolve) => { providerEntered = resolve; });
  const release = new Promise<void>((resolve) => { releaseProvider = resolve; });
  const inFlight = paidRequest({ ...request, identity: { trial: id, revision: "in-flight" } }, async () => {
    providerEntered();
    await release;
    return { response: { ok: true } };
  });
  await entered;
  const beforeClose = (await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM receipt_attempts WHERE service='deepseek'`)[0]!.n;
  const racingRequest = { ...request, identity: { trial: id, revision: 2 } };
  let raced!: ReturnType<typeof paidRequest>;
  try {
    await sql.begin(async (tx) => {
      // Hold the same row closeTrial updates. The first trial check can pass, while
      // the reservation's FOR SHARE must wait for this close to commit.
      await tx`SELECT id FROM dailynews_trials WHERE id=${id} FOR UPDATE`;
      raced = paidRequest(racingRequest, fakeCall);
      void raced.catch(() => {});
      let waiting = false;
      for (let attempt = 0; attempt < 200; attempt++) {
        waiting = (await sql<{ waiting: boolean }[]>`
          SELECT EXISTS (SELECT 1 FROM pg_stat_activity
            WHERE datname=current_database() AND pid<>pg_backend_pid()
              AND wait_event_type='Lock' AND query LIKE '%dailynews_trials%') AS waiting`)[0]?.waiting ?? false;
        if (waiting) break;
        await wait(25);
      }
      assert.equal(waiting, true, "paid reservation reaches the trial row lock after its initial check");
      process.env.DAILYNEWS_DEEPSEEK_PRICE_VALID_UNTIL = new Date(Date.now() - 1000).toISOString();
      await closeTrial(id, tx);
    });
  } finally {
    releaseProvider();
  }
  await assert.rejects(raced, /missing or closed/);
  const completedInFlight = await inFlight;
  receiptIds.push(completedInFlight.receiptId);
  const [timing] = await sql<{ started_at: Date; closed_at: Date; status: string }[]>`
    SELECT ra.started_at,t.closed_at,ra.status FROM receipt_attempts ra
    CROSS JOIN dailynews_trials t WHERE ra.receipt_id=${completedInFlight.receiptId} AND t.id=${id}`;
  assert.equal(timing?.status, "received");
  assert.ok(timing!.started_at <= timing!.closed_at, "a pre-close reservation remains in the trial accounting window");
  const afterClose = (await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM receipt_attempts WHERE service='deepseek'`)[0]!.n;
  assert.equal(afterClose, beforeClose, "closing before reservation creates no extra paid attempt");
  assert.equal(calls, 1, "a closed trial never reaches the provider stub");
  await assert.rejects(assertTrialRuntime(), /missing or closed/);
  delete process.env.DAILYNEWS_TRIAL_MODE;
  delete process.env.DAILYNEWS_TRIAL_ID;
  delete process.env.DAILYNEWS_TRIAL_SETTINGS_HASH;
  delete process.env.DAILYNEWS_TRIAL_DB_NAME;
  await assert.rejects(assertTrialRuntime(), /trial database requires explicit runtime settings/);
});
