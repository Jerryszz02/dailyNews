begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, pg_catalog;

truncate table
  daily_news.article_candidate,
  daily_news.source_state,
  daily_news.refresh_lease,
  daily_news.runtime_state,
  daily_news.report_snapshot,
  daily_news.refresh_run
restart identity;
insert into daily_news.runtime_state (singleton_id) values (true);
insert into daily_news.refresh_lease (singleton_id) values (true);

select plan(73);

select has_schema('daily_news', 'private daily_news schema exists');
select has_table('daily_news', 'refresh_run', 'refresh_run table exists');
select has_table('daily_news', 'report_snapshot', 'report_snapshot table exists');
select has_table('daily_news', 'runtime_state', 'runtime_state table exists');
select has_table('daily_news', 'refresh_lease', 'refresh_lease table exists');
select has_table('daily_news', 'source_state', 'source_state table exists');
select has_table('daily_news', 'article_candidate', 'article_candidate table exists');
select ok(
  to_regprocedure(
    'public.daily_news_commit_refresh(uuid,uuid,bigint,jsonb,jsonb,uuid,timestamptz,text,jsonb,text,text,timestamptz,timestamptz,jsonb)'
  ) is not null,
  'atomic refresh commit RPC exists'
);

select is(
  (
    select count(*)::integer
    from pg_class as relation
    join pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'daily_news'
      and relation.relkind = 'r'
      and relation.relrowsecurity
  ),
  6,
  'all six durable tables enable RLS'
);
select is(
  (
    select count(*)::integer
    from pg_policies
    where schemaname = 'daily_news'
  ),
  0,
  'private tables intentionally expose no RLS policies'
);
select ok(
  not has_table_privilege('anon', 'daily_news.source_state', 'select'),
  'anon cannot read source state'
);
select ok(
  not has_table_privilege('authenticated', 'daily_news.article_candidate', 'insert'),
  'authenticated cannot insert candidates'
);
select ok(
  not has_function_privilege('anon', 'public.daily_news_read_latest()', 'execute'),
  'anon cannot execute latest-report RPC'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.daily_news_try_acquire_refresh(uuid,text,text,timestamptz,integer)',
    'execute'
  ),
  'authenticated cannot execute acquire RPC'
);
select ok(
  has_function_privilege('service_role', 'public.daily_news_read_latest()', 'execute'),
  'service_role can execute latest-report RPC'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.daily_news_try_acquire_refresh(uuid,text,text,timestamptz,integer)',
    'execute'
  ),
  'service_role can execute acquire RPC'
);
select ok(
  not exists (
    select 1
    from pg_proc as procedure
    join pg_namespace as namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and procedure.proname like 'daily_news_%'
      and (
        has_function_privilege('anon', procedure.oid, 'execute')
        or has_function_privilege('authenticated', procedure.oid, 'execute')
        or exists (
          select 1
          from aclexplode(coalesce(procedure.proacl, acldefault('f', procedure.proowner))) as privilege
          where privilege.grantee = 0
            and privilege.privilege_type = 'EXECUTE'
        )
      )
  ),
  'every Daily News RPC denies PUBLIC, anon, and authenticated execution'
);
select ok(
  not exists (
    select 1
    from pg_proc as procedure
    join pg_namespace as namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and procedure.proname like 'daily_news_%'
      and not has_function_privilege('service_role', procedure.oid, 'execute')
  ),
  'service_role can execute every Daily News RPC'
);
select ok(
  to_regprocedure(
    'public.daily_news_complete_refresh_without_publish(uuid,uuid,bigint,jsonb)'
  ) is not null,
  'quiet-success completion RPC exists'
);
select ok(
  position(
    'timeout_milliseconds := 55000'
    in pg_get_functiondef('public.daily_news_install_refresh_cron()'::regprocedure)
  ) > 0,
  'Supabase Cron allows 55 seconds for the Vercel refresh request'
);
select ok(
  exists (
    select 1
    from pg_index as index_definition
    join pg_class as index_relation on index_relation.oid = index_definition.indexrelid
    join pg_class as table_relation on table_relation.oid = index_definition.indrelid
    join pg_namespace as table_namespace on table_namespace.oid = table_relation.relnamespace
    where table_namespace.nspname = 'daily_news'
      and table_relation.relname = 'report_snapshot'
      and index_relation.relname = 'report_snapshot_content_hash_idx'
      and not index_definition.indisunique
  ),
  'report content hash has a non-unique lookup index'
);

