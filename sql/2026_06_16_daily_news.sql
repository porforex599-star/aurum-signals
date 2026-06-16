-- =====================================================================
-- AURUM AI — Phase B: News Pipeline
-- Project: aurum-customers (etwlurpjrqlvrxgsbhkd)
-- Applied 2026-06-16 via Supabase MCP (migration: phase_b_daily_news).
--
-- Adds the daily_news table (fed by the news-fetcher edge function), a small
-- health-state table for the cron, and the analysis_posts columns Phase B.4
-- will use (source / schedule_slot).
-- =====================================================================

-- ---- daily_news --------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.daily_news (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  external_id TEXT UNIQUE,
  source TEXT NOT NULL CHECK (source IN ('forexfactory','finnhub')),
  category TEXT NOT NULL CHECK (category IN ('เศรษฐกิจ','นโยบายเงิน','สินค้าโภคภัณฑ์','ภูมิรัฐศาสตร์')),
  title TEXT NOT NULL,
  impact TEXT NOT NULL CHECK (impact IN ('high','medium','low')),
  importance_score INT CHECK (importance_score BETWEEN 1 AND 5),
  expected_value TEXT,
  previous_value TEXT,
  published_at TIMESTAMPTZ NOT NULL,
  fetched_at TIMESTAMPTZ DEFAULT NOW(),
  pushed_to_line BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_daily_news_published ON public.daily_news(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_daily_news_impact ON public.daily_news(impact, published_at DESC);

ALTER TABLE public.daily_news ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "daily_news_read_all" ON public.daily_news;
CREATE POLICY "daily_news_read_all" ON public.daily_news FOR SELECT USING (true);

DROP POLICY IF EXISTS "daily_news_service_write" ON public.daily_news;
CREATE POLICY "daily_news_service_write" ON public.daily_news FOR ALL USING (auth.role() = 'service_role');

-- ---- news_fetcher_state (cron health, for the 3-strikes Telegram alert) --
CREATE TABLE IF NOT EXISTS public.news_fetcher_state (
  id INT PRIMARY KEY DEFAULT 1,
  consecutive_failures INT NOT NULL DEFAULT 0,
  last_run_at TIMESTAMPTZ,
  last_error TEXT,
  CONSTRAINT news_fetcher_state_single_row CHECK (id = 1)
);
INSERT INTO public.news_fetcher_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.news_fetcher_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "news_fetcher_state_service_all" ON public.news_fetcher_state;
CREATE POLICY "news_fetcher_state_service_all" ON public.news_fetcher_state FOR ALL USING (auth.role() = 'service_role');

-- ---- analysis_posts: Phase B.4 columns ---------------------------------
-- NOTE: analysis_posts.source already exists in production with values
-- 'admin_manual' (11 rows) and NULL (13 rows). The Phase B spec's strict
-- CHECK (source IN ('pine_webhook','ai_scheduled')) would reject those and
-- break the existing admin flow, so the constraint is widened to include the
-- live values. Default is set for new Pine-webhook rows. schedule_slot is new.
ALTER TABLE public.analysis_posts ALTER COLUMN source SET DEFAULT 'pine_webhook';

ALTER TABLE public.analysis_posts DROP CONSTRAINT IF EXISTS analysis_posts_source_check;
ALTER TABLE public.analysis_posts
  ADD CONSTRAINT analysis_posts_source_check
  CHECK (source IS NULL OR source IN ('pine_webhook','ai_scheduled','admin_manual'));

ALTER TABLE public.analysis_posts ADD COLUMN IF NOT EXISTS schedule_slot TEXT
  CHECK (schedule_slot IS NULL OR schedule_slot IN ('morning','afternoon','evening'));
