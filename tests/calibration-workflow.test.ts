import {tag} from './setup.ts';
import assert from 'node:assert/strict';
import {after,test} from 'node:test';
import Fastify from 'fastify';
import {sql,closeDb} from '@aihot/backend/db';
import {config} from '@aihot/backend/config';
import {calibrationSample,calibrationOverview,createCalibration,evaluateReviewCalibration,activateCalibration,rollbackCalibration} from '@aihot/backend/admin/calibration';
import {exportReview,rawReviewTasks,reviewBatch,saveReviewAnswer} from '@aihot/backend/admin/review';
import {loadActiveCalibration} from '@aihot/backend/editorial/calibration';
import {registerAdmin} from '../apps/api/src/routes/admin.ts';
import {registerAdminAuth} from '../apps/api/src/routes/admin-auth.ts';
import {passwordLogin,SESSION_COOKIE,sessionPrincipal} from '@aihot/backend/admin/auth';
import type {ReviewMaterial} from '@aihot/contracts/review';
import {CATEGORY_KEYS} from '@aihot/contracts/taxonomy';

const T=tag();const source=`calibration-src-${T}`;const actor=`calibration-actor-${T}`;
const old={dev:config.devAdmin,password:config.adminPassword};
const app=Fastify({logger:false});registerAdminAuth(app);registerAdmin(app);
let batchId='';let candidateId='';
after(async()=>{
 config.devAdmin=old.dev;config.adminPassword=old.password;await app.close();
 if(batchId){await sql`DELETE FROM review_calibration_state WHERE batch_id=${batchId}`;await sql`DELETE FROM review_calibration_members WHERE batch_id=${batchId}`;await sql`DELETE FROM review_calibration_candidates WHERE batch_id=${batchId}`;await sql`DELETE FROM review_batches WHERE id=${batchId}`;}
 await sql`DELETE FROM review_calibration_actions WHERE request_id LIKE ${`%${T}%`}`;
 await sql`DELETE FROM audit_log WHERE actor=${actor}`;
 await sql`DELETE FROM articles WHERE source_id=${source}`;await sql`DELETE FROM sources WHERE id=${source}`;await closeDb();
});
const material=(i:number):ReviewMaterial=>({articleId:`m-${i}`,inputRevision:1,analysisId:i,inputSignature:null,title:`unique title number ${i}`,originalTitle:`unique title number ${i}`,summary:null,bodyOriginal:`Evidence for item ${i}.`,bodyZh:null,url:`https://example.test/news/${i}`,sourceName:'test',sourceKind:'rss',sourceTier:'T1',firstParty:false,language:'en',publishedAt:null,category:CATEGORY_KEYS[i%10]!,selected:i%2===0,score:80,model:null,policyId:null,policyVersion:null,backfill:false,bodyStatus:'ok',storyTitle:null,factId:null,storyId:null});

test('stratifies train and holdout across ten categories, joins event aliases and excludes previously exposed events',()=>{
 const pool=Array.from({length:210},(_,i)=>material(i));
 const sample=calibrationSample(pool,[],'seed');
 assert.equal(sample.length,200);assert.equal(sample.filter(x=>x.split==='holdout').length,40);
 for(const key of CATEGORY_KEYS)assert.equal(sample.filter(x=>x.split==='holdout'&&x.material.category===key).length,4);
 assert.deepEqual(calibrationSample(pool,[],'seed'),sample);
 const aliases=[{...material(500),storyId:1,factId:1},{...material(501),storyId:1,factId:2},{...material(502),factId:2}];
 assert.equal(calibrationSample(aliases,[],'seed').length,1);
 assert.equal(calibrationSample(aliases,[{...material(700),storyId:1}],'seed').length,0);
 const copies=[material(800),{...material(801),originalTitle:material(800).originalTitle}];
 assert.equal(calibrationSample(copies,[],'seed').length,1);
});

test('prepares exactly 200 article-only blind tasks once and never exposes baseline in reads or exports',async()=>{
 assert.equal((await calibrationOverview()).batchId,null);
 await sql`INSERT INTO sources(id,name,kind,tier) VALUES(${source},'校准来源','rss','T1')`;
 for(let i=0;i<200;i++){
  const id=`${source}-${i}`;const category=i%2===0?'ai':'finance';
  await sql`INSERT INTO articles(id,source_id,identity_key,url,title,body_text,body_status,discovered_at,timeline_at,published_at) VALUES(${id},${source},${id},${`https://example.test/${id}`},${`football detailed report ${i}`},${`football international match unique item ${i}. `.repeat(5)},'ok',now(),now(),now())`;
  const [n]=await sql`INSERT INTO analyses(article_id,input_revision,origin,category,title_zh,summary_zh,selected,score) VALUES(${id},1,'rule',${category},${`赛事消息${i}`},'双方公布比赛结果',true,90) RETURNING id`;
  await sql`INSERT INTO publications(article_id,source_id,title,summary,category,channel,url,discovered_at,timeline_at,sort_at,input_revision,analysis_id,selected) VALUES(${id},${source},${`赛事消息${i}`},'双方公布比赛结果',${category},'news',${`https://example.test/${id}`},now(),now(),now(),1,${n!.id},true)`;
 }
 const created=await createCalibration({requestId:`prepare-${T}`},actor);batchId=created.batchId;
 assert.equal(created.created,true);
 assert.deepEqual(await createCalibration({requestId:`prepare-again-${T}`},actor),{batchId,created:false});
 const detail=(await reviewBatch(batchId))!;assert.equal(detail.tasks.length,200);
 assert(detail.tasks.every(t=>t.mode==='blind'&&t.kind==='article'&&t.status==='pending'&&t.answer===null));
 assert(detail.tasks.every(t=>t.snapshot.article.category===null&&t.snapshot.article.selected===null&&t.stratum==='blind'));
 assert.equal(detail.progress.byCategory.length,1);
 const exported=JSON.parse((await exportReview('json',batchId)).content);
 assert.equal(exported.mode,'blind');assert(exported.tasks.every((t:any)=>t.snapshot.article.score===null));
 assert.equal((await exportReview('gold',batchId)).content,'');
 const overview=await calibrationOverview();assert.equal(overview.train,160);assert.equal(overview.holdout,40);assert.equal(overview.candidate,null);
 await assert.rejects(evaluateReviewCalibration({requestId:`early-${T}`},actor),/200/);
 const t=detail.tasks[0]!;
 await assert.rejects(saveReviewAnswer(t.id,{requestId:`invalid-${T}`,version:0,status:'completed',answer:{classification:'ok',quality:'ok',aiRelevance:'relevant',selection:'reject'}},actor),/盲标/);
});

