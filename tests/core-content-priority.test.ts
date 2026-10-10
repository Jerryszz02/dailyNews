import { tag } from './setup.ts';
import assert from 'node:assert/strict';
import { after,test } from 'node:test';
import { sql,closeDb } from '@aihot/backend/db';
import { upsertMaterial,isHistorical } from '@aihot/backend/content/materials';
import { queueProcessing,settleNonEditorial } from '@aihot/backend/jobs/content';
import { getBoss,stopBoss,QUEUES } from '@aihot/backend/jobs/queue';
const T=tag();const source=`priority-${T}`,signal=`priority-signal-${T}`,queue=`priority-test-${T}`;
const ids:string[]=[];
after(async()=>{
 const boss=await getBoss();await boss.deleteQueue(queue);
 await sql`DELETE FROM pgboss.job WHERE data->>'articleId'=ANY(${ids})`;
 await sql`DELETE FROM articles WHERE id=ANY(${ids})`;
 await sql`DELETE FROM sources WHERE id IN (${source},${signal})`;
 await stopBoss();await closeDb();
});
async function material(s:string,name:string,backfill:string|null){
 const result=await upsertMaterial({sourceId:s,url:`https://example.test/${T}/${name}`,title:name,bodyText:'Source material',bodyStatus:'ok',publishedAt:new Date(Date.now()-3600000),backfill,via:'fetch'});
 ids.push(result.articleId);return result.articleId;
}
async function job(id:string,name:string){return (await sql`SELECT id,priority,state,created_on FROM pgboss.job WHERE name=${name} AND data->>'articleId'=${id} ORDER BY created_on DESC LIMIT 1`)[0]!;}
test('recent first import waits behind normal increments; pg-boss really fetches live first and public/event historical semantics stay intact',async()=>{
 await sql`INSERT INTO sources(id,name,kind,participation_mode,next_fetch_at) VALUES(${source},'Priority editorial','rss','editorial','2100-01-01'),(${signal},'Priority signal','rss','hot_signal','2100-01-01')`;
 const recent=await material(source,'first-import','first-import');
 const normal=await material(source,'incremental',null);
 await queueProcessing(recent);await queueProcessing(normal);
 const first=await job(recent,QUEUES.analyze),live=await job(normal,QUEUES.analyze);
 assert.equal(first.priority,-2);assert.equal(live.priority,0);
 const [stored]=await sql`SELECT backfill,published_at,discovered_at FROM articles WHERE id=${recent}`;
 assert.equal(isHistorical(stored as {backfill:boolean;published_at:Date|null;discovered_at:Date}),false,'recent imported material keeps its original event eligibility');
 const boss=await getBoss();await boss.createQueue(queue,{policy:'short'});
 await boss.send(queue,{articleId:recent},{priority:Number(first.priority),singletonKey:recent});
 await boss.send(queue,{articleId:normal},{priority:Number(live.priority),singletonKey:normal});
 const fetched=await boss.fetch<{articleId:string}>(queue,{batchSize:1,includeMetadata:true});
 assert.equal(fetched[0]!.data.articleId,normal,'newer live job overtakes older first-import job');
 await boss.complete(queue,fetched[0]!.id);
 assert.equal((await boss.fetch<{articleId:string}>(queue,{batchSize:1}))[0]!.data.articleId,recent);
 await queueProcessing(recent,{step:'extract'});await queueProcessing(normal,{step:'extract'});
 assert.equal((await job(recent,QUEUES.extractBody)).priority,-2);assert.equal((await job(normal,QUEUES.extractBody)).priority,0);
 const importedSignal=await material(signal,'signal-first-import','first-import');
 const liveSignal=await material(signal,'signal-live',null);
 await queueProcessing(importedSignal);await queueProcessing(liveSignal);
 assert.equal((await job(importedSignal,QUEUES.group)).priority,-2);assert.equal((await job(liveSignal,QUEUES.group)).priority,-1);
 assert.deepEqual(await settleNonEditorial(importedSignal),{group:true},'deferred imported signal retains event semantics');
});
