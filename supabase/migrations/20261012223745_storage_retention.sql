-- Replace the deployed six-argument API so default calls cannot become ambiguous.
-- No CASCADE: unexpected dependencies stop deployment for inspection.
drop function if exists public.daily_news_prune_retention(boolean, integer, integer, integer, integer, integer);
-- PostgreSQL does not automatically index the referencing side of foreign keys.
-- These small-pointer indexes keep deletion/reference checks bounded by matching rows.
create index if not exists report_snapshot_supersedes_idx on daily_news.report_snapshot(supersedes_report_id);
create index if not exists refresh_run_published_report_idx on daily_news.refresh_run(published_report_id);
create index if not exists article_candidate_last_run_idx on daily_news.article_candidate(last_run_id);
create index if not exists source_state_last_run_idx on daily_news.source_state(last_run_id);
create role daily_news_retention_executor nologin noinherit;
grant usage on schema daily_news to daily_news_retention_executor;
grant select on daily_news.report_snapshot, daily_news.refresh_run,
  daily_news.article_candidate, daily_news.runtime_state, daily_news.refresh_lease, daily_news.source_state
  to daily_news_retention_executor;
grant delete on daily_news.report_snapshot, daily_news.refresh_run,
  daily_news.article_candidate to daily_news_retention_executor;
grant update (supersedes_report_id) on daily_news.report_snapshot to daily_news_retention_executor;
grant update (published_report_id) on daily_news.refresh_run to daily_news_retention_executor;
create policy retention_snapshot on daily_news.report_snapshot to daily_news_retention_executor using (true) with check (true);
create policy retention_run on daily_news.refresh_run to daily_news_retention_executor using (true) with check (true);
create policy retention_candidate on daily_news.article_candidate to daily_news_retention_executor using (true);
create policy retention_runtime on daily_news.runtime_state for select to daily_news_retention_executor using (true);
create policy retention_source on daily_news.source_state for select to daily_news_retention_executor using (true);
create policy retention_lease on daily_news.refresh_lease for select to daily_news_retention_executor using (true);

create or replace function daily_news.reject_snapshot_mutation()
returns trigger language plpgsql set search_path = pg_catalog as $$
begin
  -- This identity cannot be selected by API roles; no session flag can bypass immutability.
  if current_user = 'daily_news_retention_executor' then
    if tg_op = 'DELETE' then return old; end if;
    if new.supersedes_report_id is null
       and (to_jsonb(new) - 'supersedes_report_id') = (to_jsonb(old) - 'supersedes_report_id') then
      return new;
    end if;
  end if;
  raise exception using errcode = '55000', message = 'daily_news report snapshots are immutable';
end;
$$;

create or replace function daily_news.sync_runtime_outcome_from_run()
returns trigger
language plpgsql
set search_path = pg_catalog, daily_news
as $$
declare
  terminal_outcome text;
