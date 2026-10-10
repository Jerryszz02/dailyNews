import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { isCategoryKey } from '@aihot/contracts/taxonomy';
import type { CalibrationCandidate, CalibrationExample, CalibrationOverview } from '@aihot/contracts/calibration';
import type { ReviewMaterial, ReviewTask } from '@aihot/contracts/review';
import { sql, type Db } from '../db.ts';
import { audit, Conflict } from '../audit.ts';
import { sha256, stableJson } from '../lib/ids.ts';
import { trainCalibration, evaluateCalibration } from '../editorial/calibration.ts';
import { rawReviewTasks, stratifiedMaterials } from './review.ts';

const TARGET = 200;
const requestId = z.string().min(8).max(120).regex(/^[\w-]+$/);
const requestSchema = z.object({requestId}).strict();
const actionSchema = z.object({requestId,expectedActiveId:z.string().nullable(),reason:z.string().trim().min(1).max(500)}).strict();
const activateSchema = actionSchema.extend({candidateId:z.string().min(1).max(100)});
const bad = (message: string): never => {throw Object.assign(new Error(message),{statusCode:400});};

/** Known event links, exact titles, copies and URLs are held together, across revisions/sources. */
function eventKeys(m: ReviewMaterial): string[] {
  const keys = [`article:${m.articleId}`];
  if (m.storyId != null) keys.push(`story:${m.storyId}`);
  if (m.factId != null) keys.push(`fact:${m.factId}`);
  const title = m.originalTitle.toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
  if (title.length >= 16) keys.push(`title:${sha256(title)}`);
  const body = (m.bodyOriginal ?? '').toLowerCase().replace(/\s+/g,' ').trim();
  if (body.length >= 120) keys.push(`body:${sha256(body)}`);
  try {const u = new URL(m.url);u.hash='';for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$)/i.test(k)) u.searchParams.delete(k);keys.push(`url:${u.href}`);} catch { /* saved evidence may lack a parseable URL */ }
  return keys;
}
export function calibrationSample(pool: ReviewMaterial[], seen: ReviewMaterial[], seed: string): Array<{material:ReviewMaterial;eventKey:string;split:'train'|'holdout'}> {
  const parent = new Map<string,string>();
  const find = (key:string):string => {const p=parent.get(key);if(!p){parent.set(key,key);return key;}if(p===key)return key;const root=find(p);parent.set(key,root);return root;};
  for (const m of [...pool,...seen]) {const keys=eventKeys(m);const root=find(keys[0]!);for(const key of keys.slice(1)) {const other=find(key);if(other!==root)parent.set(other,root);}}
  const excluded=new Set(seen.map(m=>find(eventKeys(m)[0]!)));
  const groups=new Map<string,ReviewMaterial[]>();
  for(const m of pool){const key=find(eventKeys(m)[0]!);if(excluded.has(key))continue;const g=groups.get(key)??[];g.push(m);groups.set(key,g);}
  const rank=(m:ReviewMaterial)=>sha256(`${seed}:${m.articleId}`);
  const representatives=[...groups.values()].map(g=>g.sort((a,b)=>rank(a).localeCompare(rank(b)))[0]!).sort((a,b)=>rank(a).localeCompare(rank(b)));
  // Rotate categories, with seeded order within each category. Never sample only selected stories.
  const chosen=stratifiedMaterials(representatives,TARGET);
  // Allocate holdout within each category. Every fifth item of a round-robin list would
  // otherwise put only two of ten categories into holdout.
  const strata=new Map<string,ReviewMaterial[]>();
  for(const m of chosen){const key=m.category??'unclassified';const group=strata.get(key)??[];group.push(m);strata.set(key,group);}
  const quotas=[...strata.entries()].map(([key,items])=>({key,items,n:Math.floor(items.length/5),remainder:items.length%5}));
  let missing=Math.floor(chosen.length/5)-quotas.reduce((n,g)=>n+g.n,0);
  for(const group of [...quotas].sort((a,b)=>b.remainder-a.remainder||a.key.localeCompare(b.key)))if(missing>0&&group.remainder){group.n++;missing--;}
  const holdout=new Set(quotas.flatMap(g=>g.items.sort((a,b)=>sha256(`holdout:${seed}:${a.articleId}`).localeCompare(sha256(`holdout:${seed}:${b.articleId}`))).slice(0,g.n).map(m=>m.articleId)));
  return chosen.sort((a,b)=>sha256(`display:${seed}:${a.articleId}`).localeCompare(sha256(`display:${seed}:${b.articleId}`)))
    .map(material=>({material,eventKey:sha256(find(eventKeys(material)[0]!)),split:holdout.has(material.articleId)?'holdout':'train'}));
}

