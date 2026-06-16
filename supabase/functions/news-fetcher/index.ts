// =====================================================================
// AURUM AI — Edge Function: news-fetcher
//
// Project: aurum-customers (etwlurpjrqlvrxgsbhkd)
// Phase B (2026-06-16)
//
// Pulls macro / forex headlines from two free sources, scores each one with
// Claude Haiku for XAUUSD (gold) relevance, keeps only the strongest, and
// writes them into public.daily_news for the /room "ข่าวสำคัญวันนี้" panel.
//
//   1. ForexFactory weekly calendar  → https://nfs.faireconomy.media/ff_calendar_thisweek.xml
//      (free, no auth — scheduled economic events with High/Medium/Low impact)
//   2. Finnhub forex news            → https://finnhub.io/api/v1/news?category=forex
//      (free tier, 60 req/min — needs FINNHUB_API_KEY)
//
// Pipeline: fetch → dedup vs DB (by external_id) → Claude Haiku scorer
// (score 1-5 + Thai title + category) → keep score>=4 OR impact=high →
// cap at 4 inserts/day (newest first) → upsert ON CONFLICT external_id DO NOTHING.
//
// Invoked every 30 min by pg_cron (job: news_fetcher_cron). Designed to fail
// soft: a missing secret or a single source/scorer error is logged and skipped,
// never crashing the run. Three consecutive whole-run failures ping the existing
// Telegram bot (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID), state in
// public.news_fetcher_state.
//
// Auth: verify_jwt = false (matches every sibling fn in this project; the cron
// passes the service-role bearer but the body is read-only and idempotent).
//
// Secrets:
//   - FINNHUB_API_KEY              (Por · finnhub.io free tier)
//   - ANTHROPIC_API_KEY           (Claude Haiku scorer)
//   - SUPABASE_URL                (auto-injected)
//   - SUPABASE_SERVICE_ROLE_KEY   (auto-injected)
//   - TELEGRAM_BOT_TOKEN          (existing — failure alerts)
//   - TELEGRAM_CHAT_ID            (existing — failure alerts; STAFF_APPROVAL_CHAT_ID fallback)
// =====================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function preflight(req: Request): Response | null {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  return null;
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "https://etwlurpjrqlvrxgsbhkd.supabase.co";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const FINNHUB_API_KEY = Deno.env.get("FINNHUB_API_KEY") ?? "";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const TELEGRAM_CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID") || Deno.env.get("STAFF_APPROVAL_CHAT_ID") || "";

const FF_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.xml";
const FINNHUB_URL = "https://finnhub.io/api/v1/news?category=forex";
const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";

// daily_news constrained vocab — the AI is told to use exactly these.
const VALID_CATEGORIES = ["เศรษฐกิจ", "นโยบายเงิน", "สินค้าโภคภัณฑ์", "ภูมิรัฐศาสตร์"];
const MAX_INSERTS_PER_DAY = 4;
// Cap how many candidates we send to Claude per run, to keep cost trivial.
const MAX_SCORE_CANDIDATES = 25;

type Source = "forexfactory" | "finnhub";
type Impact = "high" | "medium" | "low";

interface Candidate {
  external_id: string;
  source: Source;
  title: string;
  impact: Impact;            // source-provided (FF) or provisional (Finnhub)
  expected_value: string | null;
  previous_value: string | null;
  published_at: string;      // ISO
}

interface ScoredRow extends Candidate {
  category: string;
  importance_score: number;
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

function tag(block: string, name: string): string {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "i").exec(block);
  return m ? decodeEntities(m[1]) : "";
}

