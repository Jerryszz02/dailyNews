import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { analyzeArticle } from "@aihot/backend/editorial/analyze";
import { stopBoss } from "@aihot/backend/jobs/queue";

const id = `copy-evidence-${tag()}`;
let unsafe = true;
const provider = await stub((_hit, req) => {
  const body = JSON.parse(req.body);
  const system = String(body.messages[0]?.content ?? "");
  const content = system.includes("资料结构化助手")
    ? JSON.stringify({ category: "china", tags: [], subjects: [], fact: { title: "出行量突破3亿人次" } })
    : `title_zh: ${unsafe ? "出行量突破3亿人次" : "预计出行量超过3亿人次"}\nsummary_zh: ${unsafe ? "出行量突破3亿人次，交通部门公布最新情况。" : "交通部门预计出行量超过3亿人次，这是预测数据，尚非已发生的出行总量。"}`;
  return { id: "quality-pipeline-stub", choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 10 } };
});
Object.assign(process.env, { LLM_BASE_URL: `${provider.url}/v1`, LLM_API_KEY: "test-key", LLM_MODEL: "test-model", STRUCTURE_MODEL: "default", SUMMARIZE_MODEL: "default" });
before(async () => {
  await sql`INSERT INTO budgets(service,per_minute,per_hour,per_day) VALUES('llm',1000,10000,100000) ON CONFLICT(service) DO UPDATE SET per_minute=1000,per_hour=10000,per_day=100000`;
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode) VALUES(${id},'虚构交通来源','rss','T1','editorial')`;
});
after(async () => { await provider.close(); await stopBoss(); await closeDb(); });

test("bad Chinese copy is rejected before an analysis is saved; corrected copy can proceed", async () => {
  const { articleId } = await upsertMaterial({ sourceId: id, url: `https://example.test/${id}`, title: "Travel volume is expected to exceed 300 million trips", bodyText: "The transport department expects travel volume to exceed 300 million trips. This is a forecast, not an observed total.", bodyStatus: "ok", via: "fetch", publishedAt: new Date() });
  await assert.rejects(analyzeArticle(articleId, { attemptTag: `bad-copy-${id}` }), /Copy held for evidence correction/);
  assert.equal((await sql`SELECT 1 FROM analyses WHERE article_id=${articleId}`).length, 0);
  const [receipt] = await sql`SELECT status,error FROM receipts WHERE subject LIKE ${`article:${articleId}%`} AND purpose='summarize_non_ai_article' ORDER BY id DESC LIMIT 1`;
  assert.ok(receipt!.error.includes("prediction-qualifier"));
  unsafe = false;
  const result = await analyzeArticle(articleId, { attemptTag: `corrected-copy-${id}` });
  assert.ok(result?.output?.titleZh.includes("预计"));
  assert.equal(result?.output?.category, "china");
});
