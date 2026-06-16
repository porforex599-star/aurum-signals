-- =====================================================================
-- AURUM AI — Phase B.5: News Article Generator + Click-to-Read
-- Project: aurum-customers (etwlurpjrqlvrxgsbhkd)
-- Applied 2026-06-16 via Supabase MCP (migration: phase_b5_news_article_generator).
--
-- Extends daily_news so each headline can carry a full AI-written Thai
-- analysis (article JSONB) and a hero image (image_url + credit). The
-- news-article-generator edge function fills these in on a 5-min cron for any
-- row where article IS NULL; the /room card becomes click-to-read.
--
-- article JSONB shape:
--   {
--     "background":     "2-3 sentences Thai · context",
--     "impact":         "3-5 sentences Thai · effect on XAUUSD",
--     "watch_points":   ["Thai bullet", "Thai bullet", "Thai bullet"],
--     "image_keywords": "english search terms for Unsplash"
--   }
-- =====================================================================

ALTER TABLE public.daily_news
  ADD COLUMN IF NOT EXISTS article JSONB,
  ADD COLUMN IF NOT EXISTS image_url TEXT,
  ADD COLUMN IF NOT EXISTS image_credit TEXT,
  ADD COLUMN IF NOT EXISTS article_generated_at TIMESTAMPTZ;

-- Partial index — the generator polls "rows still missing an article", newest
-- first. Kept tiny (only pending rows) so the 5-min cron lookup stays cheap.
CREATE INDEX IF NOT EXISTS idx_daily_news_pending_article
  ON public.daily_news(published_at DESC)
  WHERE article IS NULL;

-- ---- article_generator_state (cron health, 3-strikes Telegram alert) -------
-- Mirrors news_fetcher_state; kept separate so a generator outage doesn't mask
-- fetcher health (and vice-versa).
CREATE TABLE IF NOT EXISTS public.article_generator_state (
  id INT PRIMARY KEY DEFAULT 1,
  consecutive_failures INT NOT NULL DEFAULT 0,
  last_run_at TIMESTAMPTZ,
  last_error TEXT,
  CONSTRAINT article_generator_state_single_row CHECK (id = 1)
);
INSERT INTO public.article_generator_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.article_generator_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "article_generator_state_service_all" ON public.article_generator_state;
CREATE POLICY "article_generator_state_service_all" ON public.article_generator_state FOR ALL USING (auth.role() = 'service_role');
