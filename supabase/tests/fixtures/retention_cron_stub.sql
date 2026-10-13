-- Offline test double for pg_cron's stable alter_job(jobid,schedule,command) API.
-- A fresh cluster intentionally has no Cron; this fixture only exercises deployed-job upgrade.
create schema cron;
create table cron.job(jobid bigint primary key,jobname text,schedule text,command text,active boolean);
insert into cron.job values
 (1,'daily-news-retention','30 3 * * *','select * from public.daily_news_prune_retention(false, 7, 2, 30, 7, 30)',true),
 (2,'unrelated-job','0 0 * * *','select 42',true),
 (3,'daily-news-refresh','0 */2 * * *','select 43',false),
 (4,'daily-news-retention','30 3 * * *','select * from public.daily_news_prune_retention(false, 7, 2, 30, 7, 30)',false);
create function cron.alter_job(jobid bigint,schedule text,command text) returns void language sql as $$
 update cron.job set schedule=$2,command=$3 where cron.job.jobid=$1;
$$;