create temporary table test_first_lease as
select *
from public.daily_news_try_acquire_refresh(
  '11111111-1111-4111-8111-111111111111'::uuid,
  'cron:2026-07-13T00:00Z',
  'cron',
  '2026-07-13T00:00:00Z'::timestamptz,
  120
);

select ok((select acquired from test_first_lease), 'first worker acquires refresh lease');
select is(
  (
    select upserted_count
    from public.daily_news_sync_sources(
      '11111111-1111-4111-8111-111111111111'::uuid,
      (select run_id from test_first_lease),
      (select fencing_token from test_first_lease),
      '[
        {"sourceId":"source-a","enabled":true,"intervalMinutes":30},
        {"sourceId":"source-b","enabled":true,"intervalMinutes":90}
      ]'::jsonb,
      '2026-07-13T00:00:00Z'::timestamptz
    )
  ),
  2,
  'source registry sync creates both source states under the active lease'
);
select is(
  (select count(*)::integer from public.daily_news_list_source_states()),
  2,
  'source-state RPC returns the complete registry'
);
select is(
  (
    select outcome
    from public.daily_news_try_acquire_refresh(
      '22222222-2222-4222-8222-222222222222'::uuid,
      'cron:2026-07-13T00:15Z',
      'cron',
      '2026-07-13T00:15:00Z'::timestamptz,
      120
    )
  ),
  'busy',
  'second worker sees active lease as busy'
);
select is(
  (
    select updated_count
    from public.daily_news_record_source_results(
      '11111111-1111-4111-8111-111111111111'::uuid,
      (select run_id from test_first_lease),
      (select fencing_token from test_first_lease),
      '[{
        "sourceId":"source-a",
        "attemptedAt":"2026-07-13T00:00:05Z",
        "success":true,
        "nextDueAt":"2026-07-13T00:30:05Z",
        "latencyMs":100,
        "discoveredCount":1,
        "acceptedCount":1
      }]'::jsonb
    )
  ),
  1,
  'source result updates durable state under the active lease'
);
select ok(
  (select last_success_at is not null from daily_news.source_state where source_id = 'source-a'),
  'successful source result records last_success_at'
);

do $$
declare
  active_run_id uuid;
  active_fencing_token bigint;
begin
  select run_id, fencing_token
    into active_run_id, active_fencing_token
    from test_first_lease;

  perform public.daily_news_record_source_results(
    '11111111-1111-4111-8111-111111111111'::uuid,
    active_run_id,
    active_fencing_token,
    '[{"sourceId":"source-b","attemptedAt":"2026-07-13T00:00:06Z","success":false,"nextDueAt":"2026-07-13T01:30:06Z","errorCode":"fetch_failed"}]'::jsonb
  );
  perform public.daily_news_record_source_results(
    '11111111-1111-4111-8111-111111111111'::uuid,
    active_run_id,
    active_fencing_token,
    '[{"sourceId":"source-b","attemptedAt":"2026-07-13T00:00:07Z","success":false,"nextDueAt":"2026-07-13T01:30:07Z","errorCode":"fetch_failed"}]'::jsonb
  );
end;
$$;

select ok(
  (
    select consecutive_failures = 2 and circuit_open_until is null
    from daily_news.source_state
    where source_id = 'source-b'
  ),
  'the first two source failures do not open the circuit'
);

do $$
declare
  active_run_id uuid;
  active_fencing_token bigint;
