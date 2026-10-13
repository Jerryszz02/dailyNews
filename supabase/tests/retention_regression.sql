-- Plain PostgreSQL regression, no pgTAP required. Apply legacy migrations first.
-- Run only against an isolated _test database; all fixtures roll back.
begin;
DO $$
begin
  if current_database() !~ '(_test|_ci)$' then raise exception 'isolated _test/_ci database required'; end if;
end $$;
-- Existing data is intentionally rejected, not removed.
DO $$ begin
 if exists(select 1 from daily_news.refresh_run) then raise exception 'empty fixture database required'; end if;
end $$;
insert into daily_news.refresh_run(run_id,idempotency_key,trigger_kind,scheduled_at,lease_owner,fencing_token,status,finished_at)
select ('00000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid, 'retention-'||i, 'local',
  clock_timestamp() - interval '100 days', gen_random_uuid(), 1,
  case when i = 9 then 'running' when i in (7,8) then 'failed' else 'published' end,
  case when i=9 then null when i=7 then clock_timestamp()-interval '89 days' else clock_timestamp()-interval '100 days' end
from generate_series(1,9) i;
insert into daily_news.report_snapshot(report_id,run_id,generated_at,published_at,schema_version,content_hash,payload,data_as_of,supersedes_report_id)
select ('10000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,
 ('00000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,
 clock_timestamp()-interval '100 days',
 case when i=5 then clock_timestamp()-interval '2 days' else clock_timestamp()-interval '100 days' end,
 '2',repeat('a',64),'{}',clock_timestamp(),
 case when i=1 then null else ('10000000-0000-4000-8000-'||lpad((i-1)::text,12,'0'))::uuid end
from generate_series(1,6) i;
update daily_news.refresh_run r set published_report_id=s.report_id from daily_news.report_snapshot s where s.run_id=r.run_id;
-- Roll back latest to an old version: protect 3 and actual ancestor 2, not newest 6.
update daily_news.runtime_state set latest_report_id='10000000-0000-4000-8000-000000000003';
insert into daily_news.source_state(source_id) values('retention-fixture');
insert into daily_news.article_candidate(candidate_id,source_id,canonical_url,title,discovered_at,content_fingerprint,payload,last_seen_at,quality_status,last_run_id)
select 'c'||i,'retention-fixture','https://example.com/'||i,'fixture',clock_timestamp(), 'hash','{}',
 clock_timestamp()-make_interval(days=>case when i in(1,4) then 31 when i=2 then 8 when i=3 then 6 else 29 end),
 case when i in(2,3) then 'rejected' else 'accepted' end,
 case when i=4 then '00000000-0000-4000-8000-000000000009'::uuid else null end
from generate_series(1,5) i;
DO $$
declare preview record; applied record; baseline timestamptz;
begin
 if has_function_privilege('anon','public.daily_news_prune_retention(boolean,integer)','execute')
 or has_function_privilege('authenticated','public.daily_news_prune_retention(boolean,integer)','execute')
 or pg_has_role('service_role','daily_news_retention_executor','MEMBER') then raise exception 'cleanup privilege leak'; end if;
 perform set_config('daily_news.retention_prune','on',true);
 begin
   delete from daily_news.report_snapshot where report_id='10000000-0000-4000-8000-000000000001';
   raise exception 'immutability bypassed';
 exception when sqlstate '55000' then null; end;
 select * into preview from public.daily_news_prune_retention();
 if preview.snapshot_count<>3 or preview.candidate_count<>2 or preview.refresh_run_count<>4 then
   raise exception 'bad preview: %',row_to_json(preview); end if;
 if (select count(*) from daily_news.report_snapshot)<>6 then raise exception 'preview mutated'; end if;
 select updated_at into baseline from daily_news.runtime_state;
 select * into applied from public.daily_news_prune_retention(false);
 if row_to_json(preview)::jsonb<>row_to_json(applied)::jsonb then raise exception 'preview differs from application'; end if;
 if (select updated_at from daily_news.runtime_state) is distinct from baseline then raise exception 'cleanup changed publication state'; end if;
 if (select array_agg(report_id order by report_id) from daily_news.report_snapshot) is distinct from
 array['10000000-0000-4000-8000-000000000002'::uuid,'10000000-0000-4000-8000-000000000003'::uuid,'10000000-0000-4000-8000-000000000005'::uuid] then raise exception 'wrong protected snapshots'; end if;
 if (select supersedes_report_id from daily_news.report_snapshot where report_id='10000000-0000-4000-8000-000000000003') is distinct from '10000000-0000-4000-8000-000000000002'::uuid then raise exception 'rollback ancestor lost'; end if;
 if not exists(select 1 from daily_news.refresh_run where idempotency_key='retention-7')
 or exists(select 1 from daily_news.refresh_run where idempotency_key='retention-8') then raise exception 'failed retention wrong'; end if;
 if not exists(select 1 from daily_news.article_candidate where candidate_id='c4') then raise exception 'running data deleted'; end if;
 select * into applied from public.daily_news_prune_retention(false);
 if applied.snapshot_count<>0 or applied.candidate_count<>0 or applied.refresh_run_count<>0 then raise exception 'cleanup not idempotent'; end if;
 update daily_news.refresh_lease set run_id='00000000-0000-4000-8000-000000000009',lease_owner=gen_random_uuid(),lease_expires_at=clock_timestamp()+interval '1 hour' where singleton_id;
 perform public.daily_news_prune_retention(); -- preview is allowed during active work
 begin
   perform public.daily_news_prune_retention(false);
   raise exception 'active cleanup allowed';
 exception when sqlstate '55000' then null; end;
end $$;
rollback;

begin;
insert into daily_news.refresh_run(run_id,idempotency_key,trigger_kind,scheduled_at,lease_owner,fencing_token,status,finished_at)
select ('20000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,'batch-'||i,'local',clock_timestamp(),gen_random_uuid(),1,'published',clock_timestamp()-interval '100 days'
from generate_series(1,4) i;
insert into daily_news.report_snapshot(report_id,run_id,generated_at,published_at,schema_version,content_hash,payload,data_as_of)
select ('30000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,
 ('20000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,clock_timestamp(),
 case when i=4 then clock_timestamp()-interval '3 days'+interval '1 minute' else clock_timestamp()-interval '4 days' end,
 '2',repeat('b',64),'{}',clock_timestamp() from generate_series(1,4) i;
update daily_news.refresh_run r set published_report_id=s.report_id from daily_news.report_snapshot s where s.run_id=r.run_id;
-- A single root latest has no ancestor; it stays indefinitely.
update daily_news.runtime_state set latest_report_id='30000000-0000-4000-8000-000000000001';
insert into daily_news.source_state(source_id) values('batch-fixture');
insert into daily_news.article_candidate(candidate_id,source_id,canonical_url,title,discovered_at,content_fingerprint,payload,last_seen_at)
select 'batch-c'||i,'batch-fixture','https://example.com/batch/'||i,'fixture',clock_timestamp(),'hash','{}',clock_timestamp()-interval '31 days' from generate_series(1,3) i;
DO $$
declare result record; n integer;
begin
 for n in 1..3 loop
   select * into result from public.daily_news_prune_retention(false,1);
   if greatest(result.snapshot_count,result.candidate_count,result.refresh_run_count,result.detached_snapshot_links,result.detached_run_links)>1 then raise exception 'batch exceeded'; end if;
 end loop;
 if (select count(*) from daily_news.report_snapshot)<>2
 or not exists(select 1 from daily_news.report_snapshot where report_id='30000000-0000-4000-8000-000000000001')
 or not exists(select 1 from daily_news.report_snapshot where report_id='30000000-0000-4000-8000-000000000004') then raise exception 'root latest or 3-day window lost'; end if;
 if exists(select 1 from daily_news.article_candidate) then raise exception 'candidate batches not drained'; end if;
end $$;
rollback;