async function state(db:Db=sql) {const [s]=await db<{batch_id:string;active_candidate_id:string|null;frozen:boolean}[]>`SELECT * FROM review_calibration_state WHERE id=1`;return s;}
export async function calibrationOverview(db:Db=sql):Promise<CalibrationOverview> {
  const s=await state(db);
  if(!s)return {batchId:null,target:200,completed:0,total:0,train:0,holdout:0,candidate:null,activeCandidateId:null,frozen:false};
  const [counts]=await db<{total:number;completed:number;train:number;holdout:number}[]>`SELECT count(*)::int AS total,count(*) FILTER(WHERE t.status='completed')::int AS completed,count(*) FILTER(WHERE m.split='train')::int AS train,count(*) FILTER(WHERE m.split='holdout')::int AS holdout FROM review_calibration_members m JOIN review_tasks t ON t.id=m.task_id WHERE m.batch_id=${s.batch_id}`;
  const [candidate]=await db<CalibrationCandidate[]>`SELECT id,policy,report,created_at AS "createdAt" FROM review_calibration_candidates WHERE batch_id=${s.batch_id} ORDER BY created_at DESC,id DESC LIMIT 1`;
  return {batchId:s.batch_id,target:200,...counts!,candidate:candidate??null,activeCandidateId:s.active_candidate_id,frozen:s.frozen};
}

