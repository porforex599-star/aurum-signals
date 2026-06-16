// =====================================================================
// AURUM AI — Edge Function: news-article-generator
//
// Project: aurum-customers (etwlurpjrqlvrxgsbhkd)
// Phase B.5 (2026-06-16)
//
// Turns each bare daily_news headline into a full, click-to-read Thai analysis
// for XAUUSD (gold) traders, plus a hero image. Runs every 5 min via pg_cron
// (job: article_generator_cron) over any row where article IS NULL.
//
// Per row:
//   1. Claude Sonnet 4.5 writes a structured JSON article (background / impact /
//      watch_points / image_keywords) — Thai, analytical, no trading-desk jargon.
//   2. A banned-vocab scan rejects the draft if forbidden terms slipped through
//      (mirrors scripts/check-banned-vocab.sh) — the row stays NULL, retried next tick.
//   3. Image: keep the Finnhub image_url if the row already has one; otherwise
//      query Unsplash with image_keywords and store the first landscape result
//      + photographer credit. No Unsplash key / no result → image_url stays null
//      (the /room frontend falls back to a category icon).
//   4. UPDATE daily_news SET article, image_url, image_credit, article_generated_at.
//
// Designed to fail soft: a single row's Claude/Unsplash error is logged and
// skipped (article stays NULL → retried next tick), never crashing the run.
// Three consecutive whole-run failures ping the existing Telegram bot, state in
// public.article_generator_state.
//
// Auth: verify_jwt = false (matches every sibling fn; cron passes service-role
// bearer, body is idempotent).
//
// Secrets:
//   - ANTHROPIC_API_KEY           (existing — Claude Sonnet writer)
//   - UNSPLASH_ACCESS_KEY         (Por · unsplash.com/oauth/applications; optional)
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
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const UNSPLASH_ACCESS_KEY = Deno.env.get("UNSPLASH_ACCESS_KEY") ?? "";
const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const TELEGRAM_CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID") || Deno.env.get("STAFF_APPROVAL_CHAT_ID") || "";

const ANTHROPIC_MODEL = "claude-sonnet-4-5-20250929";
const UNSPLASH_URL = "https://api.unsplash.com/search/photos";
// How many pending rows to process per tick. Keeps a 5-min cron's cost/latency
// bounded even after a backlog (e.g. a burst of fetcher inserts).
const BATCH_LIMIT = 5;

type Impact = "high" | "medium" | "low";

interface NewsRow {
  id: string;
  source: string;
  category: string;
  title: string;
  impact: Impact;
  expected_value: string | null;
  previous_value: string | null;
  image_url: string | null;
}

interface Article {
  background: string;
  impact: string;
  watch_points: string[];
  image_keywords: string;
}

// ---------------------------------------------------------------------
// Banned-vocab guard — mirror of scripts/check-banned-vocab.sh, applied to the
// generated Thai article before it can be saved. A draft that trips this is
// dropped (row stays NULL) and retried on the next tick.
// ---------------------------------------------------------------------
const BANNED_SUBSTR = /signal|trade|profit|stop loss|take profit|win rate/i;
const BANNED_THAI = /สัญญาณ|เทรด|นักเทรด/;
const BANNED_WORD = /\bBUY\b|\bSELL\b|\bTP\b|\bSL\b|\bROI\b|\bMT5\b|\bentry\b|\bpips\b/;

function hasBannedVocab(text: string): boolean {
  return BANNED_SUBSTR.test(text) || BANNED_THAI.test(text) || BANNED_WORD.test(text);
}

function articleText(a: Article): string {
  return [a.background, a.impact, ...(a.watch_points || [])].join(" \n ");
}

