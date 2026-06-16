// =====================================================================
// AURUM AI — Edge Function: scheduled-analyzer
//
// Project: aurum-customers (etwlurpjrqlvrxgsbhkd)
// Phase B.4 (2026-06-16) · Phase B.4.2 webhook path (2026-06-16)
//
// Posts a structured Thai XAUUSD market briefing into analysis_posts three
// times a day (morning / afternoon / evening, Asia/Bangkok). Two invocation
// shapes feed the same Claude briefing path:
//   - cron:    three pg_cron jobs POST {"slot":"morning|afternoon|evening"}.
//   - webhook: a Pine V.2 time-triggered TradingView alert POSTs
//              {"type":"briefing_webhook","slot":...,"chart_image_url":...}.
//              The webhook carries the AURUM-indicator chart screenshot
//              (EMA / 3s markers / S-D zones), stored in chart_image_url so
//              /room renders it inline — the proper chart Phase B.4.1's
//              TradingView iframe could not show. (Phase B.4.2.)
// A manual invoke can pass either body, or omit it to derive the slot from the
// current Bangkok hour. The idempotency guard means whichever path fires first
// for a given slot/day wins and the other is skipped — no double-post.
//
// Per run:
//   1. Resolve the slot (body.slot → else current Bangkok hour bucket).
//   2. Idempotency: skip if an ai_scheduled row for this slot already exists
//      today (Asia/Bangkok date) — so a double cron / manual re-invoke never
//      double-posts.
//   3. Gather context: Pine-webhook analysis_posts from the last 24h + today's
//      high/medium-impact daily_news headlines.
//   4. Claude Sonnet 4.5 writes the briefing as JSON (overview / direction /
//      watch_factors / summary + an internal bias enum).
//   5. Banned-vocab guard (mirrors scripts/check-banned-vocab.sh) — a draft
//      that trips it is dropped and retried on the next cron tick. The first
//      offending term is surfaced in the error / state table for diagnosis.
//   6. INSERT into analysis_posts: source='ai_scheduled', schedule_slot=<slot>,
//      symbol='XAUUSD', timeframe='briefing'. The briefing prose lands in
//      `note` (analysis_posts has no title/body columns); the NOT-NULL chart
//      columns (bias / key_level / risk_level / confidence) are filled with
//      briefing-appropriate values.
//
// Designed to fail soft: any Claude/parse/banned error logs and skips (no row
// written) → retried next tick. Three consecutive whole-run failures ping the
// admin Telegram bot, state in public.scheduled_analyzer_state.
//
// Auth: verify_jwt = false (matches every sibling fn; cron passes service-role
// bearer, body is idempotent).
//
// Secrets:
//   - ANTHROPIC_API_KEY           (existing — Claude Sonnet writer)
//   - SUPABASE_URL                (auto-injected)
//   - SUPABASE_SERVICE_ROLE_KEY   (auto-injected)
//   - TELEGRAM_BOT_TOKEN          (existing — failure alerts)
//   - TELEGRAM_CHAT_ID            (existing — admin failure alerts; STAFF_APPROVAL_CHAT_ID fallback)
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
const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const TELEGRAM_CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID") || Deno.env.get("STAFF_APPROVAL_CHAT_ID") || "";

const ANTHROPIC_MODEL = "claude-sonnet-4-5-20250929";
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000; // Asia/Bangkok is fixed UTC+7 (no DST).

type Slot = "morning" | "afternoon" | "evening";
const SLOT_THAI: Record<Slot, string> = { morning: "เช้า", afternoon: "บ่าย", evening: "ค่ำ" };

interface PinePost {
  symbol: string;
  timeframe: string;
  bias: string;
  note: string | null;
  confidence: number | null;
  created_at: string;
}

interface NewsItem {
  title: string;
  category: string;
  impact: string;
}

interface Briefing {
  title: string;
  overview: string;
  direction: string;
  watch_factors: string[];
  summary: string;
  bias: "bullish" | "bearish";
}

// ---------------------------------------------------------------------
// Banned-vocab guard — identical to scripts/check-banned-vocab.sh and the
// news-article-generator, applied to the generated Thai briefing before it can
// be saved. A draft that trips this is dropped (no row) and retried next tick.
// (Note: 'อัตราส่วน' is an APPROVED term per the repo guard, so it is not
// banned here even though the Phase B.4 brief listed it — the runtime guard
// mirrors the canonical repo check to avoid false rejections.)
// ---------------------------------------------------------------------
const BANNED_SUBSTR = /signal|trade|profit|stop loss|take profit|win rate/i;
const BANNED_THAI = /สัญญาณ|เทรด|นักเทรด/;
const BANNED_WORD = /\bBUY\b|\bSELL\b|\bTP\b|\bSL\b|\bROI\b|\bMT5\b|\bentry\b|\bpips\b/;

