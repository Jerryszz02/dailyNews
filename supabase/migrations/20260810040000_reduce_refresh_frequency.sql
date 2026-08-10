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
