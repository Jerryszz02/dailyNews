-- Keep the existing two-hour scheduler while allowing the bounded refresh to
-- use the full Vercel invocation window. Existing jobs are altered in place;
-- their active/disabled state is preserved.
create or replace function public.daily_news_install_refresh_cron()
returns bigint
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  existing_job_id bigint;
  command_sql text := $job$
    select net.http_get(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'daily_news_refresh_url'),
      headers := jsonb_build_object(
        'Authorization',
        'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'daily_news_cron_secret')
      ),
      timeout_milliseconds := 295000
    );
  $job$;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron')
     or not exists (select 1 from pg_extension where extname = 'pg_net')
     or not exists (select 1 from pg_extension where extname = 'supabase_vault') then
    raise exception using errcode = '55000', message = 'pg_cron, pg_net, and supabase_vault must be enabled first';
  end if;
  if (select decrypted_secret from vault.decrypted_secrets where name = 'daily_news_refresh_url') is null
     or (select decrypted_secret from vault.decrypted_secrets where name = 'daily_news_refresh_url') !~ '^https://.*/api/cron$' then
    raise exception using errcode = '22023', message = 'Vault secret daily_news_refresh_url must be an HTTPS /api/cron URL';
  end if;
  if (select decrypted_secret from vault.decrypted_secrets where name = 'daily_news_cron_secret') is null
     or char_length((select decrypted_secret from vault.decrypted_secrets where name = 'daily_news_cron_secret')) < 16 then
    raise exception using errcode = '22023', message = 'Vault secret daily_news_cron_secret is missing or too short';
  end if;
  select jobid into existing_job_id from cron.job where jobname = 'daily-news-refresh';
  if existing_job_id is not null then
    perform cron.alter_job(existing_job_id, schedule := '0 */2 * * *', command := command_sql);
    return existing_job_id;
  end if;
  return cron.schedule('daily-news-refresh', '0 */2 * * *', command_sql);
end;
$$;

do $update_existing_refresh_job$
declare
  existing_job_id bigint;
  command_sql text := $job$
    select net.http_get(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'daily_news_refresh_url'),
      headers := jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'daily_news_cron_secret')),
      timeout_milliseconds := 295000
    );
  $job$;
begin
  if to_regclass('cron.job') is null then return; end if;
  select jobid into existing_job_id from cron.job where jobname = 'daily-news-refresh';
  if existing_job_id is not null then
    perform cron.alter_job(existing_job_id, command := command_sql);
  end if;
end;
$update_existing_refresh_job$;
