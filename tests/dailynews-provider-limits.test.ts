import { gate, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { BudgetExceededError, logicalKeyFor, paidRequest } from "@aihot/backend/providers/receipts";
import { estimateDeepSeekFlash, observedTokens } from "@aihot/backend/providers/pricing";
import { ensureEmbeddings } from "@aihot/backend/providers/embeddings";
import { admitArticle, beginTrialSource, createTrial } from "@aihot/backend/dailynews/trial";

after(closeDb);

async function budget(service: string) {
  await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day, note)
    VALUES (${service}, 20, 200, 1000, 'offline provider gate test')`;
}

test("a missing budget fails closed before a paid call or attempt", async () => {
  const service = `unbudgeted-${tag()}`;
  let sent = false;
  await assert.rejects(paidRequest({ service, purpose: "invariant_test", identity: { one: 1 } }, async () => {
    sent = true;
    return { response: {} };
  }), BudgetExceededError);
  assert.equal(sent, false);
  assert.equal((await sql`SELECT 1 FROM receipt_attempts WHERE service=${service}`).length, 0);
});

test("all LLM services share two persisted active slots, and reuse is free", async () => {
  const serviceA = `model-a-${tag()}`;
  const serviceB = `model-b-${tag()}`;
  await budget(serviceA);
  await budget(serviceB);
  const entered = gate();
  const release = gate();
  let enteredCount = 0;
  let thirdEntered = false;
  const req = (service: string, n: number) => ({ service, resourceKind: "llm" as const,
    purpose: "invariant_test", subject: `model-${tag()}`, identity: { n, service } });
  const firstReq = req(serviceA, 1);
  const secondReq = req(serviceB, 2);
  const thirdReq = req(serviceB, 3);
  const hold = async () => {
    if (++enteredCount === 2) entered.open();
    await release.promise;
    return { response: { ok: true } };
  };
  const first = paidRequest(firstReq, hold);
  const second = paidRequest(secondReq, hold);
  await entered.promise;
  let third: Promise<Awaited<ReturnType<typeof paidRequest>>> | undefined;
  try {
    third = paidRequest(thirdReq, async () => { thirdEntered = true; return { response: { ok: true } }; });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(thirdEntered, false);
    const [active] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM receipt_attempts WHERE is_llm AND origin='live' AND status='pending'`;
    assert.equal(active!.n, 2);
  } finally {
    release.open();
  }
  const [a, b, c] = await Promise.all([first, second, third!]);
  assert.equal(thirdEntered, true);
  assert.deepEqual([a.reused, b.reused, c.reused], [false, false, false]);
  await sql`UPDATE budgets SET per_minute=0 WHERE service=${serviceA}`;
  const reused = await paidRequest(firstReq, async () => { throw new Error("must not call provider twice"); });
  assert.equal(reused.reused, true);
  assert.equal(reused.receiptId, a.receiptId);
  await assert.rejects(paidRequest(req(serviceA, 4), async () => ({ response: {} })), BudgetExceededError);
});

test("stale persisted LLM slots become unknown, freeing capacity without re-sending", async () => {
  const service = `stale-${tag()}`;
  await budget(service);
  const oldReq = { service, resourceKind: "llm" as const, purpose: "invariant_test", identity: { stale: tag() } };
  const [stale] = await sql<{ id: number }[]>`
    INSERT INTO receipts (logical_key,service,purpose,status,attempts,request,created_at,updated_at)
    VALUES (${logicalKeyFor(oldReq)},${service},${oldReq.purpose},'pending',1,'{}',now()-interval '11 minutes',now()-interval '11 minutes')
    RETURNING id`;
  await sql`INSERT INTO receipt_attempts (receipt_id,attempt,service,status,is_llm,started_at)
    VALUES (${stale!.id},1,${service},'pending',true,now()-interval '11 minutes')`;
  const fresh = await paidRequest({ service, resourceKind: "llm", purpose: "invariant_test", identity: { fresh: tag() } },
    async () => ({ response: { ok: true } }));
  assert.equal(fresh.reused, false);
  const [state] = await sql<{ receipt_status: string; attempt_status: string }[]>`
    SELECT r.status AS receipt_status,a.status AS attempt_status FROM receipts r JOIN receipt_attempts a ON a.receipt_id=r.id
    WHERE r.id=${stale!.id}`;
  assert.deepEqual(state, { receipt_status: "unknown", attempt_status: "unknown" });
  await assert.rejects(paidRequest(oldReq, async () => { throw new Error("stale request must not be resent"); }),
    { name: "Error", message: /unknown outcome/ });
});

