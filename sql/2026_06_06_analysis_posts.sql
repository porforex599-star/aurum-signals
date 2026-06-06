-- ============================================================================
-- Migration: analysis_posts
-- Project:   aurum-customers (Supabase)
-- Date:      2026-06-06
-- Purpose:   Backing store for the Aurum Analysis room feed (Variant C — Pro
--            Dashboard). One row per published บทวิเคราะห์. Realtime-enabled so
--            the room can prepend new rows and flip the "ยืนยันแล้ว" badge live.
--
-- NON-REPAINT CONTRACT (enforced by aurum-ai-engine, not the DB):
--   * INSERT a row with confirmed = false the moment an analysis first appears
--     mid-bar.
--   * UPDATE confirmed = true ONLY after the bar closes on the indicator's
--     timeframe (set confirmed_at at the same time).
--   * NEVER mutate key_level / target_zones / risk_level after confirmation.
-- ============================================================================

create extension if not exists "pgcrypto";

create table if not exists public.analysis_posts (
  id              uuid primary key default gen_random_uuid(),

  symbol          text not null
                    check (symbol in ('XAUUSD', 'EURUSD', 'BTCUSD', 'NAS100', 'SP500')),
  timeframe       text not null
                    check (timeframe in ('M5', 'M15', 'M30', 'H1', 'H4')),
  view_direction  text not null
                    check (view_direction in ('bullish', 'bearish')),

  key_level       numeric not null,
  target_zones    jsonb   not null default '[]'::jsonb,  -- [{ "level": number, "hit": bool }, ...]
  risk_level      numeric not null,
  risk_distance   numeric not null,                      -- abs(key_level - risk_level)
  reward_ratio    numeric not null,                      -- e.g. 1.7 for 1:1.7

  confidence_stars int not null
                    check (confidence_stars between 1 and 5),

  confirmed       boolean not null default false,        -- true only after bar close
  confirmed_at    timestamptz,

  created_at      timestamptz not null default now()
);

comment on table  public.analysis_posts is 'Published Aurum Analysis room posts. Realtime-enabled.';
comment on column public.analysis_posts.target_zones  is 'jsonb array of { level: numeric, hit: boolean }';
comment on column public.analysis_posts.confirmed     is 'Non-repaint guarantee: only true after the bar closes.';
comment on column public.analysis_posts.risk_distance is 'abs(key_level - risk_level), denormalised for the room UI.';

-- ---- indexes ---------------------------------------------------------------
create index if not exists analysis_posts_created_at_idx
  on public.analysis_posts (created_at desc);
create index if not exists analysis_posts_symbol_created_at_idx
  on public.analysis_posts (symbol, created_at desc);

-- ---- row level security ----------------------------------------------------
-- The room reads with the customer's authenticated session. Entitlement
-- (active aurum_analysis subscription) is enforced at the edge-function /
-- gate layer; here we simply require an authenticated user to read.
alter table public.analysis_posts enable row level security;

drop policy if exists "analysis_posts read for authenticated" on public.analysis_posts;
create policy "analysis_posts read for authenticated"
  on public.analysis_posts
  for select
  to authenticated
  using (true);

-- Writes come from the backend (aurum-ai-engine) via the service role, which
-- bypasses RLS. No insert/update policy is granted to anon/authenticated.

-- ---- realtime --------------------------------------------------------------
-- Emit full row payloads on UPDATE so the client can diff confirmed false→true.
alter table public.analysis_posts replica identity full;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'analysis_posts'
  ) then
    execute 'alter publication supabase_realtime add table public.analysis_posts';
  end if;
end
$$;
