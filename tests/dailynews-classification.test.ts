import { gate, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFileSync } from "node:fs";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { analyzeArticle, tierThreshold, UNDERSTAND_FLOOR } from "@aihot/backend/editorial/analyze";
import { currentAnalysisSignature, policyIdForCategory } from "@aihot/backend/editorial/policy";
import { CATEGORIES, ITEM_TYPES } from "@aihot/industry/taxonomy";
import { processArticle } from "@aihot/backend/jobs/content";
import { stopBoss } from "@aihot/backend/jobs/queue";

const T = tag();
const SOURCE = `test-classification-${T}`;
const calls: Array<{ marker: string; step: string; model: string }> = [];
const holds = new Map<string, { entered: ReturnType<typeof gate<void>>; release: ReturnType<typeof gate<void>> }>();
const provider = await stub(async (_hit, req) => {
  const body = JSON.parse(req.body) as { messages: Array<{ content: unknown }> };
  const system = String(body.messages[0]?.content ?? "");
  const user = String(body.messages.at(-1)?.content ?? "");
  const marker = ["STALE_SOURCE", "STALE_MANUAL", "STALE_MODEL", "NONAI", "FALLBACK", "PENDING", "MANUAL", "UNKNOWN"].find((s) => user.includes(s)) ?? "";
  const step = system.includes("资料结构化助手") ? "structure" : system.includes("宽召回的AI相关性预筛") ? "prefilter"
    : system.includes("事件注意力评分器") ? "score" : system.includes("内容理解编辑") ? "understand" : "copy";
  calls.push({ marker, step, model: String((body as { model?: string }).model ?? "") });
  const hold = holds.get(marker);
  if (hold && step === "structure") { holds.delete(marker); hold.entered.open(); await hold.release.promise; }
  const json = (content: unknown) => ({ id: `classification-${calls.length}`, model: "test-model", choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  if (step === "structure") {
    const category = marker === "PENDING" ? null : marker === "NONAI" ? "finance" : marker === "MANUAL" ? "ai"
      : marker === "FALLBACK" && system.includes("复核是否明确属于其余九个主类") ? "finance" : "ai";
    return json({ category, categoryReason: "按正文主旨判断", tags: ["财经"], subjects: [], fact: { title: `${marker} 核心事实` } });
  }
  if (step === "prefilter") return json({ label: marker === "FALLBACK" ? "BLOCK" : marker === "UNKNOWN" ? "UNKNOWN" : "PASS", reason: "测试" });
  if (step === "score") return json({ attentionScore: 80 });
  if (step === "understand") return json({ itemType: "model_release", authorRole: "principal", tags: ["模型发布"], editorialJudgment: "模型发布", titleZh: `${marker} 模型发布`, summaryZh: "发布了新模型并公布评测结果。" });
  return json(`title_zh: ${marker} 财经新闻\nsummary_zh: 报道说明了事件进展及已知影响。`);
});
for (const key of ["DASHSCOPE_BASE_URL", "ZHIPU_BASE_URL", "DEEPSEEK_BASE_URL"]) process.env[key] = `${provider.url}/v1`;
for (const key of ["DASHSCOPE_API_KEY", "ZHIPU_API_KEY", "DEEPSEEK_API_KEY"]) process.env[key] = "test-key";

before(async () => {
  await sql`INSERT INTO sources (id,name,kind,tier,participation_mode,next_fetch_at)
    VALUES (${SOURCE},'综合媒体','rss','T1','editorial','2100-01-01')`;
});
after(async () => { await provider.close(); await stopBoss(); await closeDb(); });

const article = async (marker: string) => (await upsertMaterial({
  sourceId: SOURCE, url: `https://example.org/${T}/${marker}`, title: `${marker} report ${T}`,
  bodyText: `${marker} news report with verifiable details. `.repeat(12) + T, bodyStatus: "ok", via: "fetch", publishedAt: new Date(),
})).articleId;
const steps = (marker: string) => calls.filter((c) => c.marker === marker).map((c) => c.step);

test("AIHOT selection thresholds and original AI prompts match the fixed baseline", () => {
  for (const file of ["selection.ts", "prompts/prefilter.md", "prompts/selection-score.md", "prompts/content-understanding.md", "prompts/understand.md"]) {
    const current = readFileSync(new URL(`../industry/${file}`, import.meta.url));
    const fixed = readFileSync(new URL(`../reference/baselines/aihot-rules/${file}`, import.meta.url));
    assert.deepEqual(current, fixed, file);
  }
  assert.deepEqual(CATEGORIES.map((category) => category.key), ["ai", "technology", "finance", "international", "china", "policy", "society", "science", "sports", "entertainment"]);
  assert.deepEqual([...ITEM_TYPES], ["model_release", "product_launch", "tool_or_prompt", "research_paper", "industry_event", "opinion_analysis", "tutorial_explainer"]);
  assert.deepEqual([tierThreshold("T1"), tierThreshold("T1_5"), tierThreshold("T2"), UNDERSTAND_FLOOR], [60, 65, 76, 50]);
});

test("ten stable primary categories and distinct policy routes", async () => {
  assert.equal(policyIdForCategory("ai"), "aihot-ai-article");
  assert.equal(policyIdForCategory("finance"), "dailynews-non-ai-article");
  assert.equal(policyIdForCategory(null), "classification-pending");
  const id = await article("NONAI");
  const result = await analyzeArticle(id);
  assert.deepEqual([result!.output!.category, result!.output!.relevance, result!.output!.selected, result!.output!.score], ["finance", "pass", false, null]);
  assert.deepEqual(steps("NONAI"), ["structure", "copy"], JSON.stringify(calls));
  const [row] = await sql`SELECT policy_id,input_signature,output FROM analyses WHERE article_id=${id}`;
  assert.equal(row!.policy_id, "dailynews-non-ai-article");
  assert.equal(row!.input_signature, await currentAnalysisSignature(id));
  assert.equal(row!.output.classification.originalCategory, "finance");
  assert.equal(row!.output.actualModels.structure.service, "dashscope");
});

test("AI BLOCK reviews another category once; UNKNOWN continues both scores", async () => {
  const fallbackId = await article("FALLBACK");
  const fallback = await analyzeArticle(fallbackId);
  assert.deepEqual([fallback!.output!.category, fallback!.output!.relevance], ["finance", "pass"]);
  assert.deepEqual(steps("FALLBACK"), ["structure", "prefilter", "structure", "copy"]);
  const [row] = await sql`SELECT output FROM analyses WHERE article_id=${fallbackId}`;
  assert.deepEqual([row!.output.classification.originalCategory, row!.output.classification.fallback.category], ["ai", "finance"]);
  const [articleState] = await sql`SELECT classification_fallback_count FROM articles WHERE id=${fallbackId}`;
  assert.equal(articleState!.classification_fallback_count, 1);
  const repeated = await analyzeArticle(fallbackId, { attemptTag: "explicit-same-revision" });
  assert.equal(repeated!.output!.category, "finance", "the one stored fallback survives a same-revision re-evaluation");
  assert.equal(steps("FALLBACK").filter((step) => step === "structure").length, 3, "the paid cross-category review ran only once");
  const unknown = await analyzeArticle(await article("UNKNOWN"));
  assert.deepEqual([unknown!.output!.category, unknown!.output!.selected], ["ai", true]);
  assert.deepEqual(steps("UNKNOWN").sort(), ["structure", "prefilter", "score", "score", "understand"].sort());
});

test("uncertain classification stays pending with a finite retry and no score", async () => {
  const id = await article("PENDING");
  const first = await analyzeArticle(id);
  assert.deepEqual([first!.classificationPending, first!.classificationRetryRemaining, first!.output!.category, first!.output!.relevance], [true, 1, null, "unknown"]);
  const second = await analyzeArticle(id, { attemptTag: first!.classificationRetryTag! });
  assert.deepEqual([second!.classificationPending, second!.classificationRetryRemaining], [true, 0]);
  assert.deepEqual(steps("PENDING"), ["structure", "structure"]);
});

test("a null classification never reaches the public projection", async () => {
  const id = await article("PENDING_PUBLIC");
  assert.equal((await processArticle(id)).state, "classification-pending");
  assert.equal((await sql`SELECT 1 FROM publications WHERE article_id=${id}`).length, 0);
  const [state] = await sql`SELECT classification_retry_count FROM articles WHERE id=${id}`;
  assert.equal(state!.classification_retry_count, 1);
});

test("manual classification wins routing and source tier invalidates the signature", async () => {
  const id = await article("MANUAL");
  await sql`INSERT INTO editorial_overrides (article_id,fields,reason) VALUES (${id},${sql.json({ category: "technology" })},'人工纠正')`;
  const result = await analyzeArticle(id);
  assert.equal(result!.output!.category, "technology");
  assert.deepEqual(steps("MANUAL"), ["structure", "copy"]);
  const initial = await currentAnalysisSignature(id);
  await sql`UPDATE sources SET tier='T2' WHERE id=${SOURCE}`;
  assert.notEqual(await currentAnalysisSignature(id), initial);
});

test("changes to source, manual category and model during a paid call leave the result stale", async () => {
  await sql`UPDATE sources SET tier='T1' WHERE id=${SOURCE}`;
  for (const marker of ["STALE_SOURCE", "STALE_MANUAL", "STALE_MODEL"]) {
    const id = await article(marker);
    const hold = { entered: gate<void>(), release: gate<void>() };
    holds.set(marker, hold);
    const pending = analyzeArticle(id);
    await hold.entered.promise;
    if (marker === "STALE_SOURCE") await sql`UPDATE sources SET tier='T2' WHERE id=${SOURCE}`;
    if (marker === "STALE_MANUAL") await sql`INSERT INTO editorial_overrides (article_id,fields,reason) VALUES (${id},${sql.json({ category: "technology" })},'复核分类')`;
    if (marker === "STALE_MODEL") await sql`INSERT INTO settings (key,value) VALUES ('models.structure',${sql.json({ model: "qwen3.7-flash" })}) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`;
    hold.release.open();
    const result = await pending;
    assert.equal(result!.stale, true, marker);
    assert.equal((await sql`SELECT processing_state FROM articles WHERE id=${id}`)[0]!.processing_state, "new");
    if (marker === "STALE_SOURCE") await sql`UPDATE sources SET tier='T1' WHERE id=${SOURCE}`;
    if (marker === "STALE_MODEL") {
      const fresh = await analyzeArticle(id, { attemptTag: "after-model-switch" });
      assert.equal(fresh!.stale, false);
      assert.equal(calls.filter((c) => c.marker === marker && c.step === "structure").at(-1)!.model, "qwen3.7-flash", "next run uses fresh DB setting");
      await sql`DELETE FROM settings WHERE key='models.structure'`;
    }
  }
});
