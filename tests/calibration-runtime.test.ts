import { stub, tag } from './setup.ts';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { closeDb, sql } from '@aihot/backend/db';
import { upsertMaterial } from '@aihot/backend/content/materials';
import { analyzeArticle } from '@aihot/backend/editorial/analyze';
import { trainCalibration } from '@aihot/backend/editorial/calibration';
import { currentAnalysisSignature } from '@aihot/backend/editorial/policy';
import { publishArticle } from '@aihot/backend/publication/publish';
import { reconcileEditorialPolicies } from '@aihot/backend/publication/editorial';
import { stopBoss } from '@aihot/backend/jobs/queue';

const T = tag();
const source = `calibration-runtime-${T}`;
const articleIds: string[] = [];
const factIds: number[] = [];
const storyIds: number[] = [];
const calls: Array<{ marker: string; step: string }> = [];
const provider = await stub((hit, req) => {
  const body = JSON.parse(req.body);
  const system = String(body.messages[0]?.content ?? '');
  const user = JSON.stringify(body.messages.at(-1)?.content ?? '');
  const step = system.includes('资料结构化助手') ? 'structure' : system.includes('宽召回的AI相关性预筛') ? 'prefilter' : system.includes('事件注意力评分器') ? 'score' : system.includes('内容理解编辑') ? 'understand' : 'summarize';
  const marker = user.includes('sportsmarker') ? 'sportsmarker' : 'vetomarker';
  calls.push({ marker, step });
  const response = step === 'structure' ? { category: marker === 'sportsmarker' ? 'policy' : 'ai', categoryReason: '基线', tags: [], subjects: [], fact: null }
    : step === 'prefilter' ? { label: 'PASS', reason: '测试通过' }
    : step === 'score' ? { attentionScore: 90 }
    : step === 'understand' ? { itemType: 'model_release', authorRole: 'principal', tags: [], editorialJudgment: '测试理由', titleZh: '人工智能重大模型正式发布', summaryZh: '机构正式发布人工智能模型，披露适用范围、性能数据以及使用价格。' }
    : 'title_zh: 全国重大体育监管新规正式生效\nsummary_zh: 有关机构正式披露监管新规适用范围、执行时间与公共影响。';
  return { id: `runtime-${T}-${hit}`, model: 'stub', choices: [{ message: { content: typeof response === 'string' ? response : JSON.stringify(response) } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
});
for (const env of ['DASHSCOPE_BASE_URL', 'ZHIPU_BASE_URL', 'DEEPSEEK_BASE_URL']) process.env[env] = `${provider.url}/v1`;
for (const env of ['DASHSCOPE_API_KEY', 'ZHIPU_API_KEY', 'DEEPSEEK_API_KEY']) process.env[env] = 'local-test-key';
const policy = trainCalibration(['sportsmarker', 'vetomarker'].flatMap(marker => Array.from({ length: 3 }, (_, i) => ({ id: `${marker}-${i}`, title: marker, body: '', category: marker === 'sportsmarker' ? 'policy' : 'ai', selected: true, goldCategory: marker === 'sportsmarker' ? 'finance' : 'ai', goldSelected: false }))), `runtime-${T}`);

before(async () => {
  await sql`INSERT INTO sources (id,name,kind,tier,participation_mode,config,next_fetch_at) VALUES
    (${source},'新华社测试','rss','T1','editorial',${sql.json({ dailyNews: { legacySourceId: 'xinhua', sectionId: `calibration-${T}`, publisherKey: 'xinhua', sourceCredibility: 90, mediaType: 'wire', signalRole: 'reporting', mayHavePaywall: false } })},'2100-01-01')`;
});
after(async () => {
  await provider.close();
  if (factIds.length) await sql`DELETE FROM facts WHERE id=ANY(${factIds}::bigint[])`;
  if (storyIds.length) await sql`DELETE FROM stories WHERE id=ANY(${storyIds}::bigint[])`;
  if (articleIds.length) {
    await sql`DELETE FROM selected_ledger WHERE article_id=ANY(${articleIds}::text[])`;
    await sql`DELETE FROM selected_state WHERE article_id=ANY(${articleIds}::text[])`;
    await sql`DELETE FROM articles WHERE id=ANY(${articleIds}::text[])`;
  }
  await sql`DELETE FROM sources WHERE id=${source}`;
  await stopBoss(); await closeDb();
});

async function article(marker: string) {
  const { articleId } = await upsertMaterial({ sourceId: source, url: `https://example.com/calibration-${marker}-${T}`, title: `${marker} 全国重大政策规则变化 ${T}`, bodyText: `${marker} ${T} a lab has released a model with benchmarks and pricing. ${'机构披露执行时间、适用范围与公共影响。'.repeat(20)}`, bodyStatus: 'ok', via: 'ingest', publishedAt: new Date() });
  articleIds.push(articleId);
  // Install the exact frozen snapshot without activating a global policy for other test fixtures.
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,category,title_zh,summary_zh,selected,output)
    VALUES(${articleId},1,'rule','pass','ai','测试标题','测试摘要',false,${sql.json({ calibration: { policy } } as never)})`;
  return articleId;
}

test('calibrated classification precedes routing and survives fact votes; non AI representative is vetoed after quotas', async () => {
  const id = await article('sportsmarker');
  const result = await analyzeArticle(id);
  assert.equal(result?.stale, false);
  assert.equal(result?.output?.category, 'finance');
  assert.deepEqual(calls.filter(call => call.marker === 'sportsmarker').map(call => call.step), ['structure', 'summarize']);
  const [analysis] = await sql<{ id: number; output: Record<string, any>; input_signature: string }[]>`SELECT id,output,input_signature FROM analyses WHERE article_id=${id} ORDER BY id DESC LIMIT 1`;
  assert(analysis!.output.calibration.categoryRuleIds.length);
  assert.equal(await currentAnalysisSignature(id), analysis!.input_signature);
  const [story] = await sql<{ id: number }[]>`INSERT INTO stories(public_id,title,first_report_at,latest_at) VALUES(${randomUUID()},'测试体育事件',now(),now()) RETURNING id`;
  storyIds.push(story!.id);
  const [fact] = await sql<{ id: number }[]>`INSERT INTO facts(public_id,story_id,title) VALUES(${`cal-fact-${T}`},${story!.id},'全国重大体育监管新规正式生效') RETURNING id`;
  factIds.push(fact!.id);
  await sql`INSERT INTO fact_articles(fact_id,article_id,role) VALUES(${fact!.id},${id},'primary')`;
  await publishArticle(id);
  const [state] = await sql<{ primary_category: string; decision_id: number }[]>`SELECT primary_category,decision_id FROM fact_editorial_state WHERE fact_id=${fact!.id}`;
  assert.equal(state!.primary_category, 'finance');
  const [decision] = await sql<{ selected: boolean; score: number; details: Record<string, any> }[]>`SELECT selected,score,details FROM editorial_decisions WHERE id=${state!.decision_id}`;
  assert.equal(decision!.selected, false);
  assert(decision!.score > 0, 'veto preserves deterministic score');
  assert.equal(decision!.details.calibration.policyId, policy.id);
  assert(decision!.details.calibration.ruleIds.length);
  const again = await reconcileEditorialPolicies();
  assert.equal(again.requeued, 0);
});

test('AI veto preserves both original scores and does not bypass any publication gate', async () => {
  const id = await article('vetomarker');
  const result = await analyzeArticle(id);
  assert.equal(result?.stale, false);
  assert.equal(result?.output?.selected, false);
  assert.equal(result?.output?.score, 90);
  const [row] = await sql<{ output: Record<string, any> }[]>`SELECT output FROM analyses WHERE article_id=${id} ORDER BY id DESC LIMIT 1`;
  assert.deepEqual(row!.output.scores, [90, 90]);
  assert.equal(row!.output.calibration.baselineSelected, true);
  assert.deepEqual(calls.filter(call => call.marker === 'vetomarker').map(call => call.step).sort(), ['structure', 'prefilter', 'score', 'score', 'understand'].sort());
});

test('manual category wins over a frozen classification correction', async () => {
  const { articleId: id } = await upsertMaterial({ sourceId: source, url: `https://example.com/calibration-manual-${T}`, title: 'sportsmarker 手工金融分类', bodyText: 'sportsmarker 监管机构发布重大规则变动与适用范围。'.repeat(20), bodyStatus: 'ok', via: 'ingest', publishedAt: new Date() });
  articleIds.push(id);
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,category,title_zh,summary_zh,selected,output) VALUES(${id},1,'rule','pass','ai','测试标题','测试摘要',false,${sql.json({ calibration: { policy } } as never)})`;
  await sql`INSERT INTO editorial_overrides(article_id,fields,reason) VALUES(${id},${sql.json({ category: 'finance' })},'人工分类')`;
  const result = await analyzeArticle(id);
  assert.equal(result?.output?.category, 'finance');
  const [row] = await sql<{ output: Record<string, any> }[]>`SELECT output FROM analyses WHERE article_id=${id} ORDER BY id DESC LIMIT 1`;
  assert.equal(row!.output.classification.override, 'manual');
  assert.deepEqual(row!.output.calibration.categoryRuleIds, []);
});

test('manual non AI to AI routing cannot apply a non AI selection rule', async () => {
  const { articleId: id } = await upsertMaterial({ sourceId: source, url: `https://example.com/calibration-cross-ai-${T}`, title: `sportsmarker 人工智能重大模型正式发布 ${T}`, bodyText: `sportsmarker ${T} 机构正式披露重大人工智能模型与使用价格。`.repeat(20), bodyStatus: 'ok', via: 'ingest', publishedAt: new Date() });
  articleIds.push(id);
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,category,title_zh,summary_zh,selected,output) VALUES(${id},1,'rule','pass','policy','测试标题','测试摘要',false,${sql.json({ calibration: { policy } } as never)})`;
  await sql`INSERT INTO editorial_overrides(article_id,fields,reason) VALUES(${id},${sql.json({ category: 'ai' })},'人工跨路由分类')`;
  const result = await analyzeArticle(id);
  assert.equal(result?.output?.category, 'ai');
  assert.equal(result?.output?.selected, true);
  const [row] = await sql<{ output: Record<string, any> }[]>`SELECT output FROM analyses WHERE article_id=${id} ORDER BY id DESC LIMIT 1`;
  assert.deepEqual(row!.output.calibration.ruleIds, []);
});

test('manual AI to non AI routing cannot apply an AI selection rule to the fact representative', async () => {
  const { articleId: id } = await upsertMaterial({ sourceId: source, url: `https://example.com/calibration-cross-non-ai-${T}`, title: `vetomarker 全国重大金融监管新规正式生效 ${T}`, bodyText: `vetomarker ${T} 全国重大金融监管新规正式生效，机构披露执行时间、适用范围与公共影响。`.repeat(20), bodyStatus: 'ok', via: 'ingest', publishedAt: new Date() });
  articleIds.push(id);
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,category,title_zh,summary_zh,selected,output) VALUES(${id},1,'rule','pass','ai','测试标题','测试摘要',false,${sql.json({ calibration: { policy } } as never)})`;
  await sql`INSERT INTO editorial_overrides(article_id,fields,reason) VALUES(${id},${sql.json({ category: 'finance' })},'人工跨路由分类')`;
  const result = await analyzeArticle(id);
  assert.equal(result?.output?.category, 'finance');
  const [story] = await sql<{ id: number }[]>`INSERT INTO stories(public_id,title,first_report_at,latest_at) VALUES(${randomUUID()},'金融监管测试事件',now(),now()) RETURNING id`;
  storyIds.push(story!.id);
  const [fact] = await sql<{ id: number }[]>`INSERT INTO facts(public_id,story_id,title) VALUES(${`cal-cross-${T}`},${story!.id},'全国重大金融监管新规正式生效') RETURNING id`;
  factIds.push(fact!.id);
  await sql`INSERT INTO fact_articles(fact_id,article_id,role) VALUES(${fact!.id},${id},'primary')`;
  await publishArticle(id);
  const [row] = await sql<{ selected: boolean; details: Record<string, any> }[]>`SELECT d.selected,d.details FROM fact_editorial_state s JOIN editorial_decisions d ON d.id=s.decision_id WHERE s.fact_id=${fact!.id}`;
  assert.equal(row!.selected, true);
  assert.equal(row!.details.calibration, null);
});
