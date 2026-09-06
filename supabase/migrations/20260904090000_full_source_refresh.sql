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
          -- Two scheduler slots allow for one delayed full-source refresh.
          and source.last_attempt_at >= clock_timestamp() - interval '4 hours'
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

comment on function public.daily_news_read_latest() is
  'Reads latest publication state and four-hour full-source sweep coverage without exposing internal source errors.';
