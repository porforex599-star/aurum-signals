-- =====================================================================
-- AURUM AI — Phase B.4: Scheduled AI Analyzer + Telegram News Pusher
-- Project: aurum-customers (etwlurpjrqlvrxgsbhkd)
-- Applied 2026-06-16 via Supabase MCP (migration:
--   phase_b4_scheduled_analyzer_and_telegram_push).
--
-- Two autonomous additions on top of the Phase B / B.5 news ecosystem:
--
--   1. scheduled-analyzer — 3x/day Claude Sonnet market briefings written
--      into analysis_posts (source='ai_scheduled', schedule_slot=
--      morning|afternoon|evening). Those two columns already exist from the
--      Phase B migration; nothing new is needed on analysis_posts. The
--      briefing prose is stored in analysis_posts.note (the field /room's
--      mapRow already renders) — analysis_posts has no title/body columns.
--
--   2. telegram-news-pusher — every 5 min, pushes any not-yet-pushed
--      impact='high' daily_news row into the customer Telegram channel.
--      Needs two new daily_news columns + a partial index for the cheap poll.
--
-- Each edge function tracks consecutive whole-run failures in its own state
-- table (mirrors news_fetcher_state / article_generator_state) so a 3-strikes
-- Telegram alert can be raised without one outage masking the other.
-- =====================================================================

-- ---- daily_news: Telegram push bookkeeping ------------------------------
ALTER TABLE public.daily_news
  ADD COLUMN IF NOT EXISTS pushed_to_telegram BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS telegram_pushed_at TIMESTAMPTZ;

-- Partial index — the pusher polls "high-impact rows not yet pushed", newest
-- first. Kept tiny (only the pending high-impact tail) so the 5-min cron stays
-- cheap even as daily_news grows.
CREATE INDEX IF NOT EXISTS idx_daily_news_pending_telegram
  ON public.daily_news(published_at DESC)
  WHERE pushed_to_telegram = FALSE AND impact = 'high';

-- ---- scheduled_analyzer_state (cron health, 3-strikes Telegram alert) ----
CREATE TABLE IF NOT EXISTS public.scheduled_analyzer_state (
  id INT PRIMARY KEY DEFAULT 1,
  consecutive_failures INT NOT NULL DEFAULT 0,
  last_run_at TIMESTAMPTZ,
  last_error TEXT,
  CONSTRAINT scheduled_analyzer_state_single_row CHECK (id = 1)
);
INSERT INTO public.scheduled_analyzer_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.scheduled_analyzer_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "scheduled_analyzer_state_service_all" ON public.scheduled_analyzer_state;
CREATE POLICY "scheduled_analyzer_state_service_all" ON public.scheduled_analyzer_state FOR ALL USING (auth.role() = 'service_role');

-- ---- telegram_pusher_state (cron health, 3-strikes Telegram alert) -------
CREATE TABLE IF NOT EXISTS public.telegram_pusher_state (
  id INT PRIMARY KEY DEFAULT 1,
  consecutive_failures INT NOT NULL DEFAULT 0,
  last_run_at TIMESTAMPTZ,
  last_error TEXT,
  CONSTRAINT telegram_pusher_state_single_row CHECK (id = 1)
);
INSERT INTO public.telegram_pusher_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.telegram_pusher_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "telegram_pusher_state_service_all" ON public.telegram_pusher_state;
CREATE POLICY "telegram_pusher_state_service_all" ON public.telegram_pusher_state FOR ALL USING (auth.role() = 'service_role');