test("actual response model, token counters and price snapshot persist on both records", async () => {
  const service = `accounting-${tag()}`;
  await budget(service);
  const at = new Date("2026-10-03T00:30:00Z");
  const usage = { prompt_tokens: 1000, prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 200,
    completion_tokens: 100, total_tokens: 1100 };
  const priced = estimateDeepSeekFlash("deepseek-flash", "deepseek-v4.1-flash", usage, at, {
    DAILYNEWS_DEEPSEEK_PRICE_BAND: "off_peak", DAILYNEWS_DEEPSEEK_PRICE_VALID_FROM: "2026-10-03T00:00:00Z",
    DAILYNEWS_DEEPSEEK_PRICE_VALID_UNTIL: "2026-10-03T01:00:00Z",
  });
  assert.ok(priced);
  assert.equal(priced.amount, 0.0000924);
  const result = await paidRequest({ service, resourceKind: "llm", model: "deepseek-flash", purpose: "invariant_test",
    identity: { token: tag() } }, async () => ({ response: { ok: true }, responseModel: "deepseek-v4.1-flash", usage,
    cost: { amount: priced.amount, currency: priced.currency, basis: priced.basis, snapshot: priced.snapshot, pricedAt: at } }));
  const rows = await sql<{ response_model: string; prompt_tokens: number; cache_hit_tokens: number;
    cache_miss_tokens: number; completion_tokens: number; cost: string; cost_basis: string;
    price_snapshot: { band: string; responseModel: string }; priced_at: Date }[]>`
    SELECT response_model, prompt_tokens, cache_hit_tokens, cache_miss_tokens, completion_tokens,
      cost, cost_basis, price_snapshot, priced_at FROM receipts WHERE id=${result.receiptId}
    UNION ALL
    SELECT response_model, prompt_tokens, cache_hit_tokens, cache_miss_tokens, completion_tokens,
      cost, cost_basis, price_snapshot, priced_at FROM receipt_attempts WHERE receipt_id=${result.receiptId}`;
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.response_model, "deepseek-v4.1-flash");
    assert.deepEqual([row.prompt_tokens, row.cache_hit_tokens, row.cache_miss_tokens, row.completion_tokens], [1000, 800, 200, 100]);
    assert.equal(Number(row.cost), 0.0000924);
    assert.equal(row.cost_basis, "estimated");
    assert.deepEqual([row.price_snapshot.band, row.price_snapshot.responseModel], ["off_peak", "deepseek-v4.1-flash"]);
    assert.equal(row.priced_at.toISOString(), at.toISOString());
  }
});

test("price remains unknown for missing usage, model, band or operator window", () => {
  const at = new Date("2026-10-03T00:30:00Z");
  const env = { DAILYNEWS_DEEPSEEK_PRICE_BAND: "peak", DAILYNEWS_DEEPSEEK_PRICE_VALID_FROM: "2026-10-03T00:00:00Z",
    DAILYNEWS_DEEPSEEK_PRICE_VALID_UNTIL: "2026-10-03T01:00:00Z" };
  const usage = { prompt_tokens: 100, prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20, completion_tokens: 10 };
  assert.equal(estimateDeepSeekFlash("other", "deepseek-flash", usage, at, env), null);
  assert.equal(estimateDeepSeekFlash("deepseek-flash", "unexpected-model", usage, at, env), null);
  assert.equal(estimateDeepSeekFlash("deepseek-flash", "deepseek-flash", { prompt_tokens: 100 }, at, env), null);
  assert.equal(estimateDeepSeekFlash("deepseek-flash", "deepseek-flash", usage, at, {}), null);
  assert.equal(estimateDeepSeekFlash("deepseek-flash", "deepseek-flash", usage, new Date("2026-10-03T01:00:00Z"), env), null);
  assert.deepEqual(observedTokens({ prompt_tokens: 1, prompt_cache_hit_tokens: -1, completion_tokens: "2" }),
    { promptTokens: 1, cacheHitTokens: null, cacheMissTokens: null, completionTokens: null });
});