// ---------------------------------------------------------------------
// Claude Sonnet — write the structured Thai article
// ---------------------------------------------------------------------
function buildPrompt(row: NewsRow): string {
  return (
    `You are a financial news analyst writing for Thai XAUUSD (gold) traders.\n\n` +
    `NEWS:\n` +
    `- Thai title: ${row.title}\n` +
    `- Category: ${row.category}\n` +
    `- Impact level: ${row.impact}\n` +
    `- Source: ${row.source}\n` +
    `- Expected value: ${row.expected_value || "N/A"}\n` +
    `- Previous value: ${row.previous_value || "N/A"}\n\n` +
    `Write a structured analysis in Thai. Output ONLY this JSON:\n` +
    `{\n` +
    `  "background": "2-3 sentences in Thai · context · what is this news about",\n` +
    `  "impact": "3-5 sentences in Thai · how this affects gold (XAUUSD) prices · mechanism · magnitude",\n` +
    `  "watch_points": ["short Thai bullet 1", "short Thai bullet 2", "short Thai bullet 3"],\n` +
    `  "image_keywords": "3-5 English search terms for stock photo (e.g. 'central bank monetary policy UK')"\n` +
    `}\n\n` +
    `RULES:\n` +
    `- ภาษาไทยทั้งหมด · เป็นทางการ · เชิงวิเคราะห์\n` +
    `- ห้ามใช้คำเหล่านี้: signal, สัญญาณ, trade, เทรด, BUY, SELL, entry, TP, SL, profit, ROI, trader, อัตราส่วน\n` +
    `- ใช้คำว่า: มุมมอง, แนวโน้ม, โอกาส, ทิศทาง, ผลกระทบ\n` +
    `- ห้ามใช้คำว่า "สัญญาณ" เด็ดขาด — ให้ใช้ "เครื่องบ่งชี้" หรือ "บ่งชี้" แทนทุกครั้ง\n` +
    `- คำต้องห้ามข้างต้นใช้ไม่ได้แม้อยู่ในคำผสมหรือทุก field รวมถึง watch_points\n` +
    `- ห้ามทำนายราคาเฉพาะตัวเลข\n` +
    `- image_keywords เป็นภาษาอังกฤษเสมอ\n` +
    `- Output: pure JSON only · no markdown wrapper · no extra commentary`
  );
}

