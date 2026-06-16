-- =====================================================================
-- AURUM AI — Phase B.4 cron jobs (pg_cron + pg_net)
-- Project: aurum-customers (etwlurpjrqlvrxgsbhkd)
-- Applied 2026-06-16 via Supabase MCP.
--
-- Four jobs. Each authenticates with the service-role key from Vault, exactly
-- like the existing news_fetcher_cron / article_generator_cron jobs.
--
--   scheduled_analyzer_morning    09:00 Asia/Bangkok = 02:00 UTC
--   scheduled_analyzer_afternoon  14:00 Asia/Bangkok = 07:00 UTC
--   scheduled_analyzer_evening    20:00 Asia/Bangkok = 13:00 UTC
--   telegram_pusher_cron          every 5 min
--
-- cron.schedule with an existing jobname re-defines that job (no duplicates on
-- re-apply).
-- =====================================================================

-- 09:00 Asia/Bangkok (morning)
SELECT cron.schedule('scheduled_analyzer_morning', '0 2 * * *', $$
  SELECT net.http_post(
    url := 'https://etwlurpjrqlvrxgsbhkd.supabase.co/functions/v1/scheduled-analyzer',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{"slot":"morning"}'::jsonb,
    timeout_milliseconds := 120000
  );
$$);

-- 14:00 Asia/Bangkok (afternoon)
SELECT cron.schedule('scheduled_analyzer_afternoon', '0 7 * * *', $$
  SELECT net.http_post(
    url := 'https://etwlurpjrqlvrxgsbhkd.supabase.co/functions/v1/scheduled-analyzer',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{"slot":"afternoon"}'::jsonb,
    timeout_milliseconds := 120000
  );
$$);

-- 20:00 Asia/Bangkok (evening)
SELECT cron.schedule('scheduled_analyzer_evening', '0 13 * * *', $$
  SELECT net.http_post(
    url := 'https://etwlurpjrqlvrxgsbhkd.supabase.co/functions/v1/scheduled-analyzer',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{"slot":"evening"}'::jsonb,
    timeout_milliseconds := 120000
  );
$$);

-- every 5 min — push pending high-impact news to the customer channel
SELECT cron.schedule('telegram_pusher_cron', '*/5 * * * *', $$
  SELECT net.http_post(
    url := 'https://etwlurpjrqlvrxgsbhkd.supabase.co/functions/v1/telegram-news-pusher',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
$$);
