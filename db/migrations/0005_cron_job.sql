-- 0005_cron_job.sql
-- Runs the app's background jobs every minute from inside Supabase:
-- pg_cron triggers pg_net to POST /internal/cron with the CRON_SECRET.
-- Needed on hosts without minute-level cron (e.g. Vercel Hobby).
--
-- The URL and secret live in Supabase Vault, never in this file:
--   select vault.create_secret('https://<host>/internal/cron', 'platform_cron_url');
--   select vault.create_secret('<CRON_SECRET>', 'platform_cron_secret');
-- Until both exist the job does nothing. Databases without pg_cron/pg_net
-- (local development, tests) skip this migration.
do $migration$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron')
     or not exists (select 1 from pg_available_extensions where name = 'pg_net')
     or not exists (select 1 from pg_namespace where nspname = 'vault') then
    raise notice 'pg_cron, pg_net or vault not available; skipping platform cron job';
    return;
  end if;
  execute 'create extension if not exists pg_cron';
  execute 'create extension if not exists pg_net';
  perform cron.schedule('platform-maintenance', '* * * * *', $job$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'platform_cron_url'),
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'platform_cron_secret'),
        'Content-Type', 'application/json'),
      body := '{}'::jsonb,
      timeout_milliseconds := 25000)
    where exists (select 1 from vault.decrypted_secrets where name = 'platform_cron_url')
      and exists (select 1 from vault.decrypted_secrets where name = 'platform_cron_secret');
  $job$);
end
$migration$;