// Returns the first banned term found (for observability), or null if clean.
function findBannedVocab(text: string): string | null {
  const m = text.match(BANNED_SUBSTR) || text.match(BANNED_THAI) || text.match(BANNED_WORD);
  return m ? m[0] : null;
}

function briefingText(b: Briefing): string {
  return [b.title, b.overview, b.direction, ...(b.watch_factors || []), b.summary].join(" \n ");
}

// ---------------------------------------------------------------------
// Time helpers — Asia/Bangkok (UTC+7) slot + "today" boundary in UTC.
// ---------------------------------------------------------------------
function currentSlot(now: Date): Slot {
  const bkk = new Date(now.getTime() + BANGKOK_OFFSET_MS);
  const h = bkk.getUTCHours();
  // Buckets centred on the 09:00 / 14:00 / 20:00 posting times.
  if (h < 12) return "morning";
  if (h < 18) return "afternoon";
  return "evening";
}

// ISO timestamp for 00:00 Asia/Bangkok of `now`'s Bangkok date, expressed in UTC.
function bangkokDayStartUtcIso(now: Date): string {
  const bkk = new Date(now.getTime() + BANGKOK_OFFSET_MS);
  const startBkkMs = Date.UTC(bkk.getUTCFullYear(), bkk.getUTCMonth(), bkk.getUTCDate(), 0, 0, 0);
  return new Date(startBkkMs - BANGKOK_OFFSET_MS).toISOString();
}

// ---------------------------------------------------------------------
// Claude Sonnet — write the structured Thai briefing
// ---------------------------------------------------------------------
function buildPrompt(slot: Slot, news: NewsItem[], pine: PinePost[]): string {
  const newsList = news.length
    ? news.map((n) => `- [${n.impact}] (${n.category}) ${n.title}`).join("\n")
    : "- (ไม่มีข่าว high/medium impact ที่บันทึกไว้สำหรับวันนี้)";
  const pineSummary = pine.length
    ? pine
        .map(
          (p) =>
            `- ${p.symbol} ${p.timeframe} · มุมมอง${p.bias === "bearish" ? "ขาลง" : "ขาขึ้น"}` +
            (p.confidence != null ? ` · ความเชื่อมั่น ${p.confidence}%` : "") +
            (p.note ? ` · ${String(p.note).slice(0, 160)}` : ""),
        )
        .join("\n")
    : "- (ไม่มีบทวิเคราะห์ Pine V.2 ใน 24 ชม.ล่าสุด)";

  return (
    `You are AURUM's senior gold market analyst writing for Thai XAUUSD traders.\n\n` +
    `CURRENT TIME: ช่วง${SLOT_THAI[slot]} (${slot})\n\n` +
    `TODAY'S HIGH/MEDIUM-IMPACT NEWS:\n${newsList}\n\n` +
    `RECENT PINE V.2 POSTS (last 24h):\n${pineSummary}\n\n` +
    `Write a structured market briefing in Thai. Output ONLY this JSON:\n` +
    `{\n` +
    `  "title": "บทวิเคราะห์ XAUUSD ช่วง${SLOT_THAI[slot]}",\n` +
    `  "overview": "2-3 ประโยค · ภาพรวมตลาดล่าสุด · การเคลื่อนไหวของราคาทอง",\n` +
    `  "direction": "3-4 ประโยค · มุมมองทิศทาง · ขาขึ้น/ขาลง/sideways · เหตุผลประกอบ",\n` +
    `  "watch_factors": ["3 ข้อ · ปัจจัยสำคัญที่ต้องจับตา"],\n` +
    `  "summary": "1-2 ประโยค · สรุปสำหรับช่วงเวลานี้",\n` +
    `  "bias": "bullish หรือ bearish (เลือกฝั่งที่น้ำหนักมากกว่าแม้ภาพรวมจะ sideways)"\n` +
    `}\n\n` +
    `RULES:\n` +
    `- ภาษาไทยทั้งหมด · เป็นทางการ · เชิงวิเคราะห์\n` +
    `- ห้ามใช้คำไทยเหล่านี้เด็ดขาด: สัญญาณ (ให้ใช้ "เครื่องบ่งชี้" หรือ "สัญลักษณ์" แทน), เทรด, นักเทรด\n` +
    `- ห้ามใช้คำภาษาอังกฤษเหล่านี้ในเนื้อหาไทยเด็ดขาด (รวมถึงในคำผสม): signal, trade, trader, profit, entry, BUY, SELL, TP, SL, ROI — ให้ใช้คำไทยแทนเสมอ เช่น การค้า (ห้ามเขียนคำว่า trade แม้ในวลี trade war)\n` +
    `- ใช้คำว่า: มุมมอง, แนวโน้ม, โอกาส, ทิศทาง, ผลกระทบ\n` +
    `- ห้ามทำนายราคาเฉพาะเจาะจงเป็นตัวเลข\n` +
    `- ทุก field รวมถึง watch_factors ต้องไม่มีคำต้องห้ามแม้อยู่ในคำผสม\n` +
    `- "bias" เป็นภาษาอังกฤษ bullish หรือ bearish เท่านั้น (ใช้ภายในระบบ)\n` +
    `- Output: pure JSON only · no markdown wrapper · no extra commentary`
  );
}