// Stable-ish id from a string (FNV-1a) so the same headline maps to one row.
function hashId(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function ffImpact(label: string): Impact {
  const l = label.toLowerCase();
  if (l.includes("high")) return "high";
  if (l.includes("medium")) return "medium";
  return "low";
}

// FF gives date like "06-16-2026" + time like "8:30am" / "All Day" / "Tentative".
function ffPublishedAt(date: string, time: string): string {
  const d = /(\d{2})-(\d{2})-(\d{4})/.exec(date);
  if (!d) return new Date().toISOString();
  const [, mm, dd, yyyy] = d;
  let hours = 0, mins = 0;
  const t = /(\d{1,2}):(\d{2})(am|pm)/i.exec(time || "");
  if (t) {
    hours = parseInt(t[1], 10) % 12;
    if (/pm/i.test(t[3])) hours += 12;
    mins = parseInt(t[2], 10);
  }
  // FF times are US Eastern; approximate to UTC (-4/-5). Use -4 (EDT) as a
  // pragmatic default — exactness is not critical for a "today" news pill.
  const dt = new Date(Date.UTC(+yyyy, +mm - 1, +dd, hours + 4, mins, 0));
  return dt.toISOString();
}

// ---------------------------------------------------------------------
// Source 1 — ForexFactory weekly calendar (free XML)
// ---------------------------------------------------------------------
async function fetchForexFactory(): Promise<Candidate[]> {
  try {
    const res = await fetch(FF_URL, { headers: { "User-Agent": "aurum-news-fetcher/1.0" } });
    if (!res.ok) {
      console.warn(`[news-fetcher] ForexFactory ${res.status}`);
      return [];
    }
    const xml = await res.text();
    const events = xml.match(/<event>[\s\S]*?<\/event>/gi) || [];
    const out: Candidate[] = [];
    for (const ev of events) {
      const title = tag(ev, "title");
      if (!title) continue;
      const impact = ffImpact(tag(ev, "impact"));
      // Skip Low / Holiday up front — never gold movers, saves scorer calls.
      if (impact === "low") continue;
      const country = tag(ev, "country");
      const forecast = tag(ev, "forecast");
      const previous = tag(ev, "previous");
      const published_at = ffPublishedAt(tag(ev, "date"), tag(ev, "time"));
      const fullTitle = country ? `${country} ${title}` : title;
      out.push({
        external_id: `ff_${hashId(fullTitle + published_at)}`,
        source: "forexfactory",
        title: fullTitle,
        impact,
        expected_value: forecast || null,
        previous_value: previous || null,
        published_at,
      });
    }
    return out;
  } catch (e) {
    console.warn("[news-fetcher] ForexFactory fetch failed:", String(e));
    return [];
  }
}

// ---------------------------------------------------------------------
// Source 2 — Finnhub forex news (free tier)
// ---------------------------------------------------------------------
async function fetchFinnhub(): Promise<Candidate[]> {
  if (!FINNHUB_API_KEY) {
    console.warn("[news-fetcher] FINNHUB_API_KEY missing — skipping Finnhub");
    return [];
  }
  try {
    const res = await fetch(`${FINNHUB_URL}&token=${FINNHUB_API_KEY}`);
    if (!res.ok) {
      console.warn(`[news-fetcher] Finnhub ${res.status}`);
      return [];
    }
    const arr = await res.json();
    if (!Array.isArray(arr)) return [];
    const out: Candidate[] = [];
    for (const n of arr) {
      const title = (n.headline || "").trim();
      if (!title) continue;
      const published_at = n.datetime
        ? new Date(n.datetime * 1000).toISOString()
        : new Date().toISOString();
      out.push({
        external_id: `fh_${n.id ?? hashId(title)}`,
        source: "finnhub",
        title,
        impact: "medium", // provisional — final impact derived from AI score
        expected_value: null,
        previous_value: null,
        published_at,
      });
    }
    return out;
  } catch (e) {
    console.warn("[news-fetcher] Finnhub fetch failed:", String(e));
    return [];
  }
}

// ---------------------------------------------------------------------
// Claude Haiku scorer — relevance 1-5 + Thai title + category
// ---------------------------------------------------------------------
async function scoreWithClaude(c: Candidate): Promise<{ score: number; category: string; thai_title: string } | null> {
  if (!ANTHROPIC_API_KEY) return null;
  const prompt =
    `You are a financial news importance scorer for XAUUSD (gold) trading.\n` +
    `Title: ${c.title}\n` +
    `Source: ${c.source}\n` +
    `Impact label: ${c.impact}\n\n` +
    `Return ONLY JSON:\n` +
    `{\n` +
    `  "score": 1-5 (5=major mover, 4=significant, 3=notable, 2=minor, 1=ignore),\n` +
    `  "category": one of ${JSON.stringify(VALID_CATEGORIES)},\n` +
    `  "thai_title": "concise Thai translation"\n` +
    `}`;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 256,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) {
      console.warn(`[news-fetcher] Claude ${res.status}: ${(await res.text()).slice(0, 160)}`);
      return null;
    }
    const data = await res.json();
    const text: string = data?.content?.[0]?.text ?? "";
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]);
    const score = Math.max(1, Math.min(5, Math.round(Number(parsed.score) || 0)));
    const category = VALID_CATEGORIES.includes(parsed.category) ? parsed.category : VALID_CATEGORIES[0];
    const thai_title = String(parsed.thai_title || c.title).slice(0, 300);
    return { score, category, thai_title };
  } catch (e) {
    console.warn("[news-fetcher] Claude scoring failed:", String(e));
    return null;
  }
}

function finalImpact(c: Candidate, score: number): Impact {
  // ForexFactory carries a real impact label — trust it. For Finnhub (provisional)
  // derive impact from the AI score so the dot colour reflects relevance.
  if (c.source === "forexfactory") return c.impact;
  if (score >= 4) return "high";
  if (score === 3) return "medium";
  return "low";
}

// ---------------------------------------------------------------------
// Failure-state bookkeeping (Telegram alert after 3 consecutive failures)
// ---------------------------------------------------------------------
async function sendTelegram(text: string): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
    });
  } catch (e) {
    console.warn("[news-fetcher] Telegram alert failed:", String(e));
  }
}

