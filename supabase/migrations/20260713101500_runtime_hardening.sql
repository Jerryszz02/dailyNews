-- Harden the online refresh boundary after the initial durable-store rollout.

drop function public.daily_news_sync_sources(jsonb, timestamptz);

create function public.daily_news_sync_sources(
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
          then least(daily_news.source_state.next_due_at, excluded.next_due_at)
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

do $permissions$
declare
  function_signature regprocedure;
begin
  for function_signature in
    select procedure.oid::regprocedure
    from pg_proc as procedure
    join pg_namespace as namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'net'
      and procedure.proname in ('http_get', 'http_post', 'http_delete')
  loop
    execute format(
      'revoke all on function %s from public, anon, authenticated, service_role',
      function_signature
    );
  end loop;

  if to_regclass('net.http_request_queue') is not null then
    execute 'revoke all on table net.http_request_queue from public, anon, authenticated, service_role';
  end if;
  if to_regclass('net._http_response') is not null then
    execute 'revoke all on table net._http_response from public, anon, authenticated, service_role';
  end if;
  if to_regclass('vault.decrypted_secrets') is not null then
    execute 'revoke all on table vault.decrypted_secrets from public, anon, authenticated, service_role';
  end if;
end;
$permissions$;

comment on function public.daily_news_sync_sources(uuid, uuid, bigint, jsonb, timestamptz) is
  'Synchronizes the complete source registry only for the active refresh lease and fencing token.';