async function generateBriefing(slot: Slot, news: NewsItem[], pine: PinePost[]): Promise<Briefing | null> {
  if (!ANTHROPIC_API_KEY) {
    console.warn("[scheduled-analyzer] ANTHROPIC_API_KEY missing — cannot generate");
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
        max_tokens: 1200,
        messages: [{ role: "user", content: buildPrompt(slot, news, pine) }],
      }),
    });
    if (!res.ok) {
      console.warn(`[scheduled-analyzer] Claude ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return null;
    }
    const data = await res.json();
    const text: string = data?.content?.[0]?.text ?? "";
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) {
      console.warn("[scheduled-analyzer] no JSON in Claude response");
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(m[0]);
    } catch (e) {
      console.warn("[scheduled-analyzer] JSON parse failed:", String(e));
      return null;
    }
    const p = parsed as Record<string, unknown>;
    const title = typeof p.title === "string" ? p.title.trim() : "";
    const overview = typeof p.overview === "string" ? p.overview.trim() : "";
    const direction = typeof p.direction === "string" ? p.direction.trim() : "";
    const summary = typeof p.summary === "string" ? p.summary.trim() : "";
    const watch_factors = Array.isArray(p.watch_factors)
      ? p.watch_factors.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim())
      : [];
    const bias: "bullish" | "bearish" = p.bias === "bearish" ? "bearish" : "bullish";
    if (!overview || !direction || !summary || watch_factors.length === 0) {
      console.warn("[scheduled-analyzer] incomplete briefing shape — skipping");
      return null;
    }
    return {
      title: title || `บทวิเคราะห์ XAUUSD ช่วง${SLOT_THAI[slot]}`,
      overview,
      direction,
      watch_factors,
      summary,
      bias,
    };
  } catch (e) {
    console.warn("[scheduled-analyzer] Claude call failed:", String(e));
    return null;
  }
}

// Compose the human-readable Thai briefing stored in analysis_posts.note.
function composeNote(b: Briefing): string {
  const bullets = b.watch_factors.map((f) => `• ${f}`).join("\n");
  return (
    `${b.title}\n\n` +
    `📊 ภาพรวมตลาด\n${b.overview}\n\n` +
    `🧭 มุมมองทิศทาง\n${b.direction}\n\n` +
    `👁️ ปัจจัยที่ต้องจับตา\n${bullets}\n\n` +
    `📝 สรุป\n${b.summary}`
  );
}

// ---------------------------------------------------------------------
// Failure-state bookkeeping (admin Telegram alert after 3 consecutive fails)
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
    console.warn("[scheduled-analyzer] Telegram alert failed:", String(e));
  }
}

async function recordSuccess(sb: SupabaseClient): Promise<void> {
  await sb.from("scheduled_analyzer_state").upsert(
    { id: 1, consecutive_failures: 0, last_run_at: new Date().toISOString(), last_error: null },
    { onConflict: "id" },
  );
}

async function recordFailure(sb: SupabaseClient, err: string): Promise<void> {
  let next = 1;
  try {
    const { data } = await sb.from("scheduled_analyzer_state").select("consecutive_failures").eq("id", 1).maybeSingle();
    next = ((data?.consecutive_failures as number) || 0) + 1;
  } catch (_) { /* default to 1 */ }
  await sb.from("scheduled_analyzer_state").upsert(
    { id: 1, consecutive_failures: next, last_run_at: new Date().toISOString(), last_error: err.slice(0, 500) },
    { onConflict: "id" },
  );
  if (next >= 3) {
    await sendTelegram(`AURUM scheduled-analyzer failed ${next}x in a row\n${err.slice(0, 300)}`);
  }
}

// ---------------------------------------------------------------------
// Main run
// ---------------------------------------------------------------------
async function runAnalyze(sb: SupabaseClient, slot: Slot, now: Date, chartImageUrl: string | null = null) {
  const dayStart = bangkokDayStartUtcIso(now);

  // 1. Idempotency — has this slot already posted today (Bangkok)?
  const { count, error: cErr } = await sb
    .from("analysis_posts")
    .select("id", { count: "exact", head: true })
    .eq("source", "ai_scheduled")
    .eq("schedule_slot", slot)
    .gte("created_at", dayStart);
  if (cErr) throw new Error(`dup_check_failed: ${cErr.message}`);
  if ((count || 0) > 0) {
    return { slot, skipped: "already_posted_today", count };
  }

  // 2. Context — recent Pine posts (24h) + today's high/medium news.
  const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const [{ data: pineRows }, { data: newsRows }] = await Promise.all([
    sb
      .from("analysis_posts")
      .select("symbol, timeframe, bias, note, confidence, created_at")
      .eq("source", "pine_webhook")
      .gte("created_at", since24h)
      .order("created_at", { ascending: false })
      .limit(10),
    sb
      .from("daily_news")
      .select("title, category, impact, published_at")
      .in("impact", ["high", "medium"])
      .gte("published_at", dayStart)
      .order("published_at", { ascending: false })
      .limit(12),
  ]);
  const pine = (pineRows || []) as PinePost[];
  const news = (newsRows || []) as NewsItem[];

  // 3. Claude briefing.
  const briefing = await generateBriefing(slot, news, pine);
  if (!briefing) throw new Error("briefing_generation_failed");

  // 4. Banned-vocab guard. The offending term is surfaced in the error (and
  //    thus the state table) so a persistently-tripping phrasing is diagnosable.
  const banned = findBannedVocab(briefingText(briefing));
  if (banned) {
    throw new Error(`briefing_banned_vocab: ${banned}`);
  }

  // 5. Insert. NOT-NULL chart columns get briefing-appropriate fills:
  //    key_level=0 (no price level for a briefing), confidence=70,
  //    risk_level derived from whether high-impact news is on the docket.
  //    chart_image_url is populated only on the Pine V.2 webhook path (it
  //    carries the AURUM-indicator screenshot); the cron path leaves it NULL,
  //    and /room shows the "รอข้อมูลแท่งเทียน" placeholder for that case.
  const riskLevel = news.some((n) => n.impact === "high") ? "high" : "medium";
  const note = composeNote(briefing);
  const { data: inserted, error: insErr } = await sb
    .from("analysis_posts")
    .insert({
      symbol: "XAUUSD",
      timeframe: "briefing",
      bias: briefing.bias,
      key_level: 0,
      target_zones: [],
      risk_level: riskLevel,
      confidence: 70,
      note,
      source: "ai_scheduled",
      schedule_slot: slot,
      chart_image_url: chartImageUrl,
      chart_image_generated_at: chartImageUrl ? new Date().toISOString() : null,
    })
    .select("id, created_at")
    .single();
  if (insErr) throw new Error(`insert_failed: ${insErr.message}`);

  return {
    slot,
    inserted_id: inserted?.id,
    created_at: inserted?.created_at,
    title: briefing.title,
    bias: briefing.bias,
    risk_level: riskLevel,
    chart_image_url: chartImageUrl,
    context: { pine_posts: pine.length, news_items: news.length },
  };
}

serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  if (!SERVICE_ROLE_KEY) {
    return json({ ok: false, error: "missing_service_role_key" }, 500);
  }
  const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  // Resolve invocation. Two POST shapes, one Claude path:
  //   - cron:    {"slot":"morning|afternoon|evening"}  → no chart screenshot.
  //   - webhook: {"type":"briefing_webhook","slot":...,"chart_image_url":...}
  //              fired by a Pine V.2 time-triggered TradingView alert, carrying
  //              the AURUM-indicator chart screenshot.
  // Either way the slot resolves the same (explicit body.slot wins, else the
  // current Bangkok hour bucket) and the same idempotency guard prevents a
  // cron+webhook double-post for one slot/day.
  const now = new Date();
  let slot: Slot = currentSlot(now);
  let chartImageUrl: string | null = null;
  let isWebhook = false;
  try {
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const s = body?.slot;
      if (s === "morning" || s === "afternoon" || s === "evening") slot = s;
      if (body?.type === "briefing_webhook") {
        isWebhook = true;
        const url = typeof body?.chart_image_url === "string" ? body.chart_image_url.trim() : "";
        // Only accept an http(s) URL; ignore unsubstituted {{chart}} placeholders.
        if (/^https?:\/\//i.test(url)) chartImageUrl = url;
      }
    }
  } catch (_) { /* keep derived slot */ }

  try {
    const result = await runAnalyze(sb, slot, now, chartImageUrl);
    await recordSuccess(sb);
    console.log("[scheduled-analyzer] ok", JSON.stringify({ via: isWebhook ? "webhook" : "cron", ...result }));
    return json({ ok: true, via: isWebhook ? "webhook" : "cron", ...result });
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e);
    console.error("[scheduled-analyzer] run failed:", msg);
    await recordFailure(sb, msg).catch(() => {});
    // Soft-fail: 200 so pg_cron doesn't retry-storm; state table tracks health.
    return json({ ok: false, slot, error: msg }, 200);
  }
});
