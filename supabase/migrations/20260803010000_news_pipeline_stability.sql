alter table daily_news.runtime_state
  add column if not exists last_outcome_code text
  check (last_outcome_code is null or last_outcome_code in ('published', 'unchanged', 'partial', 'failed'));

create function daily_news.preserve_runtime_terminal_state()
returns trigger
language plpgsql
set search_path = pg_catalog, daily_news
as $$
begin
  if old.last_error_code is not null
     and new.last_error_code is null
     and exists (
       select 1
       from daily_news.refresh_lease as lease
       join daily_news.refresh_run as refresh on refresh.run_id = lease.run_id
       where lease.singleton_id and refresh.status = 'running'
     ) then
    new.last_error_code := old.last_error_code;
  end if;
  if new.last_error_code like 'rollback:%' then
    new.last_outcome_code := 'failed';
  end if;
  return new;
end;
$$;

drop trigger if exists preserve_runtime_terminal_state on daily_news.runtime_state;
create trigger preserve_runtime_terminal_state
before update on daily_news.runtime_state
for each row execute function daily_news.preserve_runtime_terminal_state();

create function daily_news.sync_runtime_outcome_from_run()
returns trigger
language plpgsql
set search_path = pg_catalog, daily_news
as $$
declare
  terminal_outcome text;
begin
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

drop trigger if exists sync_runtime_outcome_from_run on daily_news.refresh_run;
create trigger sync_runtime_outcome_from_run
after insert or update on daily_news.refresh_run
for each row execute function daily_news.sync_runtime_outcome_from_run();

create or replace function public.daily_news_install_refresh_cron()
returns bigint
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  cron_url text;
  cron_secret text;
  existing_job_id bigint;
  installed_job_id bigint;
  command_sql text := $job$
    select net.http_get(
      url := (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'daily_news_refresh_url'
      ),
      headers := jsonb_build_object(
        'Authorization',
        'Bearer ' || (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'daily_news_cron_secret'
        )
      ),
      timeout_milliseconds := 55000
    );
  $job$;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron')
     or not exists (select 1 from pg_extension where extname = 'pg_net')
     or not exists (select 1 from pg_extension where extname = 'supabase_vault') then
    raise exception using errcode = '55000', message = 'pg_cron, pg_net, and supabase_vault must be enabled first';
  end if;

  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1'
    into cron_url using 'daily_news_refresh_url';
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1'
    into cron_secret using 'daily_news_cron_secret';
  if cron_url is null or cron_url !~ '^https://.*/api/cron$' then
    raise exception using errcode = '22023', message = 'Vault secret daily_news_refresh_url must be an HTTPS /api/cron URL';
  end if;
  if cron_secret is null or char_length(cron_secret) < 16 then
    raise exception using errcode = '22023', message = 'Vault secret daily_news_cron_secret is missing or too short';
  end if;

  execute 'select jobid from cron.job where jobname = $1'
    into existing_job_id using 'daily-news-refresh';
  if existing_job_id is not null then
    execute 'select cron.unschedule($1)' using existing_job_id;
  end if;
  execute 'select cron.schedule($1, $2, $3)'
    into installed_job_id using 'daily-news-refresh', '*/5 * * * *', command_sql;
  return installed_job_id;
end;
$$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    execute 'update cron.job set schedule = $1 where jobname = $2'
      using '*/5 * * * *', 'daily-news-refresh';
  end if;
end;
$$;

