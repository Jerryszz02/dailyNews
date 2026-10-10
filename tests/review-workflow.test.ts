import { tag } from './setup.ts';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import Fastify from 'fastify';
import { closeDb,sql } from '@aihot/backend/db';
import { config } from '@aihot/backend/config';
import { createReviewBatch,exportReview,reviewBatch,reviewCsv,reviewOverview,saveReviewAnswer,selectionGold,normalizeReviewAnswer,validateAnswer,stratifiedMaterials } from '@aihot/backend/admin/review';
import { registerAdmin } from '../apps/api/src/routes/admin.ts';
import { registerAdminAuth } from '../apps/api/src/routes/admin-auth.ts';
import { passwordLogin,SESSION_COOKIE,sessionPrincipal } from '@aihot/backend/admin/auth';

const T=tag();const source=`review-src-${T}`;const actor=`review-actor-${T}`;const ids=Array.from({length:12},(_,i)=>`review-${T}-${i}`);
const foreignId=`review-${T}-foreign`;
const allIds=[...ids,foreignId];
const old={dev:config.devAdmin,password:config.adminPassword};
const app=Fastify({logger:false}); registerAdminAuth(app);registerAdmin(app);
after(async()=>{
 config.devAdmin=old.dev;config.adminPassword=old.password;
 await app.close();
 await sql`DELETE FROM review_batches WHERE created_by=${actor}`;
 await sql`DELETE FROM audit_log WHERE actor=${actor}`;
 await sql`DELETE FROM articles WHERE id IN ${sql(allIds)}`;
 await sql`DELETE FROM sources WHERE id=${source}`;
 await closeDb();
});
let batchId='';
test('generates a category-stratified batch from current analyzed material, snapshots merged/unmerged pairs, idempotently',async()=>{
 await sql`INSERT INTO sources(id,name,kind,tier) VALUES(${source},'标注测试来源','rss','T1')`;
 const [story]=await sql`INSERT INTO stories(public_id,title,origin) VALUES(gen_random_uuid(),'测试事件','manual') RETURNING id`;
 for(let i=0;i<ids.length;i++){
  const id=ids[i]!; const category=['ai','finance','sports'][i%3]!;
  await sql`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at,body_text,body_status,published_at,language) VALUES(${id},${source},${id},${`https://example.test/${id}`},${`原文${i}`},now(),now(),'Original evidence','ok',now(),'en')`;
  const [n]=await sql`INSERT INTO analyses(article_id,input_revision,origin,category,title_zh,summary_zh,selected,score,policy_id,policy_version,input_signature,output) VALUES(${id},1,'rule',${category},${`标题${i}`},'摘要',false,60,'test','v1','test-signature',${sql.json({prefilter:category==='ai'?{label:i===0?'BLOCK':'PASS'}:null})}) RETURNING id`;
  if(i!==0) await sql`INSERT INTO publications(article_id,source_id,title,summary,category,channel,url,discovered_at,timeline_at,sort_at,input_revision,analysis_id,story_id) VALUES(${id},${source},${`标题${i}`},'摘要',${category},'news',${`https://example.test/${id}`},now(),now(),now(),1,${n!.id},${i===3||i===6?story!.id:null})`;
 }
 await sql`UPDATE articles SET discovered_at='2199-01-01',timeline_at='2199-01-01' WHERE id IN ${sql(ids)}`;
 // Shared-suite databases contain other categories. A later unrelated item must not make
 // this test mistake global sampling for a filter restricted to its own three categories.
 await sql`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at,body_text,body_status,published_at,language) VALUES(${foreignId},${source},${foreignId},${`https://example.test/${foreignId}`},'外来分类原文','2200-01-01','2200-01-01','Original evidence','ok',now(),'en')`;
 await sql`INSERT INTO analyses(article_id,input_revision,origin,category,title_zh,summary_zh) VALUES(${foreignId},1,'rule','science','外来分类新闻','摘要')`;
 const b={requestId:`batch-${T}`,count:10,label:'标注验证'};
 const first=await createReviewBatch(b,actor);batchId=first.batchId;
 assert.equal(first.created,true);
 const detail=await reviewBatch(batchId);assert.ok(detail);
 assert.equal(detail.tasks.length,10);
 const articleTasks=detail.tasks.filter(t=>t.kind==='article');
 assert.equal(new Set(articleTasks.slice(0,3).map(t=>t.stratum)).size,3,'category sampling must rotate before taking another item from a category');
 const material=articleTasks[0]!.snapshot.article;
 const isolated=Array.from({length:12},(_,i)=>({...material,articleId:`pure-${i}`,category:['ai','finance','sports'][i%3]!}));
 const stratified=stratifiedMaterials(isolated,8);
 assert.deepEqual(stratified.map(m=>m.category),['ai','finance','sports','ai','finance','sports','ai','finance']);
 assert.equal(articleTasks[0]!.snapshot.article.articleId,foreignId,'a real global pool includes unrelated categories before this test seed');
 assert.ok(detail.tasks.some(t=>t.snapshot.relationship==='merged'));
 assert.ok(detail.tasks.some(t=>t.snapshot.relationship==='unmerged'));
 assert.ok(detail.tasks.every(t=>t.mode==='assisted'&&t.version===0&&t.answer===null));
 assert.ok(articleTasks.filter(t=>t.snapshot.article.category==='ai').every(t=>['BLOCK','PASS'].includes(t.snapshot.article.aiRelevanceDecision!)));
 assert.ok(articleTasks.some(t=>t.snapshot.article.articleId===ids[0]&&t.snapshot.article.aiRelevanceDecision==='BLOCK'),'an unpublished blocked article remains in the labeling pool');
 assert.deepEqual(await createReviewBatch(b,actor),{batchId,created:false});
 await assert.rejects(createReviewBatch({...b,count:9},actor),/内容不同/);
 await sql`UPDATE articles SET revision=2,title='Changed title',body_text='Changed evidence' WHERE id=${detail.tasks[0]!.snapshot.article.articleId}`;
 assert.equal((await reviewBatch(batchId))!.tasks[0]!.snapshot.article.bodyOriginal,'Original evidence');
 assert.notEqual((await reviewBatch(batchId))!.tasks[0]!.snapshot.article.originalTitle,'Changed title');
 await sql`DELETE FROM stories WHERE id=${story!.id}`;
});
test('saves each judgment, retries once without duplicate revisions, detects stale versions, and never edits publications or receipts',async()=>{
 const detail=(await reviewBatch(batchId))!;const task=detail.tasks.find(t=>t.kind==='article'&&t.snapshot.article.category==='ai')!;
 const before=await sql`SELECT * FROM publications WHERE article_id=${task.snapshot.article.articleId}`;
 const [{n:receipts}]=await sql<{n:number}[]>`SELECT count(*)::int AS n FROM receipts`;
 const answer={classification:'ok',quality:'ok',selection:'reject',aiRelevance:'relevant',note:'我的判断'} as const;
 const b={requestId:`answer-${T}`,version:0,status:'completed' as const,answer};
 const saved=await saveReviewAnswer(task.id,b,actor);assert.equal(saved!.task.version,1);
 assert.deepEqual(saved!.task.answer,answer);
 assert.equal((await saveReviewAnswer(task.id,b,actor))!.task.version,1);
 assert.equal((await sql`SELECT * FROM review_revisions WHERE task_id=${task.id}`).length,1);
 await assert.rejects(saveReviewAnswer(task.id,{...b,requestId:`stale-${T}`},actor),/已被修改/);
 await assert.rejects(saveReviewAnswer(task.id,{...b,answer:{...answer,selection:'select'}},actor),/内容不同/);
 await assert.rejects(saveReviewAnswer(task.id,{...b,requestId:`incomplete-${T}`,version:1,answer:{classification:'ok'}},actor),/分别判断/);
 await assert.rejects(saveReviewAnswer(task.id,{...b,requestId:`change-${T}`,version:1,answer:{...answer,classification:'change'}},actor),/修改后的分类/);
 await assert.rejects(saveReviewAnswer(task.id,{...b,requestId:`badquality-${T}`,version:1,answer:{...answer,quality:'problem'}},actor),/至少一种问题/);
 await saveReviewAnswer(task.id,{...b,requestId:`revise-${T}`,version:1,answer:{...answer,selection:'select'}},actor);
 assert.equal((await sql`SELECT * FROM review_revisions WHERE task_id=${task.id}`).length,2);
 assert.deepEqual(await sql`SELECT * FROM publications WHERE article_id=${task.snapshot.article.articleId}`,before);
 assert.equal((await sql<{n:number}[]>`SELECT count(*)::int AS n FROM receipts`)[0]!.n,receipts);
 const rel=detail.tasks.find(t=>t.kind==='relation')!;
 await saveReviewAnswer(rel.id,{requestId:`relation-${T}`,version:0,status:'completed',answer:{relation:'uncertain'}},actor);
 const skipped=detail.tasks.find(t=>t.kind==='article'&&t.id!==task.id)!;
 await saveReviewAnswer(skipped.id,{requestId:`skip-${T}`,version:0,status:'skipped',answer:{}},actor);
 const progress=(await reviewBatch(batchId))!.progress;
 assert.equal(progress.completed,2);assert.equal(progress.skipped,1);assert.equal(progress.dimensions.relation!.uncertain,1);
 assert.equal(progress.dimensions.selection!.select,1);
});
test('exports full history and only completed AI selection judgments as assisted-development gold, CSV resists spreadsheet formulas',async()=>{
 const detail=(await reviewBatch(batchId))!;
 const json=JSON.parse((await exportReview('json',batchId)).content);
 assert.equal(json.tasks.length,10);assert.equal(json.revisions.length,4);assert.equal(json.mode,'assisted');
 const gold=selectionGold(detail.tasks);assert.equal(gold.length,1);assert.equal(gold[0]!.gold.decision,'select');
 assert.equal(gold[0]!.samplingContext.benchmarkSplit,'assisted-development');
 const jsonl=(await exportReview('gold',batchId)).content;assert.equal(JSON.parse(jsonl).caseId,gold[0]!.caseId);
 const csv=reviewCsv([{...detail.tasks[0]!,answer:{note:'=HYPERLINK("bad")'}}]);
 assert.ok(csv.includes("'=HYPERLINK"));
 assert.ok((await reviewOverview()).batches.some(b=>b.id===batchId));
});
test('admin review read/generate/save/export require login and writes require CSRF; invalid inputs rejected',async()=>{
 config.devAdmin=null;config.adminPassword=`test-review-password-${T}`;
 for(const url of ['/api/admin/review','/api/admin/review/export','/api/admin/review/batches/'+batchId]) assert.equal((await app.inject({url})).statusCode,401);
 const login=await passwordLogin(config.adminPassword,'/admin','test');
 const cookie=`${SESSION_COOKIE}=${login.token}`;const principal=(await sessionPrincipal(cookie))!;
 const task=(await reviewBatch(batchId))!.tasks[0]!;
 assert.equal((await app.inject({method:'POST',url:'/api/admin/review/batches',headers:{cookie},payload:{requestId:`auth-${T}`}})).statusCode,403);
 assert.equal((await app.inject({method:'POST',url:`/api/admin/review/tasks/${task.id}/answer`,headers:{cookie},payload:{}})).statusCode,403);
 assert.equal((await app.inject({method:'POST',url:'/api/admin/review/batches',headers:{cookie,'x-csrf-token':principal.csrf},payload:{requestId:'bad',count:100000}})).statusCode,400);
 const exported=await app.inject({url:'/api/admin/review/export?format=json&batchId='+batchId,headers:{cookie}});
 assert.equal(exported.statusCode,200);assert.match(exported.headers['content-disposition'] as string,/attachment/);
 assert.equal(exported.headers['cache-control'],'no-store');
 assert.equal((await app.inject({url:'/api/admin/review/export?format=garbage',headers:{cookie}})).statusCode,400);
});

