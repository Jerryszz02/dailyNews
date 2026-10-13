-- Bound durable history so immutable report payloads cannot exhaust the database.

create or replace function daily_news.reject_snapshot_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if current_setting('daily_news.retention_prune', true) = 'on'
     and current_user = (
       select pg_get_userbyid(relation.relowner)
       from pg_class as relation
       where relation.oid = tg_relid
     ) then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  raise exception using
    errcode = '55000',
    message = 'daily_news report snapshots are immutable';
end;
$$;

create function public.daily_news_prune_retention(
  dry_run boolean default true,
  snapshot_retention_days integer default 7,
  minimum_snapshots integer default 2,
  accepted_candidate_retention_days integer default 30,
  rejected_candidate_retention_days integer default 7,
  refresh_run_retention_days integer default 30
)
returns table (
  snapshot_count bigint,
  snapshot_payload_bytes bigint,
  candidate_count bigint,
  refresh_run_count bigint
)
language plpgsql
security definer
set search_path = pg_catalog, daily_news
as $$
declare
  now_at timestamptz := clock_timestamp();
  latest_id uuid;
  snapshot_ids uuid[] := '{}'::uuid[];
  active_lease daily_news.refresh_lease%rowtype;
begin
  if dry_run is null
     or snapshot_retention_days not between 7 and 90
     or minimum_snapshots not between 2 and 100
     or accepted_candidate_retention_days not between 30 and 365
     or rejected_candidate_retention_days not between 7 and 365
     or refresh_run_retention_days not between 30 and 365 then
    raise exception using
      errcode = '22023',
      message = 'retention arguments are outside their safe bounds';
  end if;

  perform pg_advisory_xact_lock(78511490732165);

  select runtime.latest_report_id
    into latest_id
    from daily_news.runtime_state as runtime
    where runtime.singleton_id
    for update;

  select coalesce(array_agg(target.report_id), '{}'::uuid[]),
         count(*)::bigint,
         coalesce(sum(pg_column_size(snapshot.payload)), 0)::bigint
    into snapshot_ids, snapshot_count, snapshot_payload_bytes
    from (
      select snapshot.report_id,
             row_number() over (
               order by snapshot.generated_at desc, snapshot.report_id desc
             ) as recency_rank
      from daily_news.report_snapshot as snapshot
    ) as target
    join daily_news.report_snapshot as snapshot on snapshot.report_id = target.report_id
    where target.report_id is distinct from latest_id
      and target.recency_rank > minimum_snapshots
      and snapshot.published_at < now_at - make_interval(days => snapshot_retention_days);

  select count(*)::bigint
    into candidate_count
    from daily_news.article_candidate as candidate
    where candidate.last_seen_at < now_at - make_interval(
      days => case
        when candidate.quality_status = 'rejected' then rejected_candidate_retention_days
        else accepted_candidate_retention_days
      end
    );

  select count(*)::bigint
    into refresh_run_count
    from daily_news.refresh_run as refresh
    where refresh.finished_at < now_at - make_interval(days => refresh_run_retention_days)
      and not exists (
        select 1
        from daily_news.report_snapshot as snapshot
        where snapshot.run_id = refresh.run_id
          and not (snapshot.report_id = any(snapshot_ids))
      )
      and not exists (
        select 1
        from daily_news.refresh_lease as lease
        where lease.run_id = refresh.run_id
      );

  if dry_run then
    return next;
    return;
  end if;

  select *
    into active_lease
    from daily_news.refresh_lease as lease
    where lease.singleton_id
    for update;

  if active_lease.run_id is not null
     and active_lease.lease_expires_at > now_at then
    raise exception using
      errcode = '55000',
      message = 'cannot prune retention while a refresh lease is active';
  end if;

  perform set_config('daily_news.retention_prune', 'on', true);

  update daily_news.report_snapshot as retained
  set supersedes_report_id = null
  where retained.supersedes_report_id = any(snapshot_ids);

  update daily_news.refresh_run as refresh
  set published_report_id = null,
      updated_at = now_at
  where refresh.published_report_id = any(snapshot_ids);

  delete from daily_news.report_snapshot as snapshot
  where snapshot.report_id = any(snapshot_ids);

  perform set_config('daily_news.retention_prune', 'off', true);

  delete from daily_news.article_candidate as candidate
  where candidate.last_seen_at < now_at - make_interval(
    days => case
      when candidate.quality_status = 'rejected' then rejected_candidate_retention_days
      else accepted_candidate_retention_days
    end
  );

  delete from daily_news.refresh_run as refresh
  where refresh.finished_at < now_at - make_interval(days => refresh_run_retention_days)
    and not exists (
      select 1
      from daily_news.report_snapshot as snapshot
      where snapshot.run_id = refresh.run_id
    )
    and not exists (
      select 1
      from daily_news.refresh_lease as lease
      where lease.run_id = refresh.run_id
    );

  return next;
end;
$$;

revoke all on function public.daily_news_prune_retention(
  boolean, integer, integer, integer, integer, integer
) from public, anon, authenticated, service_role;
grant execute on function public.daily_news_prune_retention(
  boolean, integer, integer, integer, integer, integer
) to service_role;

comment on function public.daily_news_prune_retention(
  boolean, integer, integer, integer, integer, integer
) is 'Dry-runs or applies bounded snapshot, candidate, and refresh-run retention while preserving latest and rollback snapshots.';

do $$
declare
  existing_job_id bigint;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    return;
  end if;

  select jobid
    into existing_job_id
    from cron.job
    where jobname = 'daily-news-retention';

  if existing_job_id is not null then
    perform cron.unschedule(existing_job_id);
  end if;

  perform cron.schedule(
    'daily-news-retention',
    '30 3 * * *',
    'select * from public.daily_news_prune_retention(false, 7, 2, 30, 7, 30)'
  );
end;
$$;
