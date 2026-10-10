import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CATEGORIES } from '@aihot/industry/taxonomy';
import type { ReviewAnswer, ReviewBatch, ReviewBatchDetail, ReviewCreate, ReviewMaterial, ReviewOverview, ReviewProgress, ReviewSave, ReviewTask } from '@aihot/contracts/review';
import { sql, type Db } from '../db.ts';
import { audit, Conflict } from '../audit.ts';
import { sha256, stableJson } from '../lib/ids.ts';

const requestId = z.string().min(8).max(120).regex(/^[\w-]+$/);
const createSchema = z.object({ requestId, count: z.number().int().min(1).max(100).default(20), label: z.string().trim().min(1).max(100).default('本地新闻人工验收') }).strict();
const answerSchema = z.object({
  classification: z.enum(['ok','change','uncertain']).optional(), category: z.string().max(40).optional(),
  quality: z.enum(['ok','problem','uncertain']).optional(),
  qualityReasons: z.array(z.enum(['fact_translation','number_unit','qualification','attribution','contamination','other'])).max(6).optional(),
  aiRelevance: z.enum(['relevant','irrelevant','uncertain']).optional(),
  selection: z.enum(['select','reject','uncertain']).optional(), relation: z.enum(['same_event','development','unrelated','uncertain']).optional(), note: z.string().max(4000).optional(),
}).strict();
const saveSchema = z.object({ requestId, version: z.number().int().nonnegative(), status: z.enum(['completed','skipped','later']), answer: answerSchema }).strict();
const bad = (message: string): never => { throw Object.assign(new Error(message), { statusCode: 400 }); };