async function recordSuccess(sb: SupabaseClient): Promise<void> {
  await sb.from("news_fetcher_state").upsert(
    { id: 1, consecutive_failures: 0, last_run_at: new Date().toISOString(), last_error: null },
    { onConflict: "id" },
  );
}

async function recordFailure(sb: SupabaseClient, err: string): Promise<void> {
  let next = 1;
  try {
    const { data } = await sb.from("news_fetcher_state").select("consecutive_failures").eq("id", 1).maybeSingle();
    next = ((data?.consecutive_failures as number) || 0) + 1;
  } catch (_) { /* default to 1 */ }
  await sb.from("news_fetcher_state").upsert(
    { id: 1, consecutive_failures: next, last_run_at: new Date().toISOString(), last_error: err.slice(0, 500) },
    { onConflict: "id" },
  );
  if (next >= 3) {
    await sendTelegram(`AURUM news-fetcher failed ${next}x in a row\n${err.slice(0, 300)}`);
  }
}

// ---------------------------------------------------------------------
// Main run
// ---------------------------------------------------------------------
async function runFetch(sb: SupabaseClient) {
  // 1-2. Fetch both sources in parallel.
  const [ff, fh] = await Promise.all([fetchForexFactory(), fetchFinnhub()]);
  let candidates = [...ff, ...fh];

  // 3. Dedup within this run by external_id.
  const seen = new Set<string>();
  candidates = candidates.filter((c) => (seen.has(c.external_id) ? false : (seen.add(c.external_id), true)));

  // Dedup against the DB up front so we never spend a Claude call on a row we
  // already have (UNIQUE on external_id is the final guard either way).
  if (candidates.length) {
    const ids = candidates.map((c) => c.external_id);
    const { data: existing } = await sb.from("daily_news").select("external_id").in("external_id", ids);
    const have = new Set((existing || []).map((r: { external_id: string }) => r.external_id));
    candidates = candidates.filter((c) => !have.has(c.external_id));
  }

  // Newest first, then cap how many we bother scoring.
  candidates.sort((a, b) => (a.published_at < b.published_at ? 1 : -1));
  const toScore = candidates.slice(0, MAX_SCORE_CANDIDATES);

  // 4. Score each with Claude Haiku (sequential to stay polite on rate limits).
  const scored: ScoredRow[] = [];
  for (const c of toScore) {
    const s = await scoreWithClaude(c);
    if (!s) continue;
    // 5. Keep score>=4 OR a source-flagged high-impact event.
    if (s.score >= 4 || c.impact === "high") {
      scored.push({
        ...c,
        impact: finalImpact(c, s.score),
        category: s.category,
        importance_score: s.score,
      });
    }
  }

  // 6. Cap at MAX_INSERTS_PER_DAY across the calendar day (newest first).
  scored.sort((a, b) => (a.published_at < b.published_at ? 1 : -1));
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const { count: todayCount } = await sb
    .from("daily_news")
    .select("id", { count: "exact", head: true })
    .gte("created_at", startOfDay.toISOString());
  const remaining = Math.max(0, MAX_INSERTS_PER_DAY - (todayCount || 0));
  const rows = scored.slice(0, remaining).map((r) => ({
    external_id: r.external_id,
    source: r.source,
    category: r.category,
    title: r.title,
    impact: r.impact,
    importance_score: r.importance_score,
    expected_value: r.expected_value,
    previous_value: r.previous_value,
    published_at: r.published_at,
  }));

  // 7. Insert (ON CONFLICT external_id DO NOTHING).
  let inserted = 0;
  if (rows.length) {
    const { data, error } = await sb
      .from("daily_news")
      .upsert(rows, { onConflict: "external_id", ignoreDuplicates: true })
      .select("id");
    if (error) throw new Error(`insert_failed: ${error.message}`);
    inserted = data?.length ?? 0;
  }

  return {
    fetched: { forexfactory: ff.length, finnhub: fh.length },
    deduped_candidates: candidates.length,
    scored: scored.length,
    today_existing: todayCount || 0,
    remaining_quota: remaining,
    inserted,
    finnhub_enabled: !!FINNHUB_API_KEY,
    scorer_enabled: !!ANTHROPIC_API_KEY,
  };
}

serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  if (!SERVICE_ROLE_KEY) {
    return json({ ok: false, error: "missing_service_role_key" }, 500);
  }
  const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  try {
    const result = await runFetch(sb);
    await recordSuccess(sb);
    console.log("[news-fetcher] ok", JSON.stringify(result));
    return json({ ok: true, ...result });
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e);
    console.error("[news-fetcher] run failed:", msg);
    await recordFailure(sb, msg).catch(() => {});
    // Soft-fail: 200 so pg_cron doesn't retry-storm; state table tracks health.
    return json({ ok: false, error: msg }, 200);
  }
});
