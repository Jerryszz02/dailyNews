-- Local/CI regression: every mutation is rolled back at the end.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, pg_catalog;
select no_plan();

truncate table daily_news.article_candidate, daily_news.source_state,
  daily_news.refresh_lease, daily_news.runtime_state,
  daily_news.report_snapshot, daily_news.refresh_run restart identity;
insert into daily_news.runtime_state (singleton_id) values (true);
insert into daily_news.refresh_lease (singleton_id) values (true);

select has_column('daily_news', 'source_state', 'collection_cursor', 'cursor column exists');
select ok(not has_function_privilege('anon', 'public.daily_news_list_source_states_v2()', 'execute'), 'anonymous readers cannot read cursors');
select ok(not has_function_privilege('service_role', 'daily_news.apply_collection_cursors(jsonb)', 'execute'), 'cursor helper cannot bypass fenced wrappers');
select ok(has_function_privilege('service_role', 'public.daily_news_record_source_results_v2(uuid,uuid,bigint,jsonb)', 'execute'), 'service role may use fenced cursor RPC');

create temporary table test_cursor_lease as
select *, '10000000-0000-0000-0000-000000000001'::uuid as owner_id
from public.daily_news_try_acquire_refresh_v2(
  '10000000-0000-0000-0000-000000000001', 'cursor:migration-test', 'manual', clock_timestamp(), 120
);
select ok((select acquired from test_cursor_lease), 'lease acquired');
select * from public.daily_news_sync_sources(
  (select owner_id from test_cursor_lease), (select run_id from test_cursor_lease),
  (select fencing_token from test_cursor_lease),
  '[{"sourceId":"x-test","enabled":true,"intervalMinutes":120}]'::jsonb
);

select * from public.daily_news_record_source_results_v2(
  (select owner_id from test_cursor_lease), (select run_id from test_cursor_lease),
  (select fencing_token from test_cursor_lease),
  '[{"sourceId":"x-test","status":"empty","discoveredCount":0,"acceptedCount":0,"collectionCursor":{"userId":"42","sinceId":"9007199254740993"}}]'::jsonb
);
select is(
  (select collection_cursor->>'sinceId' from public.daily_news_list_source_states_v2() where source_id = 'x-test'),
  '9007199254740993', 'read RPC preserves IDs above JS safe integer'
);

select throws_ok(
  format($q$select * from public.daily_news_record_source_results_v2(%L::uuid,%L::uuid,%s,
    '[{"sourceId":"x-test","status":"empty","collectionCursor":{"userId":"42","sinceId":"invalid"}}]'::jsonb)$q$,
    (select owner_id from test_cursor_lease), (select run_id from test_cursor_lease), (select fencing_token from test_cursor_lease)),
  '22023', 'collection cursor is invalid', 'invalid cursor rejects the complete transaction'
);
select is((select collection_cursor->>'sinceId' from daily_news.source_state where source_id='x-test'),
  '9007199254740993', 'failed cursor validation leaves prior progress intact');

select throws_ok(
  format($q$select * from public.daily_news_record_source_results_v2(%L::uuid,%L::uuid,%s,
    '[{"sourceId":"x-test","status":"empty","collectionCursor":{"userId":"42","sinceId":"9007199254740994"}}]'::jsonb)$q$,
    (select owner_id from test_cursor_lease), (select run_id from test_cursor_lease), (select fencing_token + 1 from test_cursor_lease)),
  '42501', 'refresh lease is missing, expired, or fenced', 'stale fencing token cannot advance a cursor'
);

select * from public.daily_news_finish_without_publish_v3(
  (select owner_id from test_cursor_lease), (select run_id from test_cursor_lease),
  (select fencing_token from test_cursor_lease),
  '[{"sourceId":"x-test","status":"empty","collectionCursor":{"userId":"42","sinceId":"9007199254740994"}}]'::jsonb,
  '[]'::jsonb, '{}'::jsonb, 'unchanged'
);
select is((select collection_cursor->>'sinceId' from daily_news.source_state where source_id='x-test'),
  '9007199254740994', 'valid unchanged completion persists cursor progress');
select is(
  (select run_metrics#>>'{terminalResult,outcome}' from daily_news.refresh_run where run_id=(select run_id from test_cursor_lease)),
  'unchanged', 'cursor wrapper preserves v2 terminal reconciliation metadata'
);
select * from finish();
rollback;