begin
  select run_id, fencing_token
    into active_run_id, active_fencing_token
    from test_first_lease;

  perform public.daily_news_record_source_results(
    '11111111-1111-4111-8111-111111111111'::uuid,
    active_run_id,
    active_fencing_token,
    '[{"sourceId":"source-b","attemptedAt":"2026-07-13T00:00:08Z","success":false,"nextDueAt":"2026-07-13T01:30:08Z","errorCode":"fetch_failed"}]'::jsonb
  );
end;
$$;

select is(
  (select consecutive_failures from daily_news.source_state where source_id = 'source-b'),
  3,
  'the third source failure reaches the circuit-breaker threshold'
);
select is(
  (select circuit_open_until from daily_news.source_state where source_id = 'source-b'),
  '2026-07-13T03:00:08Z'::timestamptz,
  'the third failure opens the circuit for two source intervals'
);
select ok(
  not exists (
    select 1
    from public.daily_news_list_due_sources('2026-07-13T02:00:00Z'::timestamptz, 10)
    where source_id = 'source-b'
  ),
  'an open source circuit excludes the source from due work'
);

do $$
declare
  active_run_id uuid;
  active_fencing_token bigint;
begin
  select run_id, fencing_token
    into active_run_id, active_fencing_token
    from test_first_lease;

  perform public.daily_news_record_source_results(
    '11111111-1111-4111-8111-111111111111'::uuid,
    active_run_id,
    active_fencing_token,
    '[{"sourceId":"source-b","attemptedAt":"2026-07-13T03:00:09Z","success":true,"nextDueAt":"2026-07-13T04:30:09Z"}]'::jsonb
  );
end;
$$;

select ok(
  (
    select consecutive_failures = 0
      and circuit_open_until is null
      and last_error_code is null
    from daily_news.source_state
    where source_id = 'source-b'
  ),
  'a successful source result resets failures and closes the circuit'
);

select is(
  (
    select upserted_count
    from public.daily_news_sync_sources(
      '11111111-1111-4111-8111-111111111111'::uuid,
      (select run_id from test_first_lease),
      (select fencing_token from test_first_lease),
      '[{"sourceId":"source-a","enabled":true,"intervalMinutes":30}]'::jsonb,
      '2026-07-13T03:00:10Z'::timestamptz
    )
  ),
  1,
  'source registry resync reports the current payload size'
);
select ok(
  (select not enabled from daily_news.source_state where source_id = 'source-b'),
  'source registry resync disables a legacy source missing from the full payload'
);

select is(
  (
    select upserted_count
    from public.daily_news_upsert_candidates(
      '11111111-1111-4111-8111-111111111111'::uuid,
      (select run_id from test_first_lease),
      (select fencing_token from test_first_lease),
      '[{
        "candidateId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "sourceId":"source-a",
        "canonicalUrl":"https://example.com/news/1",
        "title":"测试新闻",
        "summary":"第一版摘要",
        "publishedAt":"2026-07-12T23:50:00Z",
        "discoveredAt":"2026-07-13T00:00:05Z",
        "contentFingerprint":"candidate-hash-1",
        "qualityStatus":"accepted",
        "payload":{"id":"raw-1","url":"https://example.com/news/1"}
      }]'::jsonb
    )
  ),
  1,
  'first candidate upsert succeeds'
);
select is(
  (
    select upserted_count
    from public.daily_news_upsert_candidates(
      '11111111-1111-4111-8111-111111111111'::uuid,
      (select run_id from test_first_lease),
      (select fencing_token from test_first_lease),
      '[{
        "candidateId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        "sourceId":"source-a",
        "canonicalUrl":"https://example.com/news/1",
        "title":"测试新闻更新",
        "summary":"第二版摘要",
        "publishedAt":"2026-07-12T23:50:00Z",
        "discoveredAt":"2026-07-13T00:01:00Z",
        "contentFingerprint":"candidate-hash-2",
        "qualityStatus":"accepted",
        "payload":{"id":"raw-1","url":"https://example.com/news/1"}
      }]'::jsonb
    )
  ),
  1,
  'duplicate source and canonical URL is an idempotent upsert'
);
select is(
  (select count(*)::integer from daily_news.article_candidate),
  1,
  'candidate unique key prevents duplicate rows'
);
select is(
  (
    select count(*)::integer
    from public.daily_news_read_candidates('2026-07-10T00:00:00Z'::timestamptz, 100)
  ),
  1,
  'candidate window RPC reads the accepted candidate'
);