begin
  if current_user = 'daily_news_retention_executor' then return new; end if;
  if new.status = 'published' then
    terminal_outcome := coalesce(
      nullif(lower(new.run_metrics #>> '{terminalResult,outcome}'), ''),
      nullif(lower(new.run_metrics ->> 'publishOutcome'), ''),
      'published'
    );
  elsif new.status = 'completed' then
    terminal_outcome := coalesce(
      nullif(lower(new.run_metrics #>> '{terminalResult,outcome}'), ''),
      nullif(lower(new.run_metrics ->> 'publishOutcome'), ''),
      nullif(lower(new.run_metrics ->> 'outcome'), ''),
      'unchanged'
    );
  elsif new.status in ('failed', 'rejected', 'skipped') then
    terminal_outcome := 'failed';
  else
    return new;
  end if;

  if terminal_outcome not in ('published', 'unchanged', 'partial', 'failed') then
    terminal_outcome := case when new.status = 'published' then 'published' else 'unchanged' end;
  end if;
  update daily_news.runtime_state
  set last_outcome_code = terminal_outcome,
      updated_at = clock_timestamp()
  where singleton_id;
  return new;
end;
$$;


create function public.daily_news_prune_retention(dry_run boolean default true, batch_limit integer default 25)
returns table(snapshot_count bigint, snapshot_payload_bytes bigint, candidate_count bigint,
  refresh_run_count bigint, detached_snapshot_links bigint, detached_run_links bigint)
language plpgsql security definer set search_path = pg_catalog, daily_news as $$
declare
  now_at timestamptz := clock_timestamp();
  latest_id uuid;
  rollback_id uuid;
  target_ids uuid[] := '{}';
  unlink_snapshots uuid[] := '{}';
  unlink_runs uuid[] := '{}';
  delete_snapshots uuid[] := '{}';
  candidate_ids text[] := '{}';
  run_ids uuid[] := '{}';
  lease_row daily_news.refresh_lease%rowtype;
begin
  if dry_run is null or batch_limit is null or batch_limit not between 1 and 250 then
    raise exception using errcode = '22023', message = 'dry_run and batch_limit (1..250) are required';
  end if;
  -- Same ordering as publication/rollback: global writer lock, then lease, then runtime.
  perform pg_advisory_xact_lock(78511490732164);
  select * into lease_row from daily_news.refresh_lease where singleton_id;
  if not dry_run and lease_row.run_id is not null and lease_row.lease_expires_at > now_at then
    raise exception using errcode = '55000', message = 'cannot prune retention while a refresh lease is active';
  end if;
  select latest_report_id into latest_id from daily_news.runtime_state where singleton_id;
  select supersedes_report_id into rollback_id from daily_news.report_snapshot where report_id = latest_id;
  select coalesce(array_agg(report_id), '{}'::uuid[]) into target_ids from (
    select s.report_id from daily_news.report_snapshot s
    join daily_news.refresh_run r on r.run_id = s.run_id
    where s.published_at < now_at - interval '3 days'
      and s.report_id is distinct from latest_id and s.report_id is distinct from rollback_id
      and r.status <> 'running' and r.finished_at is not null
      and s.run_id is distinct from lease_row.run_id
    order by s.published_at, s.report_id limit batch_limit
  ) targets;
  select coalesce(array_agg(report_id), '{}'::uuid[]) into unlink_snapshots from (
    select s.report_id from daily_news.report_snapshot s where s.supersedes_report_id = any(target_ids)
    order by s.report_id limit batch_limit
  ) targets;
  select coalesce(array_agg(run_id), '{}'::uuid[]) into unlink_runs from (
    select r.run_id from daily_news.refresh_run r where r.published_report_id = any(target_ids)
      and r.status <> 'running' and r.finished_at is not null and r.run_id is distinct from lease_row.run_id
    order by r.run_id limit batch_limit
  ) targets;
  select coalesce(array_agg(s.report_id), '{}'::uuid[]), count(*), coalesce(sum(pg_column_size(s.payload)),0)
    into delete_snapshots, snapshot_count, snapshot_payload_bytes
    from daily_news.report_snapshot s where s.report_id = any(target_ids)
      and not exists (select 1 from daily_news.report_snapshot child where child.supersedes_report_id = s.report_id
        and not(child.report_id = any(unlink_snapshots)))
      and not exists (select 1 from daily_news.refresh_run r where r.published_report_id = s.report_id
        and not(r.run_id = any(unlink_runs)));
  select coalesce(array_agg(candidate_id), '{}'::text[]) into candidate_ids from (
    select c.candidate_id from daily_news.article_candidate c
    where c.last_seen_at < now_at - case when c.quality_status = 'rejected' then interval '7 days' else interval '30 days' end
      and (lease_row.run_id is null or c.last_run_id is distinct from lease_row.run_id)
      and not exists(select 1 from daily_news.refresh_run r where r.run_id = c.last_run_id
        and (r.status = 'running' or r.finished_at is null))
    order by c.last_seen_at, c.candidate_id limit batch_limit
  ) targets;
  select coalesce(array_agg(run_id), '{}'::uuid[]) into run_ids from (
    select r.run_id from daily_news.refresh_run r where r.status <> 'running'
      and r.finished_at < now_at - case when r.status = 'failed' then interval '90 days' else interval '30 days' end
      and r.run_id is distinct from lease_row.run_id
      and not exists(select 1 from daily_news.report_snapshot s where s.run_id = r.run_id
        and not(s.report_id = any(delete_snapshots)))
      -- SET NULL would otherwise update unbounded candidate/source history.
      and not exists(select 1 from daily_news.article_candidate c where c.last_run_id = r.run_id
        and not(c.candidate_id = any(candidate_ids)))
      and not exists(select 1 from daily_news.source_state src where src.last_run_id = r.run_id)
    order by r.finished_at, r.run_id limit batch_limit
  ) targets;
  candidate_count := cardinality(candidate_ids);
  refresh_run_count := cardinality(run_ids);
  detached_snapshot_links := cardinality(unlink_snapshots);
  detached_run_links := cardinality(unlink_runs);
  if not dry_run then
    update daily_news.report_snapshot set supersedes_report_id = null where report_id = any(unlink_snapshots);
    update daily_news.refresh_run set published_report_id = null where run_id = any(unlink_runs);
    delete from daily_news.report_snapshot where report_id = any(delete_snapshots);
    delete from daily_news.article_candidate where candidate_id = any(candidate_ids);
    delete from daily_news.refresh_run where run_id = any(run_ids);
  end if;
  return next;
end;
$$;
-- Dedicated owner has only the columns needed by the bounded cleanup above.
do $$ begin
  execute format('grant daily_news_retention_executor to %I', current_user);
end $$;
grant usage, create on schema public to daily_news_retention_executor;
alter function public.daily_news_prune_retention(boolean, integer) owner to daily_news_retention_executor;
revoke create on schema public from daily_news_retention_executor;
revoke all on function public.daily_news_prune_retention(boolean, integer) from public, anon, authenticated;
grant execute on function public.daily_news_prune_retention(boolean, integer) to service_role;
comment on function public.daily_news_prune_retention(boolean, integer) is
'Default preview; explicit false applies one bounded batch. Protect 3 days, latest and its direct ancestor. Fresh databases create no schedule; deployed retention jobs are upgraded in place.';

-- Permit the trusted migration administrator to inspect/apply batches and own Cron jobs.
do $$ begin
  execute format('grant execute on function public.daily_news_prune_retention(boolean, integer) to %I', current_user);
  execute format('revoke daily_news_retention_executor from %I', current_user);
end $$;

-- Upgrade an already-running retention schedule only; never create/enable a job.
-- Leave servers without Cron untouched.
do $$
declare existing_job_id bigint;
begin
  if to_regclass('cron.job') is null then return; end if;
  for existing_job_id in execute
    'select jobid from cron.job where jobname = $1' using 'daily-news-retention'
  loop
    execute 'select cron.alter_job($1, $2, $3)' using existing_job_id,
      '*/15 * * * *', 'select * from public.daily_news_prune_retention(false, 250)';
  end loop;
end $$;
