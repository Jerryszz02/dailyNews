-- Fixtures are installed only by --upgrade-fixture on a fresh disposable cluster.
DO $$
begin
 if to_regprocedure('public.daily_news_prune_retention(boolean,integer,integer,integer,integer,integer)') is not null
 then raise exception 'legacy overload survived'; end if;
 if (select count(*) from cron.job)<>4 then raise exception 'upgrade created/deleted jobs'; end if;
 if not exists(select 1 from cron.job where jobid=1 and schedule='*/15 * * * *'
   and command='select * from public.daily_news_prune_retention(false, 25)' and active)
 then raise exception 'retention Cron not upgraded'; end if;
 if not exists(select 1 from cron.job where jobid=4 and schedule='*/15 * * * *'
 and command='select * from public.daily_news_prune_retention(false, 25)' and not active)
 then raise exception 'paused retention was enabled or not upgraded'; end if;
 if not exists(select 1 from cron.job where jobid=2 and schedule='0 0 * * *' and command='select 42')
 or not exists(select 1 from cron.job where jobid=3 and schedule='0 */2 * * *' and command='select 43' and not active)
 then raise exception 'other schedules changed'; end if;
 perform public.daily_news_prune_retention();
end $$;