test('simultaneous editors cannot overwrite answers; concurrent retry creates only one revision',async()=>{
 const detail=(await reviewBatch(batchId))!;
 const task=detail.tasks.find(t=>t.status==='pending'&&t.kind==='article')!;
 const payload={version:0,status:'completed' as const,answer:{classification:'uncertain' as const,quality:'uncertain' as const,selection:'uncertain' as const,aiRelevance:'uncertain' as const}};
 const writes=await Promise.allSettled([
  saveReviewAnswer(task.id,{...payload,requestId:`concurrent-a-${T}`},actor),
  saveReviewAnswer(task.id,{...payload,requestId:`concurrent-b-${T}`},actor),
 ]);
 assert.equal(writes.filter(w=>w.status==='fulfilled').length,1);
 assert.equal(writes.filter(w=>w.status==='rejected').length,1);
 assert.equal((await sql`SELECT * FROM review_revisions WHERE task_id=${task.id}`).length,1);
 const current=(await reviewBatch(batchId))!.tasks.find(t=>t.id===task.id)!;
 const retry={...payload,version:current.version,requestId:`concurrent-retry-${T}`};
 const saved=await Promise.all([saveReviewAnswer(task.id,retry,actor),saveReviewAnswer(task.id,retry,actor)]);
 assert.ok(saved.every(r=>r!.task.version===2));
 assert.equal((await sql`SELECT * FROM review_revisions WHERE task_id=${task.id}`).length,2);
});