/** A singleton reservation makes repeated clicks/retries resume the same one-off experiment. */
export async function createCalibration(input:unknown,actor:string) {
  const b=requestSchema.parse(input);
  return sql.begin(async tx=>{
    await tx`SELECT pg_advisory_xact_lock(hashtext('manual-review-generation'))`;
    const existing=await state(tx);if(existing)return {batchId:existing.batch_id,created:false};
    const seen=(await tx<{snapshot:ReviewTask['snapshot']}[]>`SELECT snapshot FROM review_tasks`).flatMap(r=>[r.snapshot.article,...(r.snapshot.related?[r.snapshot.related]:[])]);
    const rows=await tx<ReviewMaterial[]>`SELECT a.id AS "articleId",a.revision AS "inputRevision",n.id AS "analysisId",n.input_signature AS "inputSignature",
      coalesce(nullif(p.title,''),nullif(n.title_zh,''),a.title) AS title,a.title AS "originalTitle",coalesce(p.summary,n.summary_zh) AS summary,
      coalesce(a.body_text,a.excerpt) AS "bodyOriginal",tr.body_text AS "bodyZh",a.url,s.name AS "sourceName",s.kind AS "sourceKind",s.tier AS "sourceTier",s.first_party AS "firstParty",a.language,
      a.published_at AS "publishedAt",coalesce(p.category,n.category) AS category,
      CASE WHEN coalesce(p.category,n.category)='ai' THEN coalesce(p.selected,n.selected) ELSE p.selected END AS selected,coalesce(p.score,n.score) AS score,
      n.output->'prefilter'->>'label' AS "aiRelevanceDecision",n.model,n.policy_id AS "policyId",n.policy_version AS "policyVersion",a.backfill,a.body_status AS "bodyStatus",st.title AS "storyTitle",st.id AS "storyId",fa.fact_id AS "factId"
      FROM articles a JOIN sources s ON s.id=a.source_id
      JOIN LATERAL(SELECT * FROM analyses x WHERE x.article_id=a.id AND x.input_revision=a.revision ORDER BY id DESC LIMIT 1)n ON true
      LEFT JOIN publications p ON p.article_id=a.id AND p.input_revision=a.revision AND p.analysis_id=n.id
      LEFT JOIN translations tr ON tr.article_id=a.id AND tr.revision=a.revision
      LEFT JOIN LATERAL(SELECT f.id AS fact_id,f.story_id FROM fact_articles x JOIN facts f ON f.id=x.fact_id WHERE x.article_id=a.id AND x.role IN ('primary','report') ORDER BY (x.role='primary') DESC,x.created_at LIMIT 1)fa ON true
      LEFT JOIN stories st ON st.id=coalesce(fa.story_id,p.story_id)
      WHERE a.x_post IS NULL AND length(coalesce(a.body_text,a.excerpt,''))>=80
      ORDER BY row_number() OVER(PARTITION BY coalesce(p.category,n.category) ORDER BY a.discovered_at DESC,a.id),a.discovered_at DESC,a.id LIMIT 5000`;
    const chosen=calibrationSample(JSON.parse(JSON.stringify(rows)),seen,b.requestId);
    if(chosen.length<TARGET)bad(`去除已标注及重复事件后只有 ${chosen.length} 条可用材料，需要 200 条；未建立不完整批次，请等待新闻更新后重试`);
    const id=`calibration-${randomUUID()}`;
    await tx`INSERT INTO review_batches(id,request_id,request_hash,label,mode,created_by) VALUES(${id},${b.requestId},${sha256(stableJson(b))},'一次性校准','blind',${actor})`;
    for(const [position,item] of chosen.entries()){
      const m=item.material;const taskId=randomUUID();
      await tx`INSERT INTO review_tasks(id,batch_id,position,kind,mode,stratum,snapshot_key,snapshot) VALUES(${taskId},${id},${position},'article','blind',${m.category??'unclassified'},${`article:${m.articleId}:${m.inputRevision}:${m.analysisId}`},${tx.json({article:m,annotationVersion:3} as never)})`;
      await tx`INSERT INTO review_calibration_members(task_id,batch_id,split,event_key) VALUES(${taskId},${id},${item.split},${item.eventKey})`;
    }
    await tx`INSERT INTO review_calibration_state(id,batch_id) VALUES(1,${id})`;
    await audit(actor,'review.calibration.prepare',`review:${id}`,null,null,{total:200,train:160,holdout:40},{db:tx,requestId:b.requestId});
    return {batchId:id,created:true};
  });
}

