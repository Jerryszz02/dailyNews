-- Plain regression for the bounded retention follow-up. Fixtures/temporary grants roll back.
begin;
DO $$ begin
 if current_database() !~ '(_test|_ci)$' then raise exception 'isolated _test/_ci database required'; end if;
end $$;
insert into daily_news.refresh_run(run_id,idempotency_key,trigger_kind,scheduled_at,lease_owner,fencing_token,status,finished_at)
values('61000000-0000-4000-8000-000000000001','retention-acl','local',now(),gen_random_uuid(),1,'published',now());
insert into daily_news.report_snapshot(report_id,run_id,generated_at,schema_version,content_hash,payload,data_as_of)
values('62000000-0000-4000-8000-000000000001','61000000-0000-4000-8000-000000000001',now(),'2',repeat('a',64),'{}',now());
DO $$ begin
 begin
  perform public.daily_news_prune_retention(false,26);
  raise exception 'oversized batch accepted';
 exception when sqlstate '22023' then null; end;
end $$;
set local role daily_news_retention_executor;
-- Current column ACL prevents a payload write before the trigger even runs.
DO $$ begin
 begin
  update daily_news.report_snapshot set payload='{"changed":true}' where report_id='62000000-0000-4000-8000-000000000001';
  raise exception 'immutable payload accepted';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
-- If permissions are broadened accidentally, the trigger still rejects mutation.
grant update(payload) on daily_news.report_snapshot to daily_news_retention_executor;
set local role daily_news_retention_executor;
DO $$ begin
 begin
  update daily_news.report_snapshot set payload='{"changed":true}' where report_id='62000000-0000-4000-8000-000000000001';
  raise exception 'expanded ACL bypassed immutable trigger';
 exception when sqlstate '55000' then null; end;
end $$;
reset role;
rollback;
