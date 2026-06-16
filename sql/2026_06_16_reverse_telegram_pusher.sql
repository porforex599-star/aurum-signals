-- =====================================================================
-- AURUM AI — Phase B.4 follow-up: remove the Telegram News Pusher
-- Project: aurum-customers (etwlurpjrqlvrxgsbhkd)
-- Applied 2026-06-16 via Supabase MCP.
--
-- Strategy change: customers consume market news inside /room only — there is
-- no public Telegram channel push. This reverses everything the pusher half of
-- Phase B.4 added; the scheduled-analyzer (3x/day /room briefings) stays.
--
-- TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID secrets are kept — scheduled-analyzer
-- still uses them for its 3-strikes admin failure alerts.
--
-- NOTE: the telegram-news-pusher Edge Function itself must be removed out of
-- band (no MCP delete tool): `supabase functions delete telegram-news-pusher`
-- or via the dashboard. Its cron job is dropped below, so it is already inert.
-- =====================================================================

-- Drop the 5-min pusher cron (no-op if already gone).
SELECT cron.unschedule('telegram_pusher_cron')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'telegram_pusher_cron');

-- Drop the pusher health table.
DROP TABLE IF EXISTS public.telegram_pusher_state;

-- Drop the partial index + the bookkeeping columns on daily_news.
DROP INDEX IF EXISTS public.idx_daily_news_pending_telegram;
ALTER TABLE public.daily_news
  DROP COLUMN IF EXISTS pushed_to_telegram,
  DROP COLUMN IF EXISTS telegram_pushed_at;