create temporary table test_first_publish as
select *
from public.daily_news_publish_refresh(
  '11111111-1111-4111-8111-111111111111'::uuid,
  (select run_id from test_first_lease),
  (select fencing_token from test_first_lease),
  '33333333-3333-4333-8333-333333333333'::uuid,
  '2026-07-13T00:02:00Z'::timestamptz,
  '2',
  '{"generatedAt":"2026-07-13T00:02:00Z","items":[{"id":"story-1"}]}'::jsonb,
  repeat('a', 64),
  'input-1',
  '2026-07-13T00:02:00Z'::timestamptz,
  '2026-07-12T23:50:00Z'::timestamptz,
  '{"accepted":1}'::jsonb
);

select ok((select published from test_first_publish), 'publish creates a new snapshot');
select is(
  (select report_id from public.daily_news_read_latest()),
  '33333333-3333-4333-8333-333333333333'::uuid,
  'latest pointer reads the published report'
);
select is(
  (select status from daily_news.refresh_run where run_id = (select run_id from test_first_lease)),
  'published',
  'successful publish marks the run published'
);
select ok(
  (select run_id is null from daily_news.refresh_lease where singleton_id),
  'successful publish releases the lease'
);
select throws_ok(
  $$update daily_news.report_snapshot set generated_at = clock_timestamp()$$,
  '55000',
  'daily_news report snapshots are immutable',
  'published snapshots reject updates'
);

create temporary table test_unchanged_lease as
select *
from public.daily_news_try_acquire_refresh(
  '44444444-4444-4444-8444-444444444444'::uuid,
  'cron:2026-07-13T00:15Z',
  'cron',
  '2026-07-13T00:15:00Z'::timestamptz,
  120
);
select ok((select acquired from test_unchanged_lease), 'next time slot acquires a new lease');

create temporary table test_unchanged_publish as
select *
from public.daily_news_publish_refresh(
  '44444444-4444-4444-8444-444444444444'::uuid,
  (select run_id from test_unchanged_lease),
  (select fencing_token from test_unchanged_lease),
  '55555555-5555-4555-8555-555555555555'::uuid,
  '2026-07-13T00:16:00Z'::timestamptz,
  '2',
  '{"generatedAt":"2026-07-13T00:16:00Z","items":[{"id":"story-1"}]}'::jsonb,
  repeat('a', 64),
  'input-2',
  '2026-07-13T00:16:00Z'::timestamptz,
  '2026-07-12T23:50:00Z'::timestamptz,
  '{}'::jsonb
);
select ok(not (select published from test_unchanged_publish), 'same content hash returns unchanged');
select is(
  (select count(*)::integer from daily_news.report_snapshot),
  1,
  'unchanged content does not create a second snapshot'
);
select is(
  (select report_id from public.daily_news_read_latest()),
  '33333333-3333-4333-8333-333333333333'::uuid,
  'unchanged content does not move latest pointer'
);

create temporary table test_quiet_lease as
select *
from public.daily_news_try_acquire_refresh(
  '66666666-6666-4666-8666-666666666666'::uuid,
  'cron:2026-07-13T00:30Z',
  'cron',
  '2026-07-13T00:30:00Z'::timestamptz,
  120
);
create temporary table test_quiet_complete as
select *
from public.daily_news_complete_refresh_without_publish(
  '66666666-6666-4666-8666-666666666666'::uuid,
  (select run_id from test_quiet_lease),
  (select fencing_token from test_quiet_lease),
  '{"reason":"no_change"}'::jsonb
);
select ok((select completed from test_quiet_complete), 'quiet success completes and releases the lease');
select is(
  (select report_id from public.daily_news_read_latest()),
  '33333333-3333-4333-8333-333333333333'::uuid,
  'quiet success preserves latest report ID'
);
select ok(
  (select last_success_at is not null from public.daily_news_read_latest()),
  'quiet success advances durable last_success_at'
);

