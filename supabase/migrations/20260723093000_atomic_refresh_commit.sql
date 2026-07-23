create function public.daily_news_commit_refresh(
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
  run_metrics jsonb
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
begin
  perform *
    from public.daily_news_record_source_results($1, $2, $3, $4);
  perform *
    from public.daily_news_upsert_candidates($1, $2, $3, $5);
  return query
    select result.*
      from public.daily_news_publish_refresh(
        $1,
        $2,
        $3,
        $6,
        $7,
        $8,
        $9,
        $10,
        $11,
        $12,
        $13,
        $14
      ) as result;
end;
$$;

revoke all on function public.daily_news_commit_refresh(
  uuid,
  uuid,
  bigint,
  jsonb,
  jsonb,
  uuid,
  timestamptz,
  text,
  jsonb,
  text,
  text,
  timestamptz,
  timestamptz,
  jsonb
) from public, anon, authenticated, service_role;

grant execute on function public.daily_news_commit_refresh(
  uuid,
  uuid,
  bigint,
  jsonb,
  jsonb,
  uuid,
  timestamptz,
  text,
  jsonb,
  text,
  text,
  timestamptz,
  timestamptz,
  jsonb
) to service_role;

comment on function public.daily_news_commit_refresh(
  uuid,
  uuid,
  bigint,
  jsonb,
  jsonb,
  uuid,
  timestamptz,
  text,
  jsonb,
  text,
  text,
  timestamptz,
  timestamptz,
  jsonb
) is
  'Atomically records source outcomes, upserts candidates, and publishes a refresh.';
