import { tag } from './setup.ts';
import assert from 'node:assert/strict';
import http from 'node:http';
import {MockAgent,setGlobalDispatcher,getGlobalDispatcher} from 'undici';
import { after,test } from 'node:test';
import { config } from '@aihot/backend/config';
import { sql,closeDb } from '@aihot/backend/db';
import { stopBoss } from '@aihot/backend/jobs/queue';
import { collectSource } from '@aihot/backend/sources/collect';
import { enrichCollectionItem,storeCollectionBatch } from '@aihot/backend/sources/intake';
const T=tag();
interface Item {id:string;title:string;date:string|null;detailDate?:string|null}
const lists=new Map<string,{items:Item[];version:number}>();const requests:number[]=[];
const firstTime=new Date(Date.now()-6*3600000).toISOString();
const server=http.createServer((req,res)=>{
 const path=req.url!;const list=lists.get(path);
 if(list){
  if(path.startsWith('/rss')){
   const status=req.headers['if-none-match']===`"v${list.version}"`?304:200; requests.push(status);
   res.writeHead(status,{'content-type':'application/rss+xml',etag:`"v${list.version}"`});
   res.end(status===304?'':`<rss version="2.0"><channel><title>测试</title>${list.items.map(i=>`<item><title>${i.title}</title><link>https://baseline.test/item/${i.id}</link>${i.date?`<pubDate>${new Date(i.date).toUTCString()}</pubDate>`:''}<description>摘要</description></item>`).join('')}</channel></rss>`);
  }else{
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(list.items.map(i=>({...i,url:`https://baseline.test/item/${i.id}`}))));
  }
  return;
 }
 const item=[...lists.values()].flatMap(l=>l.items).find(i=>path===`/item/${i.id}`);
 if(!item){res.writeHead(404);res.end();return;}
 res.writeHead(200,{'content-type':'text/html'});res.end(`<html><body><h1>${item.title}</h1>${item.detailDate?`<time datetime="${item.detailDate}"></time>`:''}<p>正文证据</p></body></html>`);
});
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;config.allowPrivateNetworkFetch=true;
const previousDispatcher=getGlobalDispatcher();
const mock=new MockAgent();mock.disableNetConnect();mock.enableNetConnect(/^127\.0\.0\.1(?::\d+)?$/);setGlobalDispatcher(mock);
mock.get('https://baseline.test').intercept({path:/^\/item\//,method:'GET'}).reply(200,opts=>{
 const item=[...lists.values()].flatMap(l=>l.items).find(i=>opts.path===`/item/${i.id}`)!;
 return `<html><body><h1>${item.title}</h1>${item.detailDate?`<time datetime="${item.detailDate}"></time>`:''}<p>正文证据</p></body></html>`;
},{headers:{'content-type':'text/html'}}).persist();
const sources:string[]=[];
after(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));await stopBoss();setGlobalDispatcher(previousDispatcher);await mock.close();await sql`DELETE FROM collection_intakes WHERE source_id=ANY(${sources})`;await sql`DELETE FROM articles WHERE source_id=ANY(${sources})`;await sql`DELETE FROM sources WHERE id=ANY(${sources})`;await closeDb();});
async function source(name:string,items:Item[],detail=false){
 const id=`baseline-${T}-${name}`;sources.push(id);const path=`/${detail?'json':'rss'}/${id}`;lists.set(path,{items,version:1});
 const settings=detail?{url:base+path,titlePaths:['title'],urlTemplate:'{raw:url}',publishedAtPath:'date',detail:{publishedAtSelector:'time',publishedAtAuthoritative:true,maxFetches:5}}:{feedUrl:base+path};
 await sql`INSERT INTO sources(id,name,kind,config,next_fetch_at) VALUES(${id},'基线测试',${detail?'json_list':'rss'},${sql.json({...settings,dailyNews:{migrationStatus:'verified',adapter:detail?'json_list':'rss',allowedHosts:['baseline.test'],legacySourceId:id,sectionId:'news',publisherKey:'publisher:'+id},_aihot:{initialBackfillLimit:2}} as never)},'2100-01-01')`;
 return {id,list:lists.get(path)!};
}
async function drain(id:string){
 const rows=await sql`SELECT b.id FROM collection_batches b JOIN collection_intakes r ON r.run_id=b.run_id WHERE r.source_id=${id} AND r.finished_at IS NULL ORDER BY b.id`;
 for(const b of rows)await storeCollectionBatch(Number(b.id));
 const items=await sql`SELECT i.id FROM collection_items i JOIN collection_batches b ON b.id=i.batch_id JOIN collection_intakes r ON r.run_id=b.run_id WHERE r.source_id=${id} AND i.completed_at IS NULL ORDER BY i.id`;
 for(const i of items)await enrichCollectionItem(Number(i.id));
}
for(const deferred of [false,true])test(`${deferred?'持久':'同步'}采集初导限制不会被第二轮历史绕过，保留旧稿修订并接受真实新稿和304`,async()=>{
 const old=Array.from({length:12},(_,i)=>({id:`${T}-${deferred}-old-${i}`,title:`旧稿${i}`,date:firstTime}));
 const {id,list}=await source(`rss-${deferred}`,old);
 const first=await collectSource(id,{deferred});if(deferred)await drain(id);assert.equal(first.status,'ok',first.error ?? 'collection failed');
 let rows=await sql`SELECT * FROM articles WHERE source_id=${id}`;assert.equal(rows.length,2);assert.ok(rows.every(a=>a.backfill_reason==='first-import'));
 const initialized=(await sql`SELECT cursor->>'initializedAt' AS initialized_at FROM sources WHERE id=${id}`)[0]!.initialized_at;
 old[0]!.title='旧稿更正';list.items=[...old,{id:`${T}-${deferred}-unknown`,title:'时间未知',date:null},{id:`${T}-${deferred}-future`,title:'未来错误',date:new Date(Date.now()+2*86400000).toISOString()},{id:`${T}-${deferred}-live`,title:'真实新稿',date:new Date(Date.now()+2000).toISOString()}];list.version++;
 const second=await collectSource(id,{deferred});if(deferred)await drain(id);assert.equal(second.status,'ok');
 rows=await sql`SELECT * FROM articles WHERE source_id=${id}`;assert.equal(rows.length,3);
 const live=rows.find(a=>a.title==='真实新稿')!;assert.ok(live);assert.equal(live.backfill,false);
 assert.equal(rows.find(a=>a.title==='旧稿更正')!.revision,2);assert.equal(rows.find(a=>a.title==='旧稿更正')!.backfill,true);
 assert.equal((await sql`SELECT cursor->>'initializedAt' AS initialized_at FROM sources WHERE id=${id}`)[0]!.initialized_at,initialized);
 const [run]=await sql`SELECT detail FROM fetch_runs WHERE source_id=${id} ORDER BY id DESC LIMIT 1`;assert.equal(run!.detail.baselineSkipped,12);
 const third=await collectSource(id,{deferred});assert.equal(third.found,0);assert.equal(third.created,0);assert.equal((await sql`SELECT count(*)::int n FROM articles WHERE source_id=${id}`)[0]!.n,3);
});
for(const deferred of [false,true])test(`${deferred?'持久':'同步'}权威详情覆盖伪新列表时间，详情缺日期不会猜成正常新增`,async()=>{
 const seed={id:`${T}-${deferred}-seed`,title:'初始稿',date:firstTime,detailDate:firstTime};
 const {id,list}=await source(`detail-${deferred}`,[seed],true);const initial=await collectSource(id,{deferred});assert.equal(initial.status,'ok',initial.error ?? 'collection failed');if(deferred)await drain(id);
 const newTime=new Date(Date.now()+2000).toISOString();
 list.items=[seed,{id:`${T}-${deferred}-real`,title:'详情真实新增',date:firstTime,detailDate:newTime},{id:`${T}-${deferred}-fake`,title:'列表伪新',date:newTime,detailDate:firstTime},{id:`${T}-${deferred}-nodate`,title:'详情无时间',date:newTime,detailDate:null}];
 await collectSource(id,{deferred});if(deferred)await drain(id);
 const rows=await sql`SELECT * FROM articles WHERE source_id=${id}`;
 assert.deepEqual(new Set(rows.map(a=>a.title)),new Set(['初始稿','详情真实新增']));assert.equal(rows.find(a=>a.title==='详情真实新增')!.backfill,false);
 const [run]=await sql`SELECT detail FROM fetch_runs WHERE source_id=${id} ORDER BY id DESC LIMIT 1`;assert.equal(run!.detail.baselineSkipped,2);
});