test('a new material revision creates another independent task and cannot replace prior human judgment',async()=>{
 const before=(await reviewBatch(batchId))!.tasks.find(t=>t.kind==='article'&&t.status==='completed')!;
 const id=before.snapshot.article.articleId;
 const [{revision}]=await sql<{revision:number}[]>`UPDATE articles SET revision=revision+1,title='New version evidence' WHERE id=${id} RETURNING revision`;
 await sql`INSERT INTO analyses(article_id,input_revision,origin,category,title_zh,summary_zh) VALUES(${id},${revision!},'rule','science','新版本','新版本摘要')`;
 const b=await createReviewBatch({requestId:`new-version-${T}`,count:20},actor);
 const next=(await reviewBatch(b.batchId))!.tasks.find(t=>t.kind==='article'&&t.snapshot.article.articleId===id)!;
 assert.ok(next);assert.equal(next.snapshot.article.inputRevision,revision);assert.equal(next.status,'pending');assert.equal(next.answer,null);
 const preserved=(await reviewBatch(batchId))!.tasks.find(t=>t.id===before.id)!;
 assert.deepEqual(preserved.answer,before.answer);assert.equal(preserved.snapshot.article.inputRevision,before.snapshot.article.inputRevision);
});


test('normalizes obsolete dependent choices and rejects mixed task dimensions; uncertain category is not AI gold',async()=>{
 assert.deepEqual(normalizeReviewAnswer({classification:'ok',category:'finance',quality:'ok',qualityReasons:['contamination'],selection:'select'}),{classification:'ok',quality:'ok',selection:'select'});
 assert.throws(()=>validateAnswer('relation','completed',{relation:'same_event',classification:'ok'}),/只填写关系/);
 assert.throws(()=>validateAnswer('article','completed',{classification:'ok',quality:'ok',selection:'select',relation:'same_event'}),/不填写关系/);
 const t=(await reviewBatch(batchId))!.tasks.find(t=>t.kind==='article'&&t.snapshot.article.category==='ai')!;
 assert.equal(selectionGold([{...t,status:'completed',answer:{classification:'uncertain',quality:'ok',selection:'select'}}]).length,0);
 assert.equal(selectionGold([{...t,status:'completed',answer:{classification:'ok',quality:'ok',selection:'uncertain'}}])[0]!.gold.decision,'either');
 const current=(await reviewBatch(batchId))!.tasks.find(r=>r.id===t.id)!;
 const saved=await saveReviewAnswer(t.id,{requestId:`normalize-${T}`,version:current.version,status:'completed',answer:{classification:'ok',category:'finance',quality:'ok',qualityReasons:['contamination'],selection:'select',aiRelevance:'relevant'}},actor);
 assert.equal(saved!.task.answer!.category,undefined);assert.equal(saved!.task.answer!.qualityReasons,undefined);
});


