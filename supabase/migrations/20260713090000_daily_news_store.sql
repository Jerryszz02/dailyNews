-- Daily News durable runtime store.
-- All application data lives in a non-exposed schema and is reachable only
-- through the service-role RPCs declared below.

create schema daily_news;

revoke all on schema daily_news from public;
revoke all on schema daily_news from anon;
revoke all on schema daily_news from authenticated;
grant usage on schema daily_news to service_role;

create table daily_news.refresh_run (
  run_id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  trigger_kind text not null
    check (trigger_kind in ('cron', 'manual', 'local', 'bootstrap')),
  scheduled_at timestamptz not null,
  lease_owner uuid not null,
  fencing_token bigint not null check (fencing_token > 0),
  status text not null default 'running'
    check (status in ('running', 'completed', 'published', 'failed', 'rejected', 'skipped')),
  started_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  selected_source_ids text[] not null default '{}',
  discovered_count integer not null default 0 check (discovered_count >= 0),
  accepted_count integer not null default 0 check (accepted_count >= 0),
  published_report_id uuid,
  error_code text,
  run_metrics jsonb not null default '{}'::jsonb
    check (jsonb_typeof(run_metrics) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check (char_length(idempotency_key) between 1 and 200),
  check (error_code is null or char_length(error_code) <= 100)
);

create table daily_news.report_snapshot (
  report_id uuid primary key,
  run_id uuid not null unique references daily_news.refresh_run(run_id) on delete restrict,
  generated_at timestamptz not null,
  published_at timestamptz not null default clock_timestamp(),
  schema_version text not null,
  content_hash text not null,
  input_fingerprint text,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  data_as_of timestamptz not null,
  newest_content_at timestamptz,
  supersedes_report_id uuid references daily_news.report_snapshot(report_id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  check (char_length(schema_version) between 1 and 50),
  check (char_length(content_hash) between 16 and 128),
  check (input_fingerprint is null or char_length(input_fingerprint) between 1 and 256),
  check (generated_at <= data_as_of + interval '5 minutes'),
  check (newest_content_at is null or data_as_of is null or newest_content_at <= data_as_of + interval '5 minutes')
);

create index report_snapshot_content_hash_idx
  on daily_news.report_snapshot (content_hash);

alter table daily_news.refresh_run
  add constraint refresh_run_published_report_id_fkey
  foreign key (published_report_id)
  references daily_news.report_snapshot(report_id)
  on delete restrict;

create table daily_news.runtime_state (
  singleton_id boolean primary key default true check (singleton_id),
  latest_report_id uuid references daily_news.report_snapshot(report_id) on delete restrict,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_error_code text,
  updated_at timestamptz not null default clock_timestamp(),
  check (last_error_code is null or char_length(last_error_code) <= 100)
);

create table daily_news.refresh_lease (
  singleton_id boolean primary key default true check (singleton_id),
  run_id uuid references daily_news.refresh_run(run_id) on delete restrict,
  lease_owner uuid,
  fencing_token bigint not null default 0 check (fencing_token >= 0),
  lease_expires_at timestamptz,
  acquired_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  check (
    (run_id is null and lease_owner is null and lease_expires_at is null)
    or
    (run_id is not null and lease_owner is not null and lease_expires_at is not null)
  )
);

create table daily_news.source_state (
  source_id text primary key,
  enabled boolean not null default true,
  interval_minutes integer not null default 90
    check (interval_minutes between 5 and 1440),
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  next_due_at timestamptz not null default clock_timestamp(),
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  circuit_open_until timestamptz,
  latency_ms_p50 integer check (latency_ms_p50 is null or latency_ms_p50 >= 0),
  latency_ms_p95 integer check (latency_ms_p95 is null or latency_ms_p95 >= 0),
  accepted_rate numeric(7, 6) check (accepted_rate is null or accepted_rate between 0 and 1),
  last_error_code text,
  last_run_id uuid references daily_news.refresh_run(run_id) on delete set null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check (char_length(source_id) between 1 and 200),
  check (last_error_code is null or char_length(last_error_code) <= 100)
);

create table daily_news.article_candidate (
  candidate_id text primary key default gen_random_uuid()::text,
  source_id text not null references daily_news.source_state(source_id) on delete restrict,
  canonical_url text not null,
  title text not null,
  summary text,
  published_at timestamptz,
  article_updated_at timestamptz,
  discovered_at timestamptz not null,
  language text,
  content_fingerprint text not null,
  quality_status text not null default 'accepted'
    check (quality_status in ('accepted', 'rejected', 'pending')),
  rejection_reasons text[] not null default '{}',
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  first_seen_at timestamptz not null default clock_timestamp(),
  last_seen_at timestamptz not null default clock_timestamp(),
  last_run_id uuid references daily_news.refresh_run(run_id) on delete set null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (source_id, canonical_url),
  check (char_length(candidate_id) between 1 and 500),
  check (char_length(canonical_url) between 8 and 4096),
  check (canonical_url ~ '^https?://'),
  check (char_length(title) between 1 and 2000),
  check (char_length(content_fingerprint) between 1 and 256)
);

insert into daily_news.runtime_state (singleton_id) values (true);
insert into daily_news.refresh_lease (singleton_id) values (true);

create index refresh_run_status_started_idx
  on daily_news.refresh_run (status, started_at desc);
create index refresh_run_scheduled_idx
  on daily_news.refresh_run (scheduled_at desc);
create index report_snapshot_generated_idx
  on daily_news.report_snapshot (generated_at desc);
create index source_state_due_idx
  on daily_news.source_state (next_due_at, last_attempt_at, source_id)
  where enabled;
create index article_candidate_published_idx
  on daily_news.article_candidate (published_at desc)
  where quality_status = 'accepted';
create index article_candidate_discovered_idx
  on daily_news.article_candidate (discovered_at desc);
create index article_candidate_last_seen_idx
  on daily_news.article_candidate (last_seen_at desc);

create function daily_news.reject_snapshot_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  raise exception using
    errcode = '55000',
    message = 'daily_news report snapshots are immutable';
end;
$$;

create trigger report_snapshot_immutable
before update or delete on daily_news.report_snapshot
for each row execute function daily_news.reject_snapshot_mutation();

create function daily_news.assert_active_lease(
  expected_owner uuid,
  expected_run_id uuid,
  expected_fencing_token bigint
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, daily_news
as $$
declare
  current_lease daily_news.refresh_lease%rowtype;
begin
  select *
    into current_lease
    from daily_news.refresh_lease
    where singleton_id
    for update;

  if current_lease.run_id is distinct from expected_run_id
     or current_lease.lease_owner is distinct from expected_owner
     or current_lease.fencing_token is distinct from expected_fencing_token
     or current_lease.lease_expires_at is null
     or current_lease.lease_expires_at <= clock_timestamp() then
    raise exception using
      errcode = '42501',
      message = 'refresh lease is missing, expired, or fenced';
  end if;
end;
$$;

create function public.daily_news_try_acquire_refresh(
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
  now_at timestamptz := clock_timestamp();
  lease_row daily_news.refresh_lease%rowtype;
  run_row daily_news.refresh_run%rowtype;
  selected_run_id uuid;
  next_fencing_token bigint;
  expires_at timestamptz;
begin
  if $1 is null then
    raise exception using errcode = '22023', message = 'lease_owner is required';
  end if;
  if $2 is null or char_length($2) not between 1 and 200 then
    raise exception using errcode = '22023', message = 'idempotency_key must be 1..200 characters';
  end if;
  if $3 not in ('cron', 'manual', 'local', 'bootstrap') then
    raise exception using errcode = '22023', message = 'unsupported trigger_kind';
  end if;
  if $4 is null then
    raise exception using errcode = '22023', message = 'scheduled_at is required';
  end if;
  if $5 not between 15 and 900 then
    raise exception using errcode = '22023', message = 'lease_seconds must be between 15 and 900';
  end if;

  perform pg_advisory_xact_lock(78511490732164);

  select * into lease_row
    from daily_news.refresh_lease
    where singleton_id
    for update;

  select * into run_row
    from daily_news.refresh_run
    where refresh_run.idempotency_key = $2
    for update;

  if found and run_row.status in ('published', 'completed', 'rejected', 'skipped') then
    return query select false, 'duplicate'::text, run_row.run_id,
      run_row.fencing_token, null::timestamptz;
    return;
  end if;

  if lease_row.run_id is not null
     and lease_row.lease_expires_at > now_at then
    return query select false, 'busy'::text, lease_row.run_id,
      lease_row.fencing_token, lease_row.lease_expires_at;
    return;
  end if;

  if lease_row.run_id is not null
     and lease_row.lease_expires_at <= now_at
     and lease_row.run_id is distinct from run_row.run_id then
    update daily_news.refresh_run set
      status = 'failed',
      finished_at = now_at,
      error_code = 'lease_expired',
      run_metrics = run_metrics || jsonb_build_object('leaseOutcome', 'expired'),
      updated_at = now_at
    where refresh_run.run_id = lease_row.run_id
      and refresh_run.status = 'running';
  end if;

  selected_run_id := case when run_row.run_id is null then gen_random_uuid() else run_row.run_id end;
  next_fencing_token := lease_row.fencing_token + 1;
  expires_at := now_at + make_interval(secs => $5);

  insert into daily_news.refresh_run (
    run_id,
    idempotency_key,
    trigger_kind,
    scheduled_at,
    lease_owner,
    fencing_token,
    status,
    started_at,
    finished_at,
    error_code,
    updated_at
  ) values (
    selected_run_id,
    $2,
    $3,
    $4,
    $1,
    next_fencing_token,
    'running',
    now_at,
    null,
    null,
    now_at
  )
  on conflict on constraint refresh_run_idempotency_key_key do update set
    trigger_kind = excluded.trigger_kind,
    scheduled_at = excluded.scheduled_at,
    lease_owner = excluded.lease_owner,
    fencing_token = excluded.fencing_token,
    status = 'running',
    started_at = excluded.started_at,
    finished_at = null,
    error_code = null,
    updated_at = excluded.updated_at;

  update daily_news.refresh_lease set
    run_id = selected_run_id,
    lease_owner = $1,
    fencing_token = next_fencing_token,
    lease_expires_at = expires_at,
    acquired_at = now_at,
    updated_at = now_at
  where singleton_id;

  update daily_news.runtime_state set
    last_attempt_at = now_at,
    last_error_code = null,
    updated_at = now_at
  where singleton_id;

  return query select true, 'acquired'::text, selected_run_id,
    next_fencing_token, expires_at;
end;
$$;

create function public.daily_news_renew_refresh(
  lease_owner uuid,
  run_id uuid,
  fencing_token bigint,
  lease_seconds integer default 120
)
returns table (renewed boolean, lease_expires_at timestamptz)
language plpgsql
security definer
set search_path = pg_catalog, daily_news
as $$
declare
  now_at timestamptz := clock_timestamp();
  next_expiry timestamptz;
  changed_count integer;
begin
  if $4 not between 15 and 900 then
    raise exception using errcode = '22023', message = 'lease_seconds must be between 15 and 900';
  end if;

  perform pg_advisory_xact_lock(78511490732164);
  next_expiry := now_at + make_interval(secs => $4);

  update daily_news.refresh_lease set
    lease_expires_at = next_expiry,
    updated_at = now_at
  where singleton_id
    and refresh_lease.lease_owner = $1
    and refresh_lease.run_id = $2
    and refresh_lease.fencing_token = $3
    and refresh_lease.lease_expires_at > now_at;

  get diagnostics changed_count = row_count;
  return query select changed_count = 1,
    case when changed_count = 1 then next_expiry else null end;
end;
$$;

create function public.daily_news_sync_sources(
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
  if jsonb_typeof($1) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'sources must be a JSON array';
  end if;
  if $2 is null then
    raise exception using errcode = '22023', message = 'observed_at is required';
  end if;

  for source in select value from jsonb_array_elements($1) loop
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
      $2,
      $2
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
    updated_at = $2
  where state.enabled
    and not exists (
      select 1
      from jsonb_array_elements($1) as registry_item
      where coalesce(
        registry_item.value ->> 'sourceId',
        registry_item.value ->> 'source_id'
      ) = state.source_id
    );

  return query select changed_count;
end;
$$;

create function public.daily_news_list_source_states()
returns table (
  source_id text,
  enabled boolean,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  next_due_at timestamptz,
  interval_minutes integer,
  consecutive_failures integer,
  accepted_rate numeric,
  circuit_open_until timestamptz,
  last_error_code text
)
language sql
stable
security definer
set search_path = pg_catalog, daily_news
as $$
  select
    state.source_id,
    state.enabled,
    state.last_attempt_at,
    state.last_success_at,
    state.next_due_at,
    state.interval_minutes,
    state.consecutive_failures,
    state.accepted_rate,
    state.circuit_open_until,
    state.last_error_code
  from daily_news.source_state as state
  order by state.source_id;
$$;

create function public.daily_news_list_due_sources(
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
      state.next_due_at,
      state.interval_minutes,
      state.consecutive_failures,
      state.accepted_rate,
      state.circuit_open_until,
      state.last_error_code
    from daily_news.source_state as state
    where state.enabled
      and state.next_due_at <= $1
      and (state.circuit_open_until is null or state.circuit_open_until <= $1)
    order by state.next_due_at, state.last_attempt_at nulls first, state.source_id
    limit $2;
end;
$$;

create function public.daily_news_record_source_results(
  lease_owner uuid,
  run_id uuid,
  fencing_token bigint,
  results jsonb
)
returns table (updated_count integer)
language plpgsql
security definer
set search_path = pg_catalog, daily_news
as $$
declare
  now_at timestamptz := clock_timestamp();
  result_item jsonb;
  result_source_id text;
  result_status text;
  attempted_at timestamptz;
  next_due timestamptz;
  succeeded boolean;
  latency_ms integer;
  discovered integer;
  accepted integer;
  normalized_error text;
  affected integer;
  total_updated integer := 0;
  total_discovered integer := 0;
  total_accepted integer := 0;
  selected_sources text[] := '{}';
begin
  if jsonb_typeof($4) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'results must be a JSON array';
  end if;

  perform pg_advisory_xact_lock(78511490732164);
  perform daily_news.assert_active_lease($1, $2, $3);

  for result_item in select value from jsonb_array_elements($4) loop
    result_source_id := coalesce(result_item ->> 'sourceId', result_item ->> 'source_id');
    attempted_at := coalesce(
      (coalesce(result_item ->> 'attemptedAt', result_item ->> 'attempted_at'))::timestamptz,
      now_at
    );
    result_status := lower(coalesce(result_item ->> 'status', ''));
    succeeded := coalesce(
      (result_item ->> 'success')::boolean,
      result_status in ('success', 'empty')
    );
    next_due := (coalesce(result_item ->> 'nextDueAt', result_item ->> 'next_due_at'))::timestamptz;
    latency_ms := coalesce(
      (coalesce(result_item ->> 'latencyMs', result_item ->> 'latency_ms'))::integer,
      0
    );
    discovered := greatest(
      coalesce((coalesce(result_item ->> 'discoveredCount', result_item ->> 'discovered_count'))::integer, 0),
      0
    );
    accepted := greatest(
      coalesce((coalesce(result_item ->> 'acceptedCount', result_item ->> 'accepted_count'))::integer, 0),
      0
    );
    normalized_error := lower(
      coalesce(
        result_item ->> 'lastErrorCode',
        result_item ->> 'last_error_code',
        result_item ->> 'errorCode',
        result_item ->> 'error_code',
        ''
      )
    );

    if result_source_id is null or char_length(result_source_id) not between 1 and 200 then
      raise exception using errcode = '22023', message = 'each result requires a valid sourceId';
    end if;
    if latency_ms < 0 or accepted > discovered then
      raise exception using errcode = '22023', message = 'source result counts or latency are invalid';
    end if;
    if succeeded then
      normalized_error := null;
    elsif normalized_error = '' or normalized_error !~ '^[a-z0-9_:-]{1,100}$' then
      normalized_error := 'source_failed';
    end if;

    update daily_news.source_state as state set
      last_attempt_at = attempted_at,
      last_success_at = case when succeeded then attempted_at else state.last_success_at end,
      next_due_at = coalesce(
        next_due,
        attempted_at + make_interval(mins => state.interval_minutes)
      ),
      consecutive_failures = case when succeeded then 0 else state.consecutive_failures + 1 end,
      circuit_open_until = case
        when succeeded then null
        when state.consecutive_failures + 1 >= 3 then
          attempted_at + make_interval(mins => state.interval_minutes * 2)
        else state.circuit_open_until
      end,
      latency_ms_p50 = case
        when latency_ms = 0 then state.latency_ms_p50
        when state.latency_ms_p50 is null then latency_ms
        else round((state.latency_ms_p50 * 0.8) + (latency_ms * 0.2))::integer
      end,
      latency_ms_p95 = case
        when latency_ms = 0 then state.latency_ms_p95
        when state.latency_ms_p95 is null then latency_ms
        else greatest(latency_ms, round(state.latency_ms_p95 * 0.95)::integer)
      end,
      accepted_rate = case
        when discovered > 0 then accepted::numeric / discovered::numeric
        else state.accepted_rate
      end,
      last_error_code = normalized_error,
      last_run_id = $2,
      updated_at = now_at
    where state.source_id = result_source_id;

    get diagnostics affected = row_count;
    if affected <> 1 then
      raise exception using
        errcode = '23503',
        message = format('unknown source_id: %s', result_source_id);
    end if;

    total_updated := total_updated + 1;
    total_discovered := total_discovered + discovered;
    total_accepted := total_accepted + accepted;
    selected_sources := array_append(selected_sources, result_source_id);
  end loop;

  update daily_news.refresh_run set
    selected_source_ids = array(
      select distinct selected_source
      from unnest(selected_sources) as selected_source
      order by selected_source
    ),
    discovered_count = total_discovered,
    accepted_count = total_accepted,
    updated_at = now_at
  where refresh_run.run_id = $2;

  return query select total_updated;
end;
$$;

create function public.daily_news_upsert_candidates(
  lease_owner uuid,
  run_id uuid,
  fencing_token bigint,
  candidates jsonb
)
returns table (upserted_count integer)
language plpgsql
security definer
set search_path = pg_catalog, daily_news
as $$
declare
  now_at timestamptz := clock_timestamp();
  candidate_item jsonb;
  candidate_identifier text;
  candidate_source_id text;
  candidate_url text;
  candidate_title text;
  candidate_summary text;
  candidate_published_at timestamptz;
  candidate_updated_at timestamptz;
  candidate_discovered_at timestamptz;
  candidate_language text;
  candidate_fingerprint text;
  candidate_quality text;
  candidate_rejections text[];
  candidate_payload jsonb;
  total_upserted integer := 0;
begin
  if jsonb_typeof($4) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'candidates must be a JSON array';
  end if;

  perform pg_advisory_xact_lock(78511490732164);
  perform daily_news.assert_active_lease($1, $2, $3);

  for candidate_item in select value from jsonb_array_elements($4) loop
    candidate_identifier := coalesce(
      candidate_item ->> 'candidateId',
      candidate_item ->> 'candidate_id',
      gen_random_uuid()::text
    );
    candidate_source_id := coalesce(candidate_item ->> 'sourceId', candidate_item ->> 'source_id');
    candidate_url := coalesce(candidate_item ->> 'canonicalUrl', candidate_item ->> 'canonical_url');
    candidate_title := candidate_item ->> 'title';
    candidate_summary := candidate_item ->> 'summary';
    candidate_published_at := (coalesce(candidate_item ->> 'publishedAt', candidate_item ->> 'published_at'))::timestamptz;
    candidate_updated_at := (coalesce(candidate_item ->> 'updatedAt', candidate_item ->> 'updated_at'))::timestamptz;
    candidate_discovered_at := coalesce(
      (coalesce(
        candidate_item ->> 'discoveredAt',
        candidate_item ->> 'discovered_at',
        candidate_item ->> 'extractedAt',
        candidate_item ->> 'extracted_at'
      ))::timestamptz,
      now_at
    );
    candidate_language := candidate_item ->> 'language';
    candidate_fingerprint := coalesce(
      candidate_item ->> 'contentFingerprint',
      candidate_item ->> 'content_fingerprint',
      md5(coalesce(candidate_url, '') || E'\n' || coalesce(candidate_title, '') || E'\n' || coalesce(candidate_summary, ''))
    );
    candidate_quality := coalesce(
      candidate_item ->> 'qualityStatus',
      candidate_item ->> 'quality_status',
      'accepted'
    );
    candidate_payload := coalesce(candidate_item -> 'payload', candidate_item);

    if jsonb_typeof(candidate_item -> 'rejectionReasons') = 'array' then
      select coalesce(array_agg(value), '{}')
        into candidate_rejections
        from jsonb_array_elements_text(candidate_item -> 'rejectionReasons');
    elsif jsonb_typeof(candidate_item -> 'rejection_reasons') = 'array' then
      select coalesce(array_agg(value), '{}')
        into candidate_rejections
        from jsonb_array_elements_text(candidate_item -> 'rejection_reasons');
    else
      candidate_rejections := '{}';
    end if;

    if candidate_source_id is null
       or candidate_url is null
       or candidate_title is null
       or candidate_url !~ '^https?://'
       or jsonb_typeof(candidate_payload) is distinct from 'object' then
      raise exception using errcode = '22023', message = 'candidate sourceId, canonicalUrl, title, and object payload are required';
    end if;
    if candidate_quality not in ('accepted', 'rejected', 'pending') then
      raise exception using errcode = '22023', message = 'unsupported candidate qualityStatus';
    end if;

    insert into daily_news.article_candidate (
      candidate_id,
      source_id,
      canonical_url,
      title,
      summary,
      published_at,
      article_updated_at,
      discovered_at,
      language,
      content_fingerprint,
      quality_status,
      rejection_reasons,
      payload,
      first_seen_at,
      last_seen_at,
      last_run_id,
      created_at,
      updated_at
    ) values (
      candidate_identifier,
      candidate_source_id,
      candidate_url,
      candidate_title,
      candidate_summary,
      candidate_published_at,
      candidate_updated_at,
      candidate_discovered_at,
      candidate_language,
      candidate_fingerprint,
      candidate_quality,
      candidate_rejections,
      candidate_payload,
      now_at,
      now_at,
      $2,
      now_at,
      now_at
    )
    on conflict (source_id, canonical_url) do update set
      title = excluded.title,
      summary = excluded.summary,
      published_at = coalesce(excluded.published_at, daily_news.article_candidate.published_at),
      article_updated_at = coalesce(excluded.article_updated_at, daily_news.article_candidate.article_updated_at),
      discovered_at = least(daily_news.article_candidate.discovered_at, excluded.discovered_at),
      language = coalesce(excluded.language, daily_news.article_candidate.language),
      content_fingerprint = excluded.content_fingerprint,
      quality_status = excluded.quality_status,
      rejection_reasons = excluded.rejection_reasons,
      payload = excluded.payload,
      last_seen_at = excluded.last_seen_at,
      last_run_id = excluded.last_run_id,
      updated_at = excluded.updated_at;

    total_upserted := total_upserted + 1;
  end loop;

  return query select total_upserted;
end;
$$;

create function public.daily_news_read_candidates(
  since timestamptz,
  candidate_limit integer default 2000
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
  if $2 not between 1 and 5000 then
    raise exception using errcode = '22023', message = 'candidate_limit must be between 1 and 5000';
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
      and coalesce(stored.published_at, stored.discovered_at) >= $1
    order by coalesce(stored.published_at, stored.discovered_at) desc,
      stored.candidate_id
    limit $2;
end;
$$;

create function public.daily_news_complete_refresh_without_publish(
  lease_owner uuid,
  run_id uuid,
  fencing_token bigint,
  run_metrics jsonb default '{}'::jsonb
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
  now_at timestamptz := clock_timestamp();
begin
  if jsonb_typeof($4) is distinct from 'object' then
    raise exception using errcode = '22023', message = 'run_metrics must be a JSON object';
  end if;

  perform pg_advisory_xact_lock(78511490732164);
  perform daily_news.assert_active_lease($1, $2, $3);

  update daily_news.refresh_run set
    status = 'completed',
    finished_at = now_at,
    error_code = null,
    run_metrics = $4,
    updated_at = now_at
  where refresh_run.run_id = $2;

  update daily_news.runtime_state set
    last_success_at = now_at,
    last_error_code = null,
    updated_at = now_at
  where singleton_id;

  update daily_news.refresh_lease set
    run_id = null,
    lease_owner = null,
    lease_expires_at = null,
    acquired_at = null,
    updated_at = now_at
  where singleton_id;

  return query
    select true, runtime.last_attempt_at, runtime.last_success_at
    from daily_news.runtime_state as runtime
    where runtime.singleton_id;
end;
$$;

create function public.daily_news_mark_refresh_failed(
  lease_owner uuid,
  run_id uuid,
  fencing_token bigint,
  error_code text,
  run_metrics jsonb default '{}'::jsonb
)
returns table (
  marked boolean,
  last_attempt_at timestamptz,
  last_success_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, daily_news
as $$
declare
  now_at timestamptz := clock_timestamp();
  normalized_error text := lower(coalesce($4, 'refresh_failed'));
begin
  if jsonb_typeof($5) is distinct from 'object' then
    raise exception using errcode = '22023', message = 'run_metrics must be a JSON object';
  end if;
  if normalized_error !~ '^[a-z0-9_:-]{1,100}$' then
    normalized_error := 'refresh_failed';
  end if;

  perform pg_advisory_xact_lock(78511490732164);
  perform daily_news.assert_active_lease($1, $2, $3);

  update daily_news.refresh_run set
    status = 'failed',
    finished_at = now_at,
    error_code = normalized_error,
    run_metrics = $5,
    updated_at = now_at
  where refresh_run.run_id = $2;

  update daily_news.runtime_state set
    last_error_code = normalized_error,
    updated_at = now_at
  where singleton_id;

  update daily_news.refresh_lease set
    run_id = null,
    lease_owner = null,
    lease_expires_at = null,
    acquired_at = null,
    updated_at = now_at
  where singleton_id;

  return query
    select true, runtime.last_attempt_at, runtime.last_success_at
    from daily_news.runtime_state as runtime
    where runtime.singleton_id;
end;
$$;

create function public.daily_news_publish_refresh(
  lease_owner uuid,
  run_id uuid,
  fencing_token bigint,
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
declare
  now_at timestamptz := clock_timestamp();
  previous_id uuid;
  matching_snapshot daily_news.report_snapshot%rowtype;
begin
  if $4 is null or $5 is null then
    raise exception using errcode = '22023', message = 'report_id and generated_at are required';
  end if;
  if $6 is null or char_length($6) not between 1 and 50 then
    raise exception using errcode = '22023', message = 'schema_version must be 1..50 characters';
  end if;
  if jsonb_typeof($7) is distinct from 'object' then
    raise exception using errcode = '22023', message = 'payload must be a JSON object';
  end if;
  if $8 is null or char_length($8) not between 16 and 128 then
    raise exception using errcode = '22023', message = 'content_hash must be 16..128 characters';
  end if;
  if $9 is not null and char_length($9) not between 1 and 256 then
    raise exception using errcode = '22023', message = 'input_fingerprint must be 1..256 characters';
  end if;
  if $10 is null then
    raise exception using errcode = '22023', message = 'data_as_of is required';
  end if;
  if jsonb_typeof($12) is distinct from 'object' then
    raise exception using errcode = '22023', message = 'run_metrics must be a JSON object';
  end if;

  perform pg_advisory_xact_lock(78511490732164);
  perform daily_news.assert_active_lease($1, $2, $3);

  select runtime.latest_report_id into previous_id
    from daily_news.runtime_state as runtime
    where runtime.singleton_id
    for update;

  select * into matching_snapshot
    from daily_news.report_snapshot as snapshot
    where snapshot.report_id = previous_id
      and snapshot.content_hash = $8;

  if found then
    update daily_news.refresh_run set
      status = 'completed',
      finished_at = now_at,
      published_report_id = null,
      error_code = null,
      run_metrics = $12 || jsonb_build_object('publishOutcome', 'unchanged'),
      updated_at = now_at
    where refresh_run.run_id = $2;

    update daily_news.runtime_state set
      last_success_at = $10,
      last_error_code = null,
      updated_at = now_at
    where singleton_id;

    update daily_news.refresh_lease set
      run_id = null,
      lease_owner = null,
      lease_expires_at = null,
      acquired_at = null,
      updated_at = now_at
    where singleton_id;

    return query select
      false,
      'unchanged'::text,
      null::uuid,
      previous_id,
      matching_snapshot.published_at,
      $10;
    return;
  end if;

  insert into daily_news.report_snapshot (
    report_id,
    run_id,
    generated_at,
    published_at,
    schema_version,
    content_hash,
    input_fingerprint,
    payload,
    data_as_of,
    newest_content_at,
    supersedes_report_id,
    created_at
  ) values (
    $4,
    $2,
    $5,
    now_at,
    $6,
    $8,
    $9,
    $7,
    $10,
    $11,
    previous_id,
    now_at
  );

  update daily_news.refresh_run set
    status = 'published',
    finished_at = now_at,
    published_report_id = $4,
    error_code = null,
    run_metrics = $12 || jsonb_build_object('publishOutcome', 'published'),
    updated_at = now_at
  where refresh_run.run_id = $2;

  update daily_news.runtime_state set
    latest_report_id = $4,
    last_success_at = $10,
    last_error_code = null,
    updated_at = now_at
  where singleton_id;

  update daily_news.refresh_lease set
    run_id = null,
    lease_owner = null,
    lease_expires_at = null,
    acquired_at = null,
    updated_at = now_at
  where singleton_id;

  return query select true, 'published'::text, $4, previous_id, now_at, $10;
end;
$$;

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
  last_error_code text
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
    runtime.last_error_code
  from daily_news.runtime_state as runtime
  left join daily_news.report_snapshot as snapshot
    on snapshot.report_id = runtime.latest_report_id
  where runtime.singleton_id;
$$;

create function public.daily_news_rollback_latest(
  target_report_id uuid,
  reason_code text
)
returns table (
  report_id uuid,
  previous_report_id uuid,
  rolled_back_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, daily_news
as $$
declare
  now_at timestamptz := clock_timestamp();
  previous_id uuid;
  normalized_reason text := lower(coalesce($2, 'manual'));
  active_lease daily_news.refresh_lease%rowtype;
begin
  if $1 is null then
    raise exception using errcode = '22023', message = 'target_report_id is required';
  end if;
  if normalized_reason !~ '^[a-z0-9_:-]{1,80}$' then
    normalized_reason := 'manual';
  end if;

  perform pg_advisory_xact_lock(78511490732164);

  select * into active_lease
    from daily_news.refresh_lease
    where singleton_id
    for update;

  if active_lease.run_id is not null and active_lease.lease_expires_at > now_at then
    raise exception using errcode = '55000', message = 'cannot roll back while a refresh lease is active';
  end if;

  if not exists (
    select 1 from daily_news.report_snapshot as snapshot where snapshot.report_id = $1
  ) then
    raise exception using errcode = '22023', message = 'target report snapshot does not exist';
  end if;

  select runtime.latest_report_id into previous_id
    from daily_news.runtime_state as runtime
    where runtime.singleton_id
    for update;

  update daily_news.runtime_state set
    latest_report_id = $1,
    last_error_code = 'rollback:' || normalized_reason,
    updated_at = now_at
  where singleton_id;

  return query select $1, previous_id, now_at;
end;
$$;

create function public.daily_news_install_refresh_cron()
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
    raise exception using
      errcode = '55000',
      message = 'pg_cron, pg_net, and supabase_vault must be enabled first';
  end if;

  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1'
    into cron_url
    using 'daily_news_refresh_url';
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1'
    into cron_secret
    using 'daily_news_cron_secret';

  if cron_url is null or cron_url !~ '^https://.*/api/cron$' then
    raise exception using
      errcode = '22023',
      message = 'Vault secret daily_news_refresh_url must be an HTTPS /api/cron URL';
  end if;
  if cron_secret is null or char_length(cron_secret) < 16 then
    raise exception using
      errcode = '22023',
      message = 'Vault secret daily_news_cron_secret is missing or too short';
  end if;

  execute 'select jobid from cron.job where jobname = $1'
    into existing_job_id
    using 'daily-news-refresh';
  if existing_job_id is not null then
    execute 'select cron.unschedule($1)' using existing_job_id;
  end if;

  execute 'select cron.schedule($1, $2, $3)'
    into installed_job_id
    using 'daily-news-refresh', '*/15 * * * *', command_sql;

  return installed_job_id;
end;
$$;

create function public.daily_news_remove_refresh_cron()
returns boolean
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  existing_job_id bigint;
  removed boolean;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    return false;
  end if;

  execute 'select jobid from cron.job where jobname = $1'
    into existing_job_id
    using 'daily-news-refresh';
  if existing_job_id is null then
    return false;
  end if;

  execute 'select cron.unschedule($1)' into removed using existing_job_id;
  return coalesce(removed, false);
end;
$$;

alter table daily_news.refresh_run enable row level security;
alter table daily_news.report_snapshot enable row level security;
alter table daily_news.runtime_state enable row level security;
alter table daily_news.refresh_lease enable row level security;
alter table daily_news.source_state enable row level security;
alter table daily_news.article_candidate enable row level security;

-- No RLS policies are intentional: application access is RPC-only. The
-- security-definer functions above are owned by the migration role and every
-- write path validates the active lease and fencing token where applicable.
revoke all on all tables in schema daily_news from public;
revoke all on all tables in schema daily_news from anon;
revoke all on all tables in schema daily_news from authenticated;
revoke all on all tables in schema daily_news from service_role;
revoke all on all sequences in schema daily_news from public;
revoke all on all sequences in schema daily_news from anon;
revoke all on all sequences in schema daily_news from authenticated;
revoke all on all sequences in schema daily_news from service_role;
revoke all on all functions in schema daily_news from public;
revoke all on all functions in schema daily_news from anon;
revoke all on all functions in schema daily_news from authenticated;
revoke all on all functions in schema daily_news from service_role;

alter default privileges in schema daily_news revoke all on tables from public;
alter default privileges in schema daily_news revoke all on tables from anon;
alter default privileges in schema daily_news revoke all on tables from authenticated;
alter default privileges in schema daily_news revoke all on tables from service_role;
alter default privileges in schema daily_news revoke all on sequences from public;
alter default privileges in schema daily_news revoke all on sequences from anon;
alter default privileges in schema daily_news revoke all on sequences from authenticated;
alter default privileges in schema daily_news revoke all on sequences from service_role;
alter default privileges in schema daily_news revoke execute on functions from public;
alter default privileges in schema daily_news revoke execute on functions from anon;
alter default privileges in schema daily_news revoke execute on functions from authenticated;
alter default privileges in schema daily_news revoke execute on functions from service_role;

do $permissions$
declare
  function_signature regprocedure;
begin
  for function_signature in
    select procedure.oid::regprocedure
    from pg_proc as procedure
    join pg_namespace as namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and procedure.proname like 'daily_news_%'
  loop
    execute format(
      'revoke all on function %s from public, anon, authenticated, service_role',
      function_signature
    );
    execute format(
      'grant execute on function %s to service_role',
      function_signature
    );
  end loop;
end;
$permissions$;

comment on schema daily_news is
  'Private durable state for Daily News; access is restricted to service-role RPCs.';
comment on table daily_news.report_snapshot is
  'Immutable report versions. Rollback changes runtime_state.latest_report_id only.';
comment on column daily_news.refresh_lease.fencing_token is
  'Monotonically increasing token; stale workers cannot mutate active refresh state.';
comment on function public.daily_news_install_refresh_cron() is
  'Installs a 15-minute pg_cron job using daily_news_refresh_url and daily_news_cron_secret from Vault.';