test('all saved human answers feed a frozen candidate, remain immutable, and make no model receipts',async()=>{
 const [{n:before}]=await sql<{n:number}[]>`SELECT count(*)::int AS n FROM receipts`;
 const tasks=await rawReviewTasks(batchId);
 for(const t of tasks){
  const saved=await saveReviewAnswer(t.id,{requestId:`answer-${T}-${t.position}`,version:0,status:'completed',answer:{classification:'change',category:t.snapshot.article.category==='ai'?'ai':'sports',quality:'ok',selection:'reject',aiRelevance:t.snapshot.article.category==='ai'?'relevant':'irrelevant'}},actor);
  assert.equal(saved!.task.snapshot.article.category,null);
 }
 const overview=await evaluateReviewCalibration({requestId:`evaluate-${T}`},actor);
 assert.equal(overview.completed,200);assert.equal(overview.frozen,true);assert(overview.candidate);
 assert.equal(overview.candidate.report.passed,true);assert.equal(overview.candidate.report.holdout,40);
 assert.equal(overview.candidate.report.category.candidateErrors,0);candidateId=overview.candidate.id;
 assert.equal((await evaluateReviewCalibration({requestId:`evaluate-again-${T}`},actor)).candidate!.id,candidateId);
 assert.equal((await sql`SELECT * FROM review_calibration_candidates WHERE batch_id=${batchId}`).length,1);
 assert.equal(await loadActiveCalibration(),null,'evaluation does not activate itself');
 await assert.rejects(saveReviewAnswer(tasks[0]!.id,{requestId:`frozen-${T}`,version:1,status:'completed',answer:{classification:'change',category:'ai',quality:'ok',selection:'select',aiRelevance:'relevant'}},actor),/冻结/);
 assert.equal((await sql<{n:number}[]>`SELECT count(*)::int AS n FROM receipts`)[0]!.n,before);
});

test('activation and rollback are explicit, gated, audited, version checked and idempotent',async()=>{
 const activate={requestId:`activate-${T}`,candidateId,expectedActiveId:null,reason:'验证后应用到后续新闻'};
 assert.equal((await activateCalibration(activate,actor)).activeCandidateId,candidateId);
 assert.equal((await activateCalibration(activate,actor)).activeCandidateId,candidateId);
 assert.equal((await loadActiveCalibration())!.id,candidateId);
 await assert.rejects(activateCalibration({...activate,reason:'改动同一请求'},actor),/内容不同/);
 await assert.rejects(rollbackCalibration({requestId:`stale-${T}`,expectedActiveId:null,reason:'撤回'},actor),/版本已变化/);
 const rollback={requestId:`rollback-${T}`,expectedActiveId:candidateId,reason:'停止后续应用'};
 assert.equal((await rollbackCalibration(rollback,actor)).activeCandidateId,null);
 assert.equal((await rollbackCalibration(rollback,actor)).activeCandidateId,null);
 assert.equal(await loadActiveCalibration(),null);
 const [candidate]=await sql`SELECT report FROM review_calibration_candidates WHERE id=${candidateId}`;
 await sql`UPDATE review_calibration_candidates SET report=${sql.json({...candidate!.report,passed:false})} WHERE id=${candidateId}`;
 await assert.rejects(activateCalibration({...activate,requestId:`fail-gate-${T}`},actor),/通过验证/);
 await sql`UPDATE review_calibration_candidates SET report=${sql.json(candidate!.report)} WHERE id=${candidateId}`;
 assert.equal((await sql`SELECT * FROM audit_log WHERE actor=${actor} AND action IN ('review.calibration.activate','review.calibration.rollback')`).length,2);
});

test('calibration admin routes require session and CSRF, reject invalid inputs',async()=>{
 config.devAdmin=null;config.adminPassword=`test-calibration-password-${T}`;
 assert.equal((await app.inject({url:'/api/admin/review/calibration'})).statusCode,401);
 for(const path of ['','/evaluate','/activate','/rollback'])assert.equal((await app.inject({method:'POST',url:'/api/admin/review/calibration'+path,payload:{}})).statusCode,401);
 const login=await passwordLogin(config.adminPassword,'/admin','test');const cookie=`${SESSION_COOKIE}=${login.token}`;const principal=(await sessionPrincipal(cookie))!;
 assert.equal((await app.inject({method:'POST',url:'/api/admin/review/calibration/evaluate',headers:{cookie},payload:{requestId:`auth-${T}`}})).statusCode,403);
 assert.equal((await app.inject({method:'POST',url:'/api/admin/review/calibration',headers:{cookie,'x-csrf-token':principal.csrf},payload:{requestId:`invalid-api-${T}`,count:20}})).statusCode,400);
 assert.equal((await app.inject({url:'/api/admin/review/calibration',headers:{cookie}})).statusCode,200);
});
