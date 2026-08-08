-- Keep source coverage deadlines aligned with the currently configured interval.

create or replace function public.daily_news_sync_sources(
  lease_owner uuid,
  run_id uuid,
  fencing_token bigint,
  sources jsonb,
  observed_at timestamptz default clock_timestamp()
)
returns table (upserted_count integer)
language plpgsql
security definer
set search_path = pg_catalog, daily_news
as $$
declare
  source jsonb;
  source_identifier text;
  source_enabled boolean;
  source_interval integer;
  changed_count integer := 0;
begin
  if jsonb_typeof(sources) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'sources must be a JSON array';
  end if;
  if observed_at is null then
    raise exception using errcode = '22023', message = 'observed_at is required';
  end if;

  perform daily_news.assert_active_lease(lease_owner, run_id, fencing_token);

  for source in select value from jsonb_array_elements(sources) loop
    source_identifier := coalesce(source ->> 'sourceId', source ->> 'source_id');
    source_enabled := coalesce((source ->> 'enabled')::boolean, true);
    source_interval := coalesce(
      (coalesce(source ->> 'intervalMinutes', source ->> 'interval_minutes'))::integer,
      90
    );

    if source_identifier is null or char_length(source_identifier) not between 1 and 200 then
      raise exception using errcode = '22023', message = 'each source requires a valid sourceId';
    end if;
    if source_interval not between 5 and 1440 then
      raise exception using errcode = '22023', message = 'source intervalMinutes must be between 5 and 1440';
    end if;

    insert into daily_news.source_state (
      source_id,
      enabled,
      interval_minutes,
      next_due_at,
      updated_at
    ) values (
      source_identifier,
      source_enabled,
      source_interval,
      observed_at,
      observed_at
    )
    on conflict (source_id) do update set
      enabled = excluded.enabled,
      interval_minutes = excluded.interval_minutes,
      next_due_at = case
        when not daily_news.source_state.enabled and excluded.enabled
          then excluded.next_due_at
        when excluded.enabled
          then least(
            daily_news.source_state.next_due_at,
            coalesce(
              daily_news.source_state.last_attempt_at
                + make_interval(mins => excluded.interval_minutes),
              excluded.next_due_at
            )
          )
        else daily_news.source_state.next_due_at
      end,
      updated_at = excluded.updated_at;

    changed_count := changed_count + 1;
  end loop;

  update daily_news.source_state as state set
    enabled = false,
    updated_at = observed_at
  where state.enabled
    and not exists (
      select 1
      from jsonb_array_elements(sources) as registry_item
      where coalesce(
        registry_item.value ->> 'sourceId',
        registry_item.value ->> 'source_id'
      ) = state.source_id
    );

  return query select changed_count;
end;
$$;

revoke all on function public.daily_news_sync_sources(uuid, uuid, bigint, jsonb, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.daily_news_sync_sources(uuid, uuid, bigint, jsonb, timestamptz)
  to service_role;

comment on function public.daily_news_sync_sources(uuid, uuid, bigint, jsonb, timestamptz) is
  'Synchronizes the complete source registry for the active fenced refresh lease and clamps coverage deadlines to current intervals.';

do $coverage_deadline$
declare
  observed_at timestamptz := clock_timestamp();
begin
  update daily_news.source_state as state set
    next_due_at = least(
      state.next_due_at,
      coalesce(
        state.last_attempt_at + make_interval(mins => state.interval_minutes),
        observed_at
      )
    ),
    updated_at = observed_at
  where state.enabled
    and state.next_due_at > coalesce(
      state.last_attempt_at + make_interval(mins => state.interval_minutes),
      observed_at
    );
end;
$coverage_deadline$;

create or replace function public.daily_news_list_due_sources(
  as_of timestamptz,
  source_limit integer default 10
)
returns table (
  source_id text,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  next_due_at timestamptz,
  interval_minutes integer,
  consecutive_failures integer,
  accepted_rate numeric,
  circuit_open_until timestamptz,
  last_error_code text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, daily_news
as $$
begin
  if $1 is null then
    raise exception using errcode = '22023', message = 'as_of is required';
  end if;
  if $2 not between 1 and 100 then
    raise exception using errcode = '22023', message = 'source_limit must be between 1 and 100';
  end if;

  return query
    select
      state.source_id,
      state.last_attempt_at,
      state.last_success_at,
      effective_due.next_due_at,
      state.interval_minutes,
      state.consecutive_failures,
      state.accepted_rate,
      state.circuit_open_until,
      state.last_error_code
    from daily_news.source_state as state
    cross join lateral (
      select least(
        state.next_due_at,
        coalesce(
          state.last_attempt_at + make_interval(mins => state.interval_minutes),
          state.next_due_at
        )
      ) as next_due_at
    ) as effective_due
    where state.enabled
      and effective_due.next_due_at <= $1
    order by effective_due.next_due_at, state.last_attempt_at nulls first, state.source_id
    limit $2;
end;
$$;

revoke all on function public.daily_news_list_due_sources(timestamptz, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.daily_news_list_due_sources(timestamptz, integer)
  to service_role;

comment on function public.daily_news_list_due_sources(timestamptz, integer) is
  'Lists enabled sources by effective coverage deadline; an open retry circuit never suppresses a due coverage attempt.';