test('AI relevance is independent of selection, required on new tasks, and preserved in exports',async()=>{
 const detail=(await reviewBatch(batchId))!;
 const task=detail.tasks.find(t=>t.kind==='article')!;
 assert.equal(task.snapshot.annotationVersion,2);
 const answer={classification:'ok',quality:'ok',selection:'reject'} as const;
 await assert.rejects(saveReviewAnswer(task.id,{requestId:`no-ai-relevance-${T}`,version:task.version,status:'completed',answer},actor),/单独判断/);
 const saved=await saveReviewAnswer(task.id,{requestId:`ai-relevance-${T}`,version:task.version,status:'completed',answer:{...answer,aiRelevance:'relevant'}},actor);
 assert.equal(saved!.task.answer!.selection,'reject');
 assert.equal(saved!.task.answer!.aiRelevance,'relevant','a relevant article can correctly be unselected');
 const exported=JSON.parse((await exportReview('json',batchId)).content);
 assert.equal(exported.tasks.find((t:{id:string})=>t.id===task.id).answer.aiRelevance,'relevant');
 assert.ok(exported.progress.dimensions.aiRelevance.relevant>=1);
 assert.ok((await exportReview('csv',batchId)).content.includes('"aiRelevance","aiRelevanceDecision"'));
 assert.doesNotThrow(()=>validateAnswer('article','completed',answer,1),'old tasks remain compatible without fabricated relevance labels');
 assert.throws(()=>validateAnswer('relation','completed',{relation:'same_event',aiRelevance:'relevant'},2),/只填写关系/);
});

test('assisted progress and exports never provide formal accuracy or false-block acceptance',async()=>{
 const expected={status:'not_ready',reason:'blind_holdout_required',classificationAccuracy:null,aiFalseBlockRate:null,minimumBlindArticles:200,minimumAiRelevant:50};
 assert.deepEqual((await reviewOverview()).progress.acceptance,expected);
 assert.deepEqual((await reviewBatch(batchId))!.progress.acceptance,expected);
 assert.deepEqual(JSON.parse((await exportReview('json',batchId)).content).progress.acceptance,expected);
});