/** Round robin across every existing category; no source-label-only or selected-only filter. */
export function stratifiedMaterials(rows: ReviewMaterial[], count: number): ReviewMaterial[] {
  const groups = new Map<string, ReviewMaterial[]>();
  for (const row of rows) { const key = row.category ?? 'unclassified'; const group = groups.get(key) ?? []; group.push(row); groups.set(key,group); }
  const out: ReviewMaterial[] = [];
  while (out.length < count) {
    let moved = false;
    for (const group of groups.values()) { const row = group.shift(); if (row) { out.push(row); moved = true; if (out.length === count) break; } }
    if (!moved) break;
  }
  return out;
}
const identity = (m: ReviewMaterial) => `${m.articleId}:${m.inputRevision}:${m.analysisId}`;
const keyFor = (a: ReviewMaterial, b?: ReviewMaterial) => b ? `relation:${[identity(a),identity(b)].sort().join('|')}:${a.factId}:${a.storyId}:${b.factId}:${b.storyId}` : `article:${identity(a)}`;
const taskColumns = sql`id, batch_id AS "batchId", position, kind, mode, stratum, snapshot, version, status, answer, updated_at AS "updatedAt", created_at AS "createdAt"`;
/** Baseline decisions and strata never cross the API boundary for a blind task. */
export function publicReviewTask(task: ReviewTask): ReviewTask {
  if (task.mode !== 'blind') return task;
  const hide = (m: ReviewMaterial): ReviewMaterial => ({...m,category:null,selected:null,score:null,model:null,
    policyId:null,policyVersion:null,inputSignature:null,aiRelevanceDecision:null,storyTitle:null,factId:null,storyId:null});
  return {...task,stratum:'blind',snapshot:{...task.snapshot,article:hide(task.snapshot.article),
    ...(task.snapshot.related ? {related:hide(task.snapshot.related)} : {})}};
}
export async function rawReviewTasks(batchId: string, db: Db = sql): Promise<ReviewTask[]> {
  return db<ReviewTask[]>`SELECT ${taskColumns} FROM review_tasks WHERE batch_id=${batchId} ORDER BY position`;
}
async function taskById(id: string, db: Db = sql): Promise<ReviewTask | null> {
  const [row] = await db<ReviewTask[]>`SELECT ${taskColumns} FROM review_tasks WHERE id=${id}`;
  return row ?? null;
}
function progress(tasks: ReviewTask[]): ReviewProgress {
  // Completion alone is not formal acceptance; calibration has its own smaller holdout report.
  const p: ReviewProgress = {total:tasks.length,completed:0,pending:0,skipped:0,later:0,byCategory:[],dimensions:{},
    acceptance:{status:'not_ready',reason:'blind_holdout_required',classificationAccuracy:null,aiFalseBlockRate:null,minimumBlindArticles:200,minimumAiRelevant:50}};
  const cats = new Map<string,{category:string;total:number;completed:number}>();
  for (const t of tasks) {
    p[t.status]++;
    const c = cats.get(t.stratum) ?? {category:t.stratum,total:0,completed:0}; c.total++; if (t.status === 'completed') c.completed++; cats.set(t.stratum,c);
    if (t.status === 'completed' && t.answer) for (const k of ['classification','quality','aiRelevance','selection','relation'] as const) {
      const value = t.answer[k]; if (value) { const d = p.dimensions[k] ?? {}; d[value] = (d[value] ?? 0)+1; p.dimensions[k] = d; }
    }
  }
  p.byCategory = [...cats.values()]; return p;
}
export async function reviewOverview(): Promise<ReviewOverview> {
  const batches = await sql<ReviewBatch[]>`SELECT b.id,b.label,b.mode,b.created_at AS "createdAt",count(t.id)::int AS count FROM review_batches b LEFT JOIN review_tasks t ON t.batch_id=b.id GROUP BY b.id ORDER BY b.created_at DESC LIMIT 100`;
  const tasks = await sql<ReviewTask[]>`SELECT ${taskColumns} FROM review_tasks ORDER BY created_at`;
  return {batches,progress:progress(tasks.map(publicReviewTask))};
}
export async function reviewBatch(id: string): Promise<ReviewBatchDetail | null> {
  const [batch] = await sql<ReviewBatch[]>`SELECT b.id,b.label,b.mode,b.created_at AS "createdAt",count(t.id)::int AS count FROM review_batches b LEFT JOIN review_tasks t ON t.batch_id=b.id WHERE b.id=${id} GROUP BY b.id`;
  if (!batch) return null;
  const tasks = (await rawReviewTasks(id)).map(publicReviewTask);
  return {batch,tasks,progress:progress(tasks)};
}
export async function createReviewBatch(input: ReviewCreate, actor: string) {
  const b = createSchema.parse(input); const hash = sha256(stableJson(b));
  return sql.begin(async tx => {
    // Serializes batch reservation, avoiding simultaneous generation of the same materials.
    await tx`SELECT pg_advisory_xact_lock(hashtext('manual-review-generation'))`;
    const [existing] = await tx`SELECT id,request_hash FROM review_batches WHERE request_id=${b.requestId}`;
    if (existing) { if (existing.request_hash !== hash) throw new Conflict('同一请求编号的内容不同'); return {batchId:existing.id as string,created:false}; }
    const rows = await tx<ReviewMaterial[]>`
      SELECT a.id AS "articleId",a.revision AS "inputRevision",n.id AS "analysisId",n.input_signature AS "inputSignature",
       coalesce(p.title,n.title_zh,a.title) AS title,a.title AS "originalTitle",coalesce(p.summary,n.summary_zh) AS summary,
       coalesce(a.body_text,a.excerpt) AS "bodyOriginal",tr.body_text AS "bodyZh",a.url,s.name AS "sourceName",s.kind AS "sourceKind",s.tier AS "sourceTier",s.first_party AS "firstParty",a.language,
       a.published_at AS "publishedAt",coalesce(p.category,n.category) AS category,coalesce(p.selected,n.selected) AS selected,coalesce(p.score,n.score) AS score,
       n.output->'prefilter'->>'label' AS "aiRelevanceDecision",n.model,n.policy_id AS "policyId",n.policy_version AS "policyVersion",a.backfill,a.body_status AS "bodyStatus",st.title AS "storyTitle",p.fact_id AS "factId",p.story_id AS "storyId"
      FROM articles a JOIN sources s ON s.id=a.source_id
      JOIN LATERAL (SELECT * FROM analyses x WHERE x.article_id=a.id AND x.input_revision=a.revision ORDER BY x.id DESC LIMIT 1) n ON true
      LEFT JOIN publications p ON p.article_id=a.id AND p.input_revision=a.revision AND p.analysis_id=n.id
      LEFT JOIN translations tr ON tr.article_id=a.id AND tr.revision=a.revision
      LEFT JOIN stories st ON st.id=p.story_id
      WHERE NOT EXISTS (SELECT 1 FROM review_tasks rt WHERE rt.snapshot_key='article:'||a.id||':'||a.revision||':'||n.id)
      ORDER BY row_number() OVER(PARTITION BY coalesce(p.category,n.category) ORDER BY a.discovered_at DESC,a.id), a.discovered_at DESC,a.id LIMIT 1000`;
    const pool = rows.map(r => JSON.parse(JSON.stringify(r)) as ReviewMaterial);
    if (!pool.length) bad('暂无新的已分析文章，请先完成新闻更新；已有任务可继续标注');
    const relationSlots = b.count >= 5 ? Math.min(4,Math.floor(b.count/5)) : 0;
    const used = new Set((await tx<{snapshot_key:string}[]>`SELECT snapshot_key FROM review_tasks WHERE kind='relation'`).map(r=>r.snapshot_key));
    const pairs: Array<{a:ReviewMaterial;b:ReviewMaterial;relationship:'merged'|'unmerged'}> = [];
    for (const merged of [true,false]) {
      let n = 0;
      for (let i=0;i<pool.length && n<Math.ceil(relationSlots/2);i++) {
        const a=pool[i]!;
        const other=pool.slice(i+1).find(r => {
          const same = (a.factId !== null && a.factId===r.factId) || (a.storyId !== null && a.storyId===r.storyId);
          // Unmerged candidates share a category and nearby source times, never a fabricated relationship.
          const near = Math.abs(new Date(a.publishedAt ?? 0).getTime()-new Date(r.publishedAt ?? 0).getTime())<3*86400000;
          return same===merged && (merged || (a.category===r.category && near)) && !used.has(keyFor(a,r));
        });
        if (other) {pairs.push({a,b:other,relationship:merged?'merged':'unmerged'});used.add(keyFor(a,other));n++;}
      }
    }
    const articles = stratifiedMaterials([...pool],b.count-Math.min(relationSlots,pairs.length));
    const id = `review-${randomUUID()}`;
    await tx`INSERT INTO review_batches(id,request_id,request_hash,label,mode,created_by) VALUES(${id},${b.requestId},${hash},${b.label},'assisted',${actor})`;
    let position=0;
    for (const a of articles) await tx`INSERT INTO review_tasks(id,batch_id,position,kind,mode,stratum,snapshot_key,snapshot) VALUES(${randomUUID()},${id},${position++},'article','assisted',${a.category ?? 'unclassified'},${keyFor(a)},${tx.json({article:a,annotationVersion:2} as never)})`;
    for (const pair of pairs.slice(0,Math.min(relationSlots,b.count-articles.length))) await tx`INSERT INTO review_tasks(id,batch_id,position,kind,mode,stratum,snapshot_key,snapshot) VALUES(${randomUUID()},${id},${position++},'relation','assisted',${`relation-${pair.relationship}`},${keyFor(pair.a,pair.b)},${tx.json({article:pair.a,related:pair.b,relationship:pair.relationship,annotationVersion:2} as never)})`;
    await audit(actor,'review.generate',`review:${id}`,null,null,{count:position,mode:'assisted'},{db:tx,requestId:b.requestId});
    return {batchId:id,created:true};
  });
}
export async function saveReviewAnswer(id: string, input: ReviewSave, actor: string): Promise<{task:ReviewTask} | null> {
  const b=saveSchema.parse(input); b.answer=normalizeReviewAnswer(b.answer); const hash=sha256(stableJson({id,...b}));
  return sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`manual-review-request:${b.requestId}`}))`;
    const [prior]=await tx`SELECT task_id,request_hash FROM review_revisions WHERE request_id=${b.requestId}`;
    if (prior) { if (prior.task_id!==id || prior.request_hash!==hash) throw new Conflict('同一请求编号的内容不同'); return {task:publicReviewTask((await taskById(id,tx))!)}; }
    const initial = await taskById(id,tx);
    if (initial?.mode === 'blind') {
      const [state] = await tx`SELECT frozen FROM review_calibration_state WHERE batch_id=${initial.batchId} FOR UPDATE`;
      if (state?.frozen) throw new Conflict('这轮标注已冻结用于验证，可以回看；原答案不会被覆盖');
    }
    await tx`SELECT id FROM review_tasks WHERE id=${id} FOR UPDATE`;
    const t=await taskById(id,tx); if (!t) return null;
    if(t.version!==b.version) throw new Conflict('标注已被修改，请刷新后再保存；当前选择尚未写入');
    validateAnswer(t.kind,b.status,b.answer,t.snapshot.annotationVersion ?? 1);
    await tx`INSERT INTO review_revisions(task_id,version,request_id,request_hash,status,answer,actor) VALUES(${id},${t.version+1},${b.requestId},${hash},${b.status},${tx.json(b.answer as never)},${actor})`;
    await tx`UPDATE review_tasks SET version=version+1,status=${b.status},answer=${tx.json(b.answer as never)},updated_at=now() WHERE id=${id}`;
    await audit(actor,'review.answer',`review-task:${id}`,null,{version:t.version,status:t.status},{version:t.version+1,status:b.status},{db:tx,requestId:b.requestId});
    return {task:publicReviewTask((await taskById(id,tx))!)};
  });
}
/** Remove dependent choices when a reviewer changes their parent judgment. */
export function normalizeReviewAnswer(input: ReviewAnswer): ReviewAnswer {
  const answer = {...input};
  if (answer.classification !== 'change') delete answer.category;
  if (answer.quality !== 'problem') delete answer.qualityReasons;
  return answer;
}
export function validateAnswer(kind: string,status: string,a: ReviewAnswer,annotationVersion=1) {
  if (a.category && ![...CATEGORIES.map(c=>c.key),'unrelated','insufficient'].includes(a.category)) bad('请选择有效分类');
  if (status !== 'completed') return;
  if (kind==='relation') {
    if(!a.relation) bad('请选择新闻关系');
    if(a.classification || a.quality || a.selection || a.aiRelevance) bad('关系任务只填写关系判断');
    return;
  }
  if(a.relation) bad('文章任务不填写关系判断');
  if(annotationVersion>=3 && a.classification==='ok') bad('盲标请直接选择分类，不能确认未展示的系统分类');
  if (!a.classification || !a.quality || !a.selection) bad('请分别判断分类、标题摘要和精选');
  if(a.classification==='change'&&!a.category) bad('请选择修改后的分类');
  if(a.quality==='problem'&&!a.qualityReasons?.length) bad('请选择至少一种问题');
  if(annotationVersion>=2&&!a.aiRelevance) bad('请单独判断是否与人工智能相关；这不同于是否值得精选');
}
export function selectionGold(tasks: ReviewTask[]) {
  return tasks.filter(t=>t.mode==='assisted'&&t.kind==='article'&&t.status==='completed'&&t.answer?.classification!=='uncertain'&&(t.answer?.classification==='change'?t.answer.category:t.snapshot.article.category)==='ai'&&t.answer?.selection).map(t=>{
    const m=t.snapshot.article;
    return {caseId:t.id,material:{title:m.title,originalTitle:m.originalTitle,publishedAt:m.publishedAt,sourceName:m.sourceName,bodyZh:m.bodyZh,bodyOriginal:m.bodyOriginal},sourceFacts:{sourceKind:m.sourceKind,sourceTier:m.sourceTier,firstParty:m.firstParty,language:m.language},samplingContext:{benchmarkSplit:'assisted-development',samplingStratum:t.stratum,annotationMode:t.mode,eventGroup:m.storyId ?? m.factId ?? m.articleId},gold:{decision:t.answer!.selection==='uncertain'?'either':t.answer!.selection}};
  });
}
export function reviewCsv(tasks: ReviewTask[], revisions: Array<Record<string, unknown>> = []) {
  const cell=(v:unknown)=>{let s=typeof v==='object'&&v!==null?JSON.stringify(v):String(v??'');if(/^[=+@\-\t\r]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
  const rows=[['taskId','kind','mode','status','version','articleId','inputRevision','title','category','classification','correctedCategory','quality','qualityReasons','aiRelevance','aiRelevanceDecision','selection','relation','note','snapshot','answer','createdAt','updatedAt','revisionHistory'],...tasks.map(t=>[t.id,t.kind,t.mode,t.status,t.version,t.snapshot.article.articleId,t.snapshot.article.inputRevision,t.snapshot.article.title,t.snapshot.article.category,t.answer?.classification,t.answer?.category,t.answer?.quality,t.answer?.qualityReasons,t.answer?.aiRelevance,t.snapshot.article.aiRelevanceDecision,t.answer?.selection,t.answer?.relation,t.answer?.note,t.snapshot,t.answer,t.createdAt,t.updatedAt,revisions.filter(r=>r.task_id===t.id)])];
  return '\ufeff'+rows.map(r=>r.map(cell).join(',')).join('\r\n');
}
export async function exportReview(format: string,batchId?:string) {
  if(!['json','csv','gold'].includes(format))bad('导出格式应为 json/csv/gold');
  const tasks=(await sql<ReviewTask[]>`SELECT ${taskColumns} FROM review_tasks WHERE (${batchId ?? null}::text IS NULL OR batch_id=${batchId ?? null}) ORDER BY batch_id,position`).map(publicReviewTask);
  if(format==='gold')return {content:selectionGold(tasks).map(r=>JSON.stringify(r)).join('\n'),type:'application/x-ndjson; charset=utf-8',extension:'jsonl'};
  const revisions=await sql`SELECT r.* FROM review_revisions r JOIN review_tasks t ON t.id=r.task_id WHERE (${batchId ?? null}::text IS NULL OR t.batch_id=${batchId ?? null}) ORDER BY r.task_id,r.version`;
  if(format==='csv')return {content:reviewCsv(tasks,revisions),type:'text/csv; charset=utf-8',extension:'csv'};
  const modes=new Set(tasks.map(t=>t.mode));
  return {content:JSON.stringify({schemaVersion:2,exportedAt:new Date().toISOString(),mode:modes.size>1?'mixed':tasks[0]?.mode??'assisted',progress:progress(tasks),tasks,revisions},null,2),type:'application/json; charset=utf-8',extension:'json'};
}