create temporary table test_stale_lease as
select *
from public.daily_news_try_acquire_refresh(
  '77777777-7777-4777-8777-777777777777'::uuid,
  'cron:2026-07-13T00:45Z',
  'cron',
  '2026-07-13T00:45:00Z'::timestamptz,
  120
);
select ok((select acquired from test_stale_lease), 'worker acquires lease before fencing test');
update daily_news.refresh_lease
set lease_expires_at = clock_timestamp() - interval '1 second'
where singleton_id;

create temporary table test_takeover_lease as
select *
from public.daily_news_try_acquire_refresh(
  '88888888-8888-4888-8888-888888888888'::uuid,
  'cron:2026-07-13T01:00Z',
  'cron',
  '2026-07-13T01:00:00Z'::timestamptz,
  120
);
select ok((select acquired from test_takeover_lease), 'new worker takes over an expired lease');
select ok(
  (select fencing_token from test_takeover_lease) > (select fencing_token from test_stale_lease),
  'takeover receives a higher fencing token'
);
select is(
  (
    select status
    from daily_news.refresh_run
    where run_id = (select run_id from test_stale_lease)
  ),
  'failed',
  'takeover closes the expired refresh run as failed'
);
select is(
  (
    select error_code
    from daily_news.refresh_run
    where run_id = (select run_id from test_stale_lease)
  ),
  'lease_expired',
  'the expired refresh run records a normalized error code'
);
select ok(
  (
    select finished_at is not null and run_metrics ->> 'leaseOutcome' = 'expired'
    from daily_news.refresh_run
    where run_id = (select run_id from test_stale_lease)
  ),
  'the expired refresh run records terminal timing and audit metadata'
);
select throws_ok(
  $sql$
    select *
    from public.daily_news_publish_refresh(
      '77777777-7777-4777-8777-777777777777'::uuid,
      (select run_id from test_stale_lease),
      (select fencing_token from test_stale_lease),
      '99999999-9999-4999-8999-999999999999'::uuid,
      '2026-07-13T01:00:01Z'::timestamptz,
      '2',
      '{"generatedAt":"2026-07-13T01:00:01Z","items":[]}'::jsonb,
      repeat('c', 64),
      'stale-input',
      '2026-07-13T01:00:01Z'::timestamptz,
      null,
      '{}'::jsonb
    )
  $sql$,
  '42501',
  'refresh lease is missing, expired, or fenced',
  'stale worker cannot publish after fencing takeover'
);
select ok(
  (
    select marked
    from public.daily_news_mark_refresh_failed(
      '88888888-8888-4888-8888-888888888888'::uuid,
      (select run_id from test_takeover_lease),
      (select fencing_token from test_takeover_lease),
      'test_failure',
      '{}'::jsonb
    )
  ),
  'current worker can record failure and release the lease'
);
select is(
  (select report_id from public.daily_news_read_latest()),
  '33333333-3333-4333-8333-333333333333'::uuid,
  'failed refresh preserves last-known-good latest pointer'
);