async function generateArticle(row: NewsRow): Promise<Article | null> {
  if (!ANTHROPIC_API_KEY) {
    console.warn("[article-generator] ANTHROPIC_API_KEY missing — cannot generate");
    return null;
  }
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
        max_tokens: 1024,
        messages: [{ role: "user", content: buildPrompt(row) }],
      }),
    });
    if (!res.ok) {
      console.warn(`[article-generator] Claude ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return null;
    }
    const data = await res.json();
    const text: string = data?.content?.[0]?.text ?? "";
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) {
      console.warn("[article-generator] no JSON in Claude response");
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(m[0]);
    } catch (e) {
      console.warn("[article-generator] JSON parse failed:", String(e));
      return null;
    }
    const p = parsed as Record<string, unknown>;
    const background = typeof p.background === "string" ? p.background.trim() : "";
    const impact = typeof p.impact === "string" ? p.impact.trim() : "";
    const watch_points = Array.isArray(p.watch_points)
      ? p.watch_points.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim())
      : [];
    const image_keywords = typeof p.image_keywords === "string" ? p.image_keywords.trim() : "";
    if (!background || !impact || watch_points.length === 0) {
      console.warn("[article-generator] incomplete article shape — skipping row");
      return null;
    }
    return { background, impact, watch_points, image_keywords };
  } catch (e) {
    console.warn("[article-generator] Claude call failed:", String(e));
    return null;
  }
}

// ---------------------------------------------------------------------
// Unsplash — fetch a hero image for rows without a Finnhub one
// ---------------------------------------------------------------------
async function fetchUnsplashImage(keywords: string): Promise<{ url: string; credit: string } | null> {
  if (!UNSPLASH_ACCESS_KEY) {
    console.warn("[article-generator] UNSPLASH_ACCESS_KEY missing — image stays null");
    return null;
  }
  const query = (keywords || "").trim();
  if (!query) return null;
  try {
    const u = new URL(UNSPLASH_URL);
    u.searchParams.set("query", query);
    u.searchParams.set("per_page", "1");
    u.searchParams.set("orientation", "landscape");
    u.searchParams.set("content_filter", "high");
    const res = await fetch(u.toString(), {
      headers: { Authorization: `Client-ID ${UNSPLASH_ACCESS_KEY}` },
    });
    if (!res.ok) {
      console.warn(`[article-generator] Unsplash ${res.status}: ${(await res.text()).slice(0, 160)}`);
      return null;
    }
    const data = await res.json();
    const first = data?.results?.[0];
    const url = first?.urls?.regular;
    if (!url || typeof url !== "string") return null;
    const name = first?.user?.name || "Unsplash";
    return { url, credit: `Photo by ${name} on Unsplash` };
  } catch (e) {
    console.warn("[article-generator] Unsplash fetch failed:", String(e));
    return null;
  }
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
    console.warn("[article-generator] Telegram alert failed:", String(e));
  }
}

async function recordSuccess(sb: SupabaseClient): Promise<void> {
  await sb.from("article_generator_state").upsert(
    { id: 1, consecutive_failures: 0, last_run_at: new Date().toISOString(), last_error: null },
    { onConflict: "id" },
  );
}

async function recordFailure(sb: SupabaseClient, err: string): Promise<void> {
  let next = 1;
  try {
    const { data } = await sb.from("article_generator_state").select("consecutive_failures").eq("id", 1).maybeSingle();
    next = ((data?.consecutive_failures as number) || 0) + 1;
  } catch (_) { /* default to 1 */ }
  await sb.from("article_generator_state").upsert(
    { id: 1, consecutive_failures: next, last_run_at: new Date().toISOString(), last_error: err.slice(0, 500) },
    { onConflict: "id" },
  );
  if (next >= 3) {
    await sendTelegram(`AURUM news-article-generator failed ${next}x in a row\n${err.slice(0, 300)}`);
  }
}

// ---------------------------------------------------------------------
// Main run
// ---------------------------------------------------------------------
async function runGenerate(sb: SupabaseClient) {
  // 1. Pending rows: article IS NULL, newest first.
  const { data: rows, error } = await sb
    .from("daily_news")
    .select("id, source, category, title, impact, expected_value, previous_value, image_url")
    .is("article", null)
    .order("published_at", { ascending: false })
    .limit(BATCH_LIMIT);
  if (error) throw new Error(`select_failed: ${error.message}`);

  const pending = (rows || []) as NewsRow[];
  let generated = 0, withImage = 0, skipped = 0, bannedRejected = 0;

  for (const row of pending) {
    // 2a. Claude article. Skip the row on any failure → retried next tick.
    const article = await generateArticle(row);
    if (!article) { skipped++; continue; }

    // 2b. Banned-vocab guard before anything is written.
    if (hasBannedVocab(articleText(article))) {
      console.warn(`[article-generator] banned vocab in draft for ${row.id} — skipping`);
      bannedRejected++;
      skipped++;
      continue;
    }

    // 2c. Image: keep an existing Finnhub URL, else try Unsplash (soft-fail null).
    let image_url = row.image_url || null;
    let image_credit: string | null = null;
    if (!image_url) {
      const img = await fetchUnsplashImage(article.image_keywords);
      if (img) { image_url = img.url; image_credit = img.credit; }
    }
    if (image_url) withImage++;

    // 2d. Persist.
    const { error: upErr } = await sb
      .from("daily_news")
      .update({
        article,
        image_url,
        image_credit,
        article_generated_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    if (upErr) {
      console.warn(`[article-generator] update failed for ${row.id}: ${upErr.message}`);
      skipped++;
      continue;
    }
    generated++;
  }

  return {
    pending: pending.length,
    generated,
    with_image: withImage,
    skipped,
    banned_rejected: bannedRejected,
    claude_enabled: !!ANTHROPIC_API_KEY,
    unsplash_enabled: !!UNSPLASH_ACCESS_KEY,
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
    const result = await runGenerate(sb);
    // A run that processed pending rows but generated nothing (e.g. Claude down)
    // counts as a failure for the 3-strikes alert; an empty queue is success.
    if (result.pending > 0 && result.generated === 0) {
      await recordFailure(sb, `0/${result.pending} generated (claude=${result.claude_enabled})`).catch(() => {});
    } else {
      await recordSuccess(sb);
    }
    console.log("[article-generator] ok", JSON.stringify(result));
    return json({ ok: true, ...result });
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e);
    console.error("[article-generator] run failed:", msg);
    await recordFailure(sb, msg).catch(() => {});
    // Soft-fail: 200 so pg_cron doesn't retry-storm; state table tracks health.
    return json({ ok: false, error: msg }, 200);
  }
});
