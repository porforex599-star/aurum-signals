-- supabase migration · analysis_posts schema for arrow_alert kind + telemetry
-- Apply to project etwlurpjrqlvrxgsbhkd (aurum-customers)
--
-- NOTE (schema reality check · 2026-06-17):
--   The live analysis_posts table differs from older sql/ snapshots. It has
--   NOT NULL columns with no defaults that the briefing/admin flows fill in
--   but the arrow_alert flow does NOT:
--       bias        text NOT NULL  check in ('bullish','bearish')
--       key_level   double precision NOT NULL
--       risk_level  text NOT NULL  check in ('low','medium','high')
--       confidence  integer NOT NULL  check 0..100
--   An arrow_alert row carries no price-based level/risk/confidence (the whole
--   point is "no price numbers"), so these are relaxed to NULLABLE here.
--   Existing briefing/admin inserts still supply them → no behaviour change.
--   The table also lacks published_at / session_label that the function and the
--   /room card expect, so they are added + backfilled.

-- 1. Relax NOT NULL on price-centric columns so arrow_alert rows can insert
alter table public.analysis_posts alter column bias        drop not null;
alter table public.analysis_posts alter column key_level   drop not null;
alter table public.analysis_posts alter column risk_level  drop not null;
alter table public.analysis_posts alter column confidence  drop not null;

-- 2. Extend analysis_posts (additive · IF NOT EXISTS)
alter table public.analysis_posts
  add column if not exists kind text default 'briefing',
  add column if not exists arrow_level int,
  add column if not exists arrow_direction text check (arrow_direction in ('bull','bear')),
  add column if not exists session_label text,
  add column if not exists published_at timestamptz,
  add column if not exists analysis_json jsonb,
  add column if not exists analysis_status text default 'pending'
    check (analysis_status in ('pending','generating','ready','failed','skipped')),
  add column if not exists pine_payload jsonb,
  add column if not exists generated_at timestamptz,
  add column if not exists fail_reason text;

-- kind: 'briefing' (scheduled-analyzer) | 'arrow_alert' (tv-alert-analyzer) | 'news' (news-article-generator)

-- 3. Backfill existing rows so the /room feed does not regress
update public.analysis_posts set kind = 'briefing' where kind is null;
-- existing rows are already live → mark ready and give them a publish time
update public.analysis_posts
  set published_at = coalesce(published_at, timestamp_utc, created_at)
  where published_at is null;
update public.analysis_posts
  set analysis_status = 'ready'
  where analysis_status is null or analysis_status = 'pending';

create index if not exists idx_analysis_posts_kind_published
  on public.analysis_posts (kind, published_at desc);

create index if not exists idx_analysis_posts_status
  on public.analysis_posts (analysis_status)
  where analysis_status in ('pending','generating','failed');

-- 4. Telemetry table for retry-loop monitoring
create table if not exists public.analysis_telemetry (
  id bigserial primary key,
  post_id uuid references public.analysis_posts(id) on delete cascade,
  symbol text,
  timeframe text,
  arrow_level int,
  status text check (status in ('success','failed')),
  attempts int,
  retry_reasons jsonb,
  fail_reason text,
  created_at timestamptz default now()
);

create index if not exists idx_telemetry_status_created
  on public.analysis_telemetry (status, created_at desc);

create index if not exists idx_telemetry_post
  on public.analysis_telemetry (post_id);

-- 5. RLS · analysis_telemetry is internal only (no customer reads)
alter table public.analysis_telemetry enable row level security;
-- (no policies · only service role can read/write)
