-- Reduce Vercel Function CPU usage by moving the production refresh to every two hours.

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
    into installed_job_id using 'daily-news-refresh', '0 */2 * * *', command_sql;
  return installed_job_id;
end;
$$;

comment on function public.daily_news_install_refresh_cron() is
  'Installs a two-hour pg_cron job using daily_news_refresh_url and daily_news_cron_secret from Vault.';

create or replace function public.daily_news_read_latest()
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
          -- Six two-hour slots cover 49 sources at nine normal rotation slots per run.
          and source.last_attempt_at >= clock_timestamp() - interval '12 hours'
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

do $reduce_refresh_frequency$
declare
  existing_job_id bigint;
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    execute 'select jobid from cron.job where jobname = $1'
      into existing_job_id using 'daily-news-refresh';
    if existing_job_id is not null then
      execute 'select cron.alter_job($1, $2)' using existing_job_id, '0 */2 * * *';
    end if;
  end if;
end;
$reduce_refresh_frequency$;