test("bounded trial enforces one cross-service model budget and rejects a mixed embedding batch", async () => {
  const suffix = tag();
  const trialId = `provider-${suffix}`;
  const sources = Array.from({ length: 10 }, (_, i) => `provider-source-${suffix}-${i}`);
  const admitted = `provider-article-${suffix}-in`;
  const outside = `provider-article-${suffix}-out`;
  const serviceA = "llm";
  const serviceB = "deepseek";
  const trialEnv = ["DAILYNEWS_TRIAL_MODE", "DAILYNEWS_TRIAL_ID", "DAILYNEWS_TRIAL_SETTINGS_HASH", "DAILYNEWS_TRIAL_DB_NAME",
    "DAILYNEWS_DEEPSEEK_PRICE_BAND", "DAILYNEWS_DEEPSEEK_PRICE_VALID_FROM", "DAILYNEWS_DEEPSEEK_PRICE_VALID_UNTIL",
    "LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL", "STRUCTURE_MODEL", "PREFILTER_MODEL", "SCORE_MODEL", "UNDERSTAND_MODEL",
    "SUMMARIZE_MODEL", "GROUP_MODEL", "GROUP_REVIEW_MODEL", "DIGEST_MODEL", "REPORT_MODEL"] as const;
  const savedEnv = Object.fromEntries(trialEnv.map((name) => [name, process.env[name]]));
  const [oldDeepseek] = await sql<{ per_minute: number; per_hour: number; per_day: number }[]>`
    SELECT per_minute,per_hour,per_day FROM budgets WHERE service='deepseek'`;
  const [oldLlm] = await sql<{ per_minute: number; per_hour: number; per_day: number; note: string | null }[]>`
    SELECT per_minute,per_hour,per_day,note FROM budgets WHERE service='llm'`;
  const [oldGlobal] = await sql<{ per_minute: number; per_hour: number; per_day: number; note: string | null }[]>`
    SELECT per_minute,per_hour,per_day,note FROM budgets WHERE service='llm-global'`;
  const [database] = await sql<{ name: string }[]>`SELECT current_database() AS name`;
  // This suite shares a throwaway DB with other offline tests. Hide earlier synthetic model
  // attempts during this cohort test, then restore their origin without deleting evidence.
  const priorLiveLlm = await sql<{ id: number }[]>`
    SELECT id FROM receipt_attempts WHERE is_llm AND origin='live'`;
  try {
    if (priorLiveLlm.length) await sql`UPDATE receipt_attempts SET origin='replay'
      WHERE id IN ${sql(priorLiveLlm.map((row) => row.id))}`;
    await sql`INSERT INTO budgets (service,per_minute,per_hour,per_day,note)
      VALUES ('llm',20,200,1000,'explicit offline trial model')
      ON CONFLICT (service) DO UPDATE SET per_minute=20,per_hour=200,per_day=1000`;
    await sql`UPDATE budgets SET per_minute=20,per_hour=200,per_day=1000 WHERE service='deepseek'`;
    await sql`DELETE FROM budgets WHERE service='llm-global'`;
    await sql`INSERT INTO budgets (service,per_minute,per_hour,per_day,note)
      VALUES ('llm-global',2,3,4,'explicit offline trial aggregate')`;
    process.env.DAILYNEWS_TRIAL_DB_NAME = database!.name;
    process.env.LLM_API_KEY = "offline-test-key";
    process.env.LLM_BASE_URL = "https://api.deepseek.com/v1";
    process.env.LLM_MODEL = "deepseek-flash";
    for (const name of ["STRUCTURE_MODEL", "PREFILTER_MODEL", "SCORE_MODEL", "UNDERSTAND_MODEL", "SUMMARIZE_MODEL",
      "GROUP_MODEL", "GROUP_REVIEW_MODEL", "DIGEST_MODEL", "REPORT_MODEL"]) process.env[name] = "default";
    process.env.DAILYNEWS_DEEPSEEK_PRICE_BAND = "off_peak";
    process.env.DAILYNEWS_DEEPSEEK_PRICE_VALID_FROM = new Date(Date.now() - 60_000).toISOString();
    process.env.DAILYNEWS_DEEPSEEK_PRICE_VALID_UNTIL = new Date(Date.now() + 3_600_000).toISOString();
    for (const source of sources) await sql`
      INSERT INTO sources (id,name,kind,config,cursor) VALUES
      (${source},'试运行来源','rss',${sql.json({ dailyNews: { migrationStatus: "verified",
        legacySourceId: source, sectionId: source, publisherKey: source } })},
        ${sql.json({ initializedAt: "2026-01-01T00:00:00Z" })})`;
    const trial = await createTrial({ id: trialId, sourceIds: sources, normalLimit: 2 });
    process.env.DAILYNEWS_TRIAL_MODE = "bounded";
    process.env.DAILYNEWS_TRIAL_ID = trialId;
    process.env.DAILYNEWS_TRIAL_SETTINGS_HASH = trial.settingsHash;
    await beginTrialSource(sources[0]!);
    for (const articleId of [admitted, outside]) await sql`
      INSERT INTO articles (id,source_id,identity_key,url,title,discovered_at,timeline_at,published_at,backfill)
      VALUES (${articleId},${sources[0]!},${articleId},${`https://example.org/${articleId}`},'试运行文章',now(),now(),now(),false)`;
    assert.equal((await admitArticle(admitted, { lane: "normal" })).admitted, true);

    const request = (service: string, n: number) => ({ service, resourceKind: "llm" as const,
      model: "deepseek-flash", providerBaseUrl: "https://api.deepseek.com/v1",
      purpose: "prefilter_article", subject: `article:${admitted}`, identity: { trialId, n } });
    const call = async () => ({ response: { ok: true } });
    await sql`DELETE FROM budgets WHERE service='llm-global'`;
    await assert.rejects(paidRequest(request(serviceA, 0), call),
      /runtime settings changed|global LLM budgets/);
    assert.equal((await sql`SELECT 1 FROM receipt_attempts a JOIN receipts r ON r.id=a.receipt_id
      WHERE r.subject=${`article:${admitted}`}`).length, 0);
    await sql`INSERT INTO budgets (service,per_minute,per_hour,per_day,note)
      VALUES ('llm-global',2,3,4,'explicit offline trial aggregate')`;
    await paidRequest(request(serviceA, 1), call);
    await paidRequest(request(serviceB, 2), call);
    await assert.rejects(paidRequest(request(serviceA, 3), call),
      (error: unknown) => error instanceof BudgetExceededError && error.service === "llm-global" && /minute/.test(error.message));

    await sql`UPDATE receipt_attempts SET started_at=now()-interval '2 minutes'
      WHERE receipt_id IN (SELECT id FROM receipts WHERE subject=${`article:${admitted}`})`;
    await paidRequest(request(serviceA, 4), call);
    await assert.rejects(paidRequest(request(serviceB, 5), call),
      (error: unknown) => error instanceof BudgetExceededError && error.service === "llm-global" && /hour/.test(error.message));

    await sql`UPDATE receipt_attempts SET started_at=now()-interval '2 hours'
      WHERE receipt_id IN (SELECT id FROM receipts WHERE subject=${`article:${admitted}`})`;
    await paidRequest(request(serviceB, 6), call);
    await assert.rejects(paidRequest(request(serviceA, 7), call),
      (error: unknown) => error instanceof BudgetExceededError && error.service === "llm-global" && /day/.test(error.message));

    const before = await sql`SELECT id FROM receipts WHERE purpose='embedding'`;
    await assert.rejects(ensureEmbeddings("article", [
      { id: admitted, text: "已入组" }, { id: outside, text: "未入组" },
    ]), /embedding article:.*-out is outside cohort/);
    const after = await sql`SELECT id FROM receipts WHERE purpose='embedding'`;
    assert.equal(after.length, before.length, "mixed batch makes no paid request");
  } finally {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await sql`DELETE FROM receipts WHERE subject=${`article:${admitted}`}`;
    await sql`DELETE FROM dailynews_trial_articles WHERE trial_id=${trialId}`;
    await sql`DELETE FROM articles WHERE id IN ${sql([admitted, outside])}`;
    await sql`DELETE FROM dailynews_trial_sources WHERE trial_id=${trialId}`;
    await sql`DELETE FROM dailynews_trials WHERE id=${trialId}`;
    await sql`DELETE FROM sources WHERE id IN ${sql(sources)}`;
    await sql`DELETE FROM budgets WHERE service IN ('llm','llm-global')`;
    if (oldLlm) await sql`INSERT INTO budgets(service,per_minute,per_hour,per_day,note)
      VALUES('llm',${oldLlm.per_minute},${oldLlm.per_hour},${oldLlm.per_day},${oldLlm.note})`;
    if (oldGlobal) await sql`INSERT INTO budgets(service,per_minute,per_hour,per_day,note)
      VALUES('llm-global',${oldGlobal.per_minute},${oldGlobal.per_hour},${oldGlobal.per_day},${oldGlobal.note})`;
    if (oldDeepseek) await sql`UPDATE budgets SET per_minute=${oldDeepseek.per_minute},
      per_hour=${oldDeepseek.per_hour},per_day=${oldDeepseek.per_day} WHERE service='deepseek'`;
    if (priorLiveLlm.length) await sql`UPDATE receipt_attempts SET origin='live'
      WHERE id IN ${sql(priorLiveLlm.map((row) => row.id))}`;
  }
});