export function calibrationExample(t:ReviewTask):CalibrationExample {
  const m=t.snapshot.article;const a=t.status==='completed'?t.answer:null;
  const category=a?.classification==='change'?a.category:a?.classification==='ok'?m.category:null;
  return {id:t.id,title:m.originalTitle,body:m.bodyOriginal??'',category:m.category,selected:m.selected,
    goldCategory:isCategoryKey(category)?category:null,goldSelected:a?.selection==='select'?true:a?.selection==='reject'?false:null};
}
export async function evaluateReviewCalibration(input:unknown,actor:string):Promise<CalibrationOverview> {
  const b=requestSchema.parse(input);
  await sql.begin(async tx=>{
    const [s]=await tx`SELECT * FROM review_calibration_state WHERE id=1 FOR UPDATE`;
    if(!s)bad('请先准备这轮 200 条校准');
    if(s!.frozen)return;
    const tasks=await rawReviewTasks(s!.batch_id,tx);
    if(tasks.length!==200||tasks.some(t=>t.status!=='completed'))bad('请先完成这轮 200 条；跳过、稍后和未保存的任务不计完成');
    const hash=sha256(stableJson(tasks.map(t=>({id:t.id,version:t.version,answer:t.answer,snapshot:t.snapshot}))));
    const members=await tx<{task_id:string;split:'train'|'holdout'}[]>`SELECT task_id,split FROM review_calibration_members WHERE batch_id=${s!.batch_id}`;
    const split=new Map(members.map(m=>[m.task_id,m.split]));
    const train=tasks.filter(t=>split.get(t.id)==='train').map(calibrationExample);
    const holdout=tasks.filter(t=>split.get(t.id)==='holdout').map(calibrationExample);
    const id=`candidate-${randomUUID()}`;
    const policy=trainCalibration(train,id);
    const report=evaluateCalibration(policy,train.length,holdout);
    const heldoutTasks=tasks.filter(t=>split.get(t.id)==='holdout');
    const relevant=heldoutTasks.filter(t=>t.answer?.aiRelevance==='relevant');
    report.diagnostics={
      excludedCategories:tasks.filter(t=>!isCategoryKey(calibrationExample(t).goldCategory)).length,
      uncertainSelections:tasks.filter(t=>calibrationExample(t).goldSelected===null).length,
      qualityProblems:tasks.filter(t=>t.answer?.quality==='problem').length,
      holdoutAiRelevant:relevant.length,
      holdoutAiFalseBlocks:relevant.filter(t=>t.snapshot.article.aiRelevanceDecision==='BLOCK').length,
      holdoutAiUnrecorded:heldoutTasks.filter(t=>!t.snapshot.article.aiRelevanceDecision).length,
    };
    await tx`INSERT INTO review_calibration_candidates(id,batch_id,request_id,labels_hash,policy,report) VALUES(${id},${s!.batch_id},${b.requestId},${hash},${tx.json(policy as never)},${tx.json(report as never)})`;
    await tx`UPDATE review_calibration_state SET frozen=true WHERE id=1`;
    await audit(actor,'review.calibration.evaluate',`calibration:${id}`,null,null,{labelsHash:hash,train:train.length,holdout:holdout.length,passed:report.passed},{db:tx,requestId:b.requestId});
  });
  return calibrationOverview();
}

export async function activateCalibration(input:unknown,actor:string):Promise<CalibrationOverview> {
  const b=activateSchema.parse(input);
  return changeActive(b,actor,b.candidateId);
}
export async function rollbackCalibration(input:unknown,actor:string):Promise<CalibrationOverview> {
  const b=actionSchema.parse(input);
  return changeActive(b,actor,null);
}
async function changeActive(b:z.infer<typeof actionSchema>,actor:string,candidateId:string|null):Promise<CalibrationOverview> {
  const hash=sha256(stableJson({...b,candidateId}));
  await sql.begin(async tx=>{
    const [s]=await tx`SELECT * FROM review_calibration_state WHERE id=1 FOR UPDATE`;
    if(!s)bad('尚未建立校准批次');
    const [prior]=await tx`SELECT request_hash FROM review_calibration_actions WHERE request_id=${b.requestId}`;
    if(prior){if(prior.request_hash!==hash)throw new Conflict('同一请求编号的内容不同');return;}
    if(s!.active_candidate_id!==b.expectedActiveId)throw new Conflict('启用版本已变化，请刷新后再操作');
    if(candidateId){
      const [candidate]=await tx`SELECT batch_id,report FROM review_calibration_candidates WHERE id=${candidateId}`;
      if(!candidate||candidate.batch_id!==s!.batch_id||candidate.report.passed!==true||!s!.frozen)bad('只有本轮已冻结且通过验证的候选才能启用');
    }
    await tx`UPDATE review_calibration_state SET active_candidate_id=${candidateId} WHERE id=1`;
    await tx`INSERT INTO review_calibration_actions(request_id,request_hash) VALUES(${b.requestId},${hash})`;
    await audit(actor,candidateId?'review.calibration.activate':'review.calibration.rollback',`review:${s!.batch_id}`,b.reason,{activeCandidateId:s!.active_candidate_id},{activeCandidateId:candidateId},{db:tx,requestId:b.requestId});
  });
  return calibrationOverview();
}