create function public.daily_news_try_acquire_refresh_v2(
  lease_owner uuid,
  idempotency_key text,
  trigger_kind text,
  scheduled_at timestamptz,
  lease_seconds integer default 120
)
returns table (
  acquired boolean,
  outcome text,
  run_id uuid,
  fencing_token bigint,
  lease_expires_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, daily_news
as $$
declare
  previous_error_code text;
  result record;
begin
  perform pg_advisory_xact_lock(78511490732164);
  select runtime.last_error_code into previous_error_code
  from daily_news.runtime_state as runtime
  where runtime.singleton_id;

  select * into result
  from public.daily_news_try_acquire_refresh($1, $2, $3, $4, $5);

  if result.acquired then
    update daily_news.runtime_state
    set last_error_code = previous_error_code,
        updated_at = clock_timestamp()
    where singleton_id;
  end if;

  return query select
    result.acquired,
    result.outcome,
    result.run_id,
    result.fencing_token,
    result.lease_expires_at;
end;
$$;

create function public.daily_news_read_acquire_result(
  target_idempotency_key text,
  expected_owner uuid
)
returns table (
  acquired boolean,
  outcome text,
  run_id uuid,
  fencing_token bigint,
  lease_expires_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, daily_news
as $$
declare
  run_row daily_news.refresh_run%rowtype;
  lease_row daily_news.refresh_lease%rowtype;
begin
  if $1 is null or char_length($1) not between 1 and 200 or $2 is null then
    raise exception using errcode = '22023', message = 'idempotency key and expected owner are required';
  end if;

  select * into run_row
  from daily_news.refresh_run as refresh
  where refresh.idempotency_key = $1;

  select * into lease_row
  from daily_news.refresh_lease as lease
  where lease.singleton_id;

  if run_row.run_id is not null
     and run_row.status in ('published', 'completed', 'rejected', 'skipped') then
    return query select false, 'duplicate'::text, run_row.run_id, run_row.fencing_token, null::timestamptz;
    return;
  end if;

  if lease_row.run_id is not null and lease_row.lease_expires_at > clock_timestamp() then
    if run_row.run_id = lease_row.run_id
       and run_row.lease_owner = $2
       and lease_row.lease_owner = $2 then
      return query select true, 'acquired'::text, lease_row.run_id,
        lease_row.fencing_token, lease_row.lease_expires_at;
    else
      return query select false, 'busy'::text, lease_row.run_id,
        lease_row.fencing_token, lease_row.lease_expires_at;
    end if;
    return;
  end if;
end;
$$;

create function public.daily_news_finish_refresh_v2(
  lease_owner uuid,
  run_id uuid,
  fencing_token bigint,
  source_results jsonb,
  candidates jsonb,
  report_id uuid,
  generated_at timestamptz,
  schema_version text,
  payload jsonb,
  content_hash text,
  input_fingerprint text,
  data_as_of timestamptz,
  newest_content_at timestamptz,
  run_metrics jsonb,
  refresh_outcome text default 'published'
)
returns table (
  published boolean,
  outcome text,
  published_report_id uuid,
  previous_report_id uuid,
  published_at timestamptz,
  last_success_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, daily_news
as $$
declare
  result record;
  normalized_outcome text := lower(coalesce($15, 'published'));
  terminal_outcome text;
begin
  if normalized_outcome not in ('published', 'partial') then
    raise exception using errcode = '22023', message = 'refresh_outcome must be published or partial';
  end if;

  select * into result
  from public.daily_news_commit_refresh(
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
    $14 || jsonb_build_object('outcome', normalized_outcome)
  );

  terminal_outcome := case
    when normalized_outcome = 'partial' then 'partial'
    else coalesce(result.outcome, 'published')
  end;

  update daily_news.refresh_run
  set run_metrics = refresh_run.run_metrics || jsonb_build_object(
        'publishOutcome', terminal_outcome,
        'terminalResult', jsonb_build_object(
          'outcome', terminal_outcome,
          'publishedReportId', result.published_report_id,
          'previousReportId', result.previous_report_id,
          'lastSuccessAt', result.last_success_at
        )
      ),
      updated_at = clock_timestamp()
  where refresh_run.run_id = $2;

  update daily_news.runtime_state
  set last_outcome_code = terminal_outcome,
      updated_at = clock_timestamp()
  where singleton_id;

  return query select
    result.published,
    terminal_outcome,
    result.published_report_id,
    result.previous_report_id,
    result.published_at,
    result.last_success_at;
end;
$$;

create function public.daily_news_finish_without_publish_v2(
  lease_owner uuid,
  run_id uuid,
  fencing_token bigint,
  source_results jsonb default '[]'::jsonb,
  candidates jsonb default '[]'::jsonb,
  run_metrics jsonb default '{}'::jsonb,
  refresh_outcome text default 'unchanged'
)
returns table (
  completed boolean,
  last_attempt_at timestamptz,
  last_success_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, daily_news
as $$
declare
  result record;
  normalized_outcome text := lower(coalesce($7, 'unchanged'));
begin
  if normalized_outcome not in ('unchanged', 'partial') then
    raise exception using errcode = '22023', message = 'refresh_outcome must be unchanged or partial';
  end if;

  perform *
  from public.daily_news_record_source_results($1, $2, $3, $4);
  perform *
  from public.daily_news_upsert_candidates($1, $2, $3, $5);

  select * into result
  from public.daily_news_complete_refresh_without_publish(
    $1, $2, $3, $6 || jsonb_build_object('outcome', normalized_outcome)
  );

  update daily_news.refresh_run
  set run_metrics = refresh_run.run_metrics || jsonb_build_object(
        'terminalResult', jsonb_build_object(
          'outcome', normalized_outcome,
          'publishedReportId', null,
          'previousReportId', (select latest_report_id from daily_news.runtime_state where singleton_id),
          'lastSuccessAt', result.last_success_at
        )
      ),
      updated_at = clock_timestamp()
  where refresh_run.run_id = $2;

  update daily_news.runtime_state
  set last_outcome_code = normalized_outcome,
      updated_at = clock_timestamp()
  where singleton_id;

  return query select result.completed, result.last_attempt_at, result.last_success_at;
end;
$$;

create function public.daily_news_read_refresh_result(target_run_id uuid)
returns table (
  status text,
  outcome text,
  published_report_id uuid,
  previous_report_id uuid,
  last_success_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, daily_news
as $$
  select
    refresh.status,
    coalesce(
      refresh.run_metrics #>> '{terminalResult,outcome}',
      refresh.run_metrics ->> 'publishOutcome',
      refresh.run_metrics ->> 'outcome',
      refresh.status
    ),
    coalesce(
      nullif(refresh.run_metrics #>> '{terminalResult,publishedReportId}', '')::uuid,
      refresh.published_report_id
    ),
    coalesce(
      nullif(refresh.run_metrics #>> '{terminalResult,previousReportId}', '')::uuid,
      snapshot.supersedes_report_id
    ),
    coalesce(
      nullif(refresh.run_metrics #>> '{terminalResult,lastSuccessAt}', '')::timestamptz,
      snapshot.data_as_of
    )
  from daily_news.refresh_run as refresh
  left join daily_news.report_snapshot as snapshot
    on snapshot.report_id = refresh.published_report_id
  where refresh.run_id = $1
    and refresh.status in ('published', 'completed', 'failed');
$$;

create function public.daily_news_read_candidates_v2(
  since timestamptz,
  page_limit integer default 500,
  page_offset integer default 0
)
returns table (candidate jsonb)
language plpgsql
stable
security definer
set search_path = pg_catalog, daily_news
as $$
begin
  if $1 is null then
    raise exception using errcode = '22023', message = 'since is required';
  end if;
  if $2 not between 1 and 1000 then
    raise exception using errcode = '22023', message = 'page_limit must be between 1 and 1000';
  end if;
  if $3 < 0 then
    raise exception using errcode = '22023', message = 'page_offset must be non-negative';
  end if;

  return query
    select stored.payload || jsonb_build_object(
      'candidateId', stored.candidate_id,
      'sourceId', stored.source_id,
      'canonicalUrl', stored.canonical_url,
      'title', stored.title,
      'summary', stored.summary,
      'publishedAt', stored.published_at,
      'updatedAt', stored.article_updated_at,
      'discoveredAt', stored.discovered_at,
      'language', stored.language,
      'contentFingerprint', stored.content_fingerprint,
      'qualityStatus', stored.quality_status,
      'rejectionReasons', to_jsonb(stored.rejection_reasons)
    )
    from daily_news.article_candidate as stored
    where stored.quality_status = 'accepted'
      and coalesce(
        stored.article_updated_at,
        stored.published_at,
        stored.discovered_at,
        stored.last_seen_at
      ) >= $1
    order by stored.source_id,
      coalesce(stored.article_updated_at, stored.published_at, stored.discovered_at, stored.last_seen_at) desc,
      stored.candidate_id
    limit $2
    offset $3;
end;
$$;

create function public.daily_news_read_snapshot_fallbacks(
  starting_report_id uuid,
  max_depth integer default 10
)
returns table (
  report_id uuid,
  generated_at timestamptz,
  published_at timestamptz,
  schema_version text,
  content_hash text,
  input_fingerprint text,
  payload jsonb,
  data_as_of timestamptz,
  newest_content_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, daily_news
as $$
begin
  if $1 is null then
    raise exception using errcode = '22023', message = 'starting_report_id is required';
  end if;
  if $2 not between 1 and 50 then
    raise exception using errcode = '22023', message = 'max_depth must be between 1 and 50';
  end if;

  return query
    with recursive snapshot_chain as (
      select snapshot.*, 0 as depth
      from daily_news.report_snapshot as snapshot
      where snapshot.report_id = $1

      union all

      select previous.*, current.depth + 1
      from snapshot_chain as current
      join daily_news.report_snapshot as previous
        on previous.report_id = current.supersedes_report_id
      where current.depth + 1 < $2
    )
    select
      snapshot.report_id,
      snapshot.generated_at,
      snapshot.published_at,
      snapshot.schema_version,
      snapshot.content_hash,
      snapshot.input_fingerprint,
      snapshot.payload,
      snapshot.data_as_of,
      snapshot.newest_content_at
    from snapshot_chain as snapshot
    order by snapshot.depth;
end;
$$;

drop function public.daily_news_read_latest();

create function public.daily_news_read_latest()
returns table (
  report_id uuid,
  generated_at timestamptz,
  published_at timestamptz,
  schema_version text,
  content_hash text,
  input_fingerprint text,
  payload jsonb,
  data_as_of timestamptz,
  newest_content_at timestamptz,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_error_code text,
  last_outcome_code text,
  enabled_source_count integer,
  recently_attempted_source_count integer,
  last_full_sweep_at timestamptz,
  publication_state_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, daily_news
as $$
  select
    snapshot.report_id,
    snapshot.generated_at,
    snapshot.published_at,
    snapshot.schema_version,
    snapshot.content_hash,
    snapshot.input_fingerprint,
    snapshot.payload,
    snapshot.data_as_of,
    snapshot.newest_content_at,
    runtime.last_attempt_at,
    runtime.last_success_at,
    runtime.last_error_code,
    runtime.last_outcome_code,
    source_coverage.enabled_source_count,
    source_coverage.recently_attempted_source_count,
    source_coverage.last_full_sweep_at,
    runtime.updated_at
  from daily_news.runtime_state as runtime
  cross join lateral (
    select
      count(*) filter (where source.enabled)::integer as enabled_source_count,
      count(*) filter (
        where source.enabled
          and source.last_attempt_at >= clock_timestamp() - interval '30 minutes'
      )::integer as recently_attempted_source_count,
      case
        when count(*) filter (where source.enabled) > 0
          and count(*) filter (where source.enabled and source.last_attempt_at is not null)
            = count(*) filter (where source.enabled)
        then min(source.last_attempt_at) filter (where source.enabled)
        else null
      end as last_full_sweep_at
    from daily_news.source_state as source
  ) as source_coverage
  left join daily_news.report_snapshot as snapshot
    on snapshot.report_id = runtime.latest_report_id
  where runtime.singleton_id;
$$;

revoke all on function public.daily_news_finish_refresh_v2(
  uuid, uuid, bigint, jsonb, jsonb, uuid, timestamptz, text, jsonb, text, text,
  timestamptz, timestamptz, jsonb, text
) from public, anon, authenticated, service_role;
grant execute on function public.daily_news_finish_refresh_v2(
  uuid, uuid, bigint, jsonb, jsonb, uuid, timestamptz, text, jsonb, text, text,
  timestamptz, timestamptz, jsonb, text
) to service_role;

revoke all on function public.daily_news_try_acquire_refresh_v2(uuid, text, text, timestamptz, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.daily_news_try_acquire_refresh_v2(uuid, text, text, timestamptz, integer)
  to service_role;

revoke all on function public.daily_news_read_acquire_result(text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.daily_news_read_acquire_result(text, uuid)
  to service_role;

revoke all on function public.daily_news_finish_without_publish_v2(
  uuid, uuid, bigint, jsonb, jsonb, jsonb, text
) from public, anon, authenticated, service_role;
grant execute on function public.daily_news_finish_without_publish_v2(
  uuid, uuid, bigint, jsonb, jsonb, jsonb, text
) to service_role;

revoke all on function public.daily_news_read_refresh_result(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.daily_news_read_refresh_result(uuid) to service_role;

revoke all on function public.daily_news_read_candidates_v2(timestamptz, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.daily_news_read_candidates_v2(timestamptz, integer, integer) to service_role;

revoke all on function public.daily_news_read_snapshot_fallbacks(uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.daily_news_read_snapshot_fallbacks(uuid, integer) to service_role;

revoke all on function public.daily_news_read_latest() from public, anon, authenticated, service_role;
grant execute on function public.daily_news_read_latest() to service_role;

comment on function public.daily_news_finish_refresh_v2(
  uuid, uuid, bigint, jsonb, jsonb, uuid, timestamptz, text, jsonb, text, text,
  timestamptz, timestamptz, jsonb, text
) is 'Versioned atomic refresh finish that records published or partial outcomes.';

comment on function public.daily_news_try_acquire_refresh_v2(uuid, text, text, timestamptz, integer)
  is 'Acquires a refresh lease without clearing the last terminal error.';

comment on function public.daily_news_finish_without_publish_v2(
  uuid, uuid, bigint, jsonb, jsonb, jsonb, text
) is 'Versioned atomic finish for source results, candidates, and unchanged or partial refreshes without a new snapshot.';

comment on function public.daily_news_read_refresh_result(uuid)
  is 'Reads a finalized refresh result for safe post-timeout reconciliation.';

comment on function public.daily_news_read_candidates_v2(timestamptz, integer, integer)
  is 'Reads every recent candidate through stable source-aware pagination without a global truncation cap.';

comment on function public.daily_news_read_snapshot_fallbacks(uuid, integer)
  is 'Walks the immutable supersedes chain so readers can skip a damaged latest snapshot.';
