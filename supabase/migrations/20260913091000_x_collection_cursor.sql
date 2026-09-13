alter table daily_news.source_state
  add column if not exists collection_cursor jsonb
  check (collection_cursor is null or jsonb_typeof(collection_cursor) = 'object');

create or replace function public.daily_news_list_source_states_v2()
returns table (
  source_id text, enabled boolean, last_attempt_at timestamptz, last_success_at timestamptz,
  next_due_at timestamptz, interval_minutes integer, consecutive_failures integer,
  accepted_rate numeric, circuit_open_until timestamptz, last_error_code text, collection_cursor jsonb
)
language sql stable security definer set search_path = pg_catalog, daily_news
as $$
  select source_id, enabled, last_attempt_at, last_success_at, next_due_at, interval_minutes,
    consecutive_failures, accepted_rate, circuit_open_until, last_error_code, collection_cursor
  from daily_news.source_state order by source_id;
$$;

create or replace function public.daily_news_record_source_results_v2(
  lease_owner uuid, run_id uuid, fencing_token bigint, results jsonb
)
returns table (updated_count integer)
language plpgsql security definer set search_path = pg_catalog, daily_news
as $$
declare result record;
begin
  select * into result from public.daily_news_record_source_results($1, $2, $3, $4);
  perform * from daily_news.apply_collection_cursors($4);
  return query select result.updated_count;
end;
$$;

create or replace function daily_news.apply_collection_cursors(results jsonb)
returns table (updated_count integer)
language plpgsql security definer set search_path = pg_catalog, daily_news
as $$
declare item jsonb; source_key text; cursor_value jsonb; total integer := 0;
begin
  for item in select value from jsonb_array_elements(results) loop
    source_key := coalesce(item->>'sourceId', item->>'source_id');
    cursor_value := coalesce(item->'collectionCursor', item->'collection_cursor');
    if cursor_value is null then continue; end if;
    if jsonb_typeof(cursor_value) <> 'object'
       or not (cursor_value ? 'userId')
       or coalesce(cursor_value->>'userId', '') !~ '^[0-9]{1,30}$'
       or (cursor_value ? 'sinceId' and coalesce(cursor_value->>'sinceId', '') !~ '^[0-9]{1,30}$')
       or (cursor_value ? 'newestId' and coalesce(cursor_value->>'newestId', '') !~ '^[0-9]{1,30}$')
       or (cursor_value ? 'paginationToken' and char_length(coalesce(cursor_value->>'paginationToken', '')) not between 1 and 2048)
       or (cursor_value ? 'startTime' and (cursor_value->>'startTime')::timestamptz is null)
       or exists (select 1 from jsonb_object_keys(cursor_value) as key where key not in ('userId','sinceId','paginationToken','newestId','startTime')) then
      raise exception using errcode = '22023', message = 'collection cursor is invalid';
    end if;
    update daily_news.source_state set collection_cursor = cursor_value, updated_at = clock_timestamp()
    where source_id = source_key;
    total := total + 1;
  end loop;
  return query select total;
end;
$$;

create or replace function public.daily_news_finish_refresh_v3(
  lease_owner uuid, run_id uuid, fencing_token bigint, source_results jsonb, candidates jsonb,
  report_id uuid, generated_at timestamptz, schema_version text, payload jsonb, content_hash text,
  input_fingerprint text, data_as_of timestamptz, newest_content_at timestamptz, run_metrics jsonb,
  refresh_outcome text default 'published'
)
returns table (published boolean, outcome text, published_report_id uuid, previous_report_id uuid,
  published_at timestamptz, last_success_at timestamptz)
language plpgsql security definer set search_path = pg_catalog, daily_news
as $$
declare result record;
begin
  select * into result from public.daily_news_finish_refresh_v2($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15);
  perform * from daily_news.apply_collection_cursors($4);
  return query select result.published, result.outcome, result.published_report_id, result.previous_report_id, result.published_at, result.last_success_at;
end;
$$;

create or replace function public.daily_news_finish_without_publish_v3(
  lease_owner uuid, run_id uuid, fencing_token bigint, source_results jsonb default '[]'::jsonb,
  candidates jsonb default '[]'::jsonb, run_metrics jsonb default '{}'::jsonb,
  refresh_outcome text default 'unchanged'
)
returns table (completed boolean, last_attempt_at timestamptz, last_success_at timestamptz)
language plpgsql security definer set search_path = pg_catalog, daily_news
as $$
declare result record;
begin
  select * into result from public.daily_news_finish_without_publish_v2($1,$2,$3,$4,$5,$6,$7);
  perform * from daily_news.apply_collection_cursors($4);
  return query select result.completed, result.last_attempt_at, result.last_success_at;
end;
$$;

-- Only the fenced SECURITY DEFINER wrappers may apply cursors.
revoke all on function daily_news.apply_collection_cursors(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.daily_news_list_source_states_v2() from public, anon, authenticated;
grant execute on function public.daily_news_list_source_states_v2() to service_role;
revoke all on function public.daily_news_record_source_results_v2(uuid,uuid,bigint,jsonb) from public, anon, authenticated;
grant execute on function public.daily_news_record_source_results_v2(uuid,uuid,bigint,jsonb) to service_role;
revoke all on function public.daily_news_finish_refresh_v3(uuid,uuid,bigint,jsonb,jsonb,uuid,timestamptz,text,jsonb,text,text,timestamptz,timestamptz,jsonb,text) from public, anon, authenticated;
grant execute on function public.daily_news_finish_refresh_v3(uuid,uuid,bigint,jsonb,jsonb,uuid,timestamptz,text,jsonb,text,text,timestamptz,timestamptz,jsonb,text) to service_role;
revoke all on function public.daily_news_finish_without_publish_v3(uuid,uuid,bigint,jsonb,jsonb,jsonb,text) from public, anon, authenticated;
grant execute on function public.daily_news_finish_without_publish_v3(uuid,uuid,bigint,jsonb,jsonb,jsonb,text) to service_role;