create temporary table test_second_publish_lease as
select *
from public.daily_news_try_acquire_refresh(
  'aaaaaaaa-1111-4111-8111-111111111111'::uuid,
  'manual:second-report',
  'manual',
  '2026-07-13T01:15:00Z'::timestamptz,
  120
);
select ok((select acquired from test_second_publish_lease), 'manual run acquires lease for second report');
select ok(
  (
    select published
    from public.daily_news_publish_refresh(
      'aaaaaaaa-1111-4111-8111-111111111111'::uuid,
      (select run_id from test_second_publish_lease),
      (select fencing_token from test_second_publish_lease),
      'bbbbbbbb-2222-4222-8222-222222222222'::uuid,
      '2026-07-13T01:16:00Z'::timestamptz,
      '2',
      '{"generatedAt":"2026-07-13T01:16:00Z","items":[{"id":"story-2"}]}'::jsonb,
      repeat('b', 64),
      'input-3',
      '2026-07-13T01:16:00Z'::timestamptz,
      '2026-07-13T01:10:00Z'::timestamptz,
      '{}'::jsonb
    )
  ),
  'second distinct report publishes successfully'
);
select is(
  (select report_id from public.daily_news_read_latest()),
  'bbbbbbbb-2222-4222-8222-222222222222'::uuid,
  'latest pointer moves to the second report'
);

create temporary table test_republish_lease as
select *
from public.daily_news_try_acquire_refresh(
  'cccccccc-3333-4333-8333-333333333333'::uuid,
  'manual:republish-first-content',
  'manual',
  '2026-07-13T01:30:00Z'::timestamptz,
  120
);
create temporary table test_republish as
select *
from public.daily_news_publish_refresh(
  'cccccccc-3333-4333-8333-333333333333'::uuid,
  (select run_id from test_republish_lease),
  (select fencing_token from test_republish_lease),
  'dddddddd-4444-4444-8444-444444444444'::uuid,
  '2026-07-13T01:31:00Z'::timestamptz,
  '2',
  '{"generatedAt":"2026-07-13T01:31:00Z","items":[{"id":"story-1"}]}'::jsonb,
  repeat('a', 64),
  'input-4',
  '2026-07-13T01:31:00Z'::timestamptz,
  '2026-07-12T23:50:00Z'::timestamptz,
  '{}'::jsonb
);
select ok((select published from test_republish), 'A to B to A is a visible publication, not unchanged');
select is((select outcome from test_republish), 'published', 'historical content is published as a new snapshot');
select is(
  (select published_report_id from test_republish),
  'dddddddd-4444-4444-8444-444444444444'::uuid,
  'republished content returns the new immutable snapshot ID'
);
select is(
  (select report_id from public.daily_news_read_latest()),
  'dddddddd-4444-4444-8444-444444444444'::uuid,
  'republished content atomically points latest to the new snapshot C'
);
select ok(
  (
    select generated_at = '2026-07-13T01:31:00Z'::timestamptz
      and data_as_of = '2026-07-13T01:31:00Z'::timestamptz
    from public.daily_news_read_latest()
  ),
  'republished content exposes the current run timestamps'
);
select ok(
  (
    select supersedes_report_id = 'bbbbbbbb-2222-4222-8222-222222222222'::uuid
      and content_hash = repeat('a', 64)
      and run_id = (select run_id from test_republish_lease)
    from daily_news.report_snapshot
    where report_id = 'dddddddd-4444-4444-8444-444444444444'::uuid
  ),
  'snapshot C preserves the A content hash and supersedes B in the audit chain'
);
select is(
  (select count(*)::integer from daily_news.report_snapshot),
  3,
  'A to B to A creates three immutable snapshots'
);
select is(
  (
    select run_metrics ->> 'publishOutcome'
    from daily_news.refresh_run
    where run_id = (select run_id from test_republish_lease)
  ),
  'published',
  'the republishing refresh run is auditable as published'
);
select is(
  (
    select report_id
    from public.daily_news_rollback_latest(
      '33333333-3333-4333-8333-333333333333'::uuid,
      'test_rollback'
    )
  ),
  '33333333-3333-4333-8333-333333333333'::uuid,
  'rollback RPC returns the target report'
);
select is(
  (select report_id from public.daily_news_read_latest()),
  '33333333-3333-4333-8333-333333333333'::uuid,
  'rollback atomically restores the previous report'
);
select is(
  (select count(*)::integer from daily_news.report_snapshot),
  3,
  'rollback preserves all three immutable snapshots for audit'
);

select * from finish();
rollback;
