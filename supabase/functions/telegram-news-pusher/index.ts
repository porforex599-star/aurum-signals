// =====================================================================
// AURUM AI — Edge Function: telegram-news-pusher
//
// Project: aurum-customers (etwlurpjrqlvrxgsbhkd)
// Phase B.4 (2026-06-16)
//
// Every 5 min (pg_cron job: telegram_pusher_cron) pushes any not-yet-pushed
// impact='high' daily_news row into the customer Telegram channel, so paying
// members get an instant heads-up on market-moving news.
//
// Per run:
//   1. SELECT up to 5 rows WHERE pushed_to_telegram=FALSE AND impact='high',
//      newest first.
//   2. For each: format a Markdown message and POST to the Telegram Bot API —
//      sendPhoto (caption + image) when the row has an image_url, else
//      sendMessage. The CTA links to the full analysis at /room.
//   3. On a successful send: UPDATE pushed_to_telegram=TRUE, telegram_pushed_at.
//      A row whose send fails is left untouched → retried next tick (no dupes,
//      because the flag only flips after Telegram returns ok).
//
// Idempotent: the pushed_to_telegram flag (set only after a confirmed send)
// guarantees a re-invoke never double-pushes. Designed to fail soft: a single
// row's send error is logged and skipped; three consecutive whole-run failures
// ping the ADMIN Telegram chat (TELEGRAM_CHAT_ID — never the customer channel),
// state in public.telegram_pusher_state.
//
// Auth: verify_jwt = false (matches every sibling fn; cron passes service-role
// bearer, body is idempotent).
//
// Secrets:
//   - TELEGRAM_BOT_TOKEN             (existing — the bot that posts)
//   - TELEGRAM_CUSTOMER_CHANNEL_ID   (Por · chat_id of the customer channel)
//   - TELEGRAM_CHAT_ID               (existing — ADMIN failure alerts only; STAFF_APPROVAL_CHAT_ID fallback)
//   - SUPABASE_URL                   (auto-injected)
//   - SUPABASE_SERVICE_ROLE_KEY      (auto-injected)
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
const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const CUSTOMER_CHANNEL_ID = Deno.env.get("TELEGRAM_CUSTOMER_CHANNEL_ID") ?? "";
const ADMIN_CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID") || Deno.env.get("STAFF_APPROVAL_CHAT_ID") || "";

const ROOM_URL = "https://aurum-analaysis.com/room";
const BATCH_LIMIT = 5;
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000; // Asia/Bangkok = UTC+7 (no DST).

interface NewsRow {
  id: string;
  title: string;
  category: string;
  impact: string;
  published_at: string;
  image_url: string | null;
}

// ---------------------------------------------------------------------
// Telegram message formatting
// ---------------------------------------------------------------------
// Escape the characters that are special in Telegram's legacy "Markdown"
// parse mode, so a headline containing '_' / '*' / '`' / '[' can't break the
// message (we only escape the dynamic fields, not our own bold markers).
function mdEscape(s: string): string {
  return String(s).replace(/([_*`\[])/g, "\\$1");
}

function bangkokTimeLabel(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const bkk = new Date(d.getTime() + BANGKOK_OFFSET_MS);
  const hh = String(bkk.getUTCHours()).padStart(2, "0");
  const mm = String(bkk.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm} น.`;
}

function buildMessage(row: NewsRow): string {
  const time = bangkokTimeLabel(row.published_at);
  const meta = [time, mdEscape(row.category)].filter(Boolean).join(" · ");
  return (
    `🔴 *ข่าวสำคัญ AURUM AI*\n\n` +
    `📰 ${mdEscape(row.title)}\n` +
    `⏰ ${meta}\n` +
    `🎯 ผลกระทบต่อทอง: สูง\n\n` +
    `อ่านบทวิเคราะห์เต็ม:\n${ROOM_URL}`
  );
}

// POST to Telegram; sendPhoto when an image is available, else sendMessage.
// Returns true only on a confirmed ok response.
async function pushToChannel(row: NewsRow): Promise<boolean> {
  const text = buildMessage(row);
  const useImage = !!(row.image_url && /^https?:\/\//i.test(row.image_url));
  const method = useImage ? "sendPhoto" : "sendMessage";
  const payload: Record<string, unknown> = useImage
    ? {
        chat_id: CUSTOMER_CHANNEL_ID,
        photo: row.image_url,
        caption: text,
        parse_mode: "Markdown",
      }
    : {
        chat_id: CUSTOMER_CHANNEL_ID,
        text,
        parse_mode: "Markdown",
        disable_web_page_preview: false,
      };

  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.ok) {
    console.warn(`[telegram-news-pusher] ${method} failed for ${row.id}: ${JSON.stringify(data).slice(0, 220)}`);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------
// Admin failure-state bookkeeping (3-strikes alert to the ADMIN chat)
// ---------------------------------------------------------------------
async function alertAdmin(text: string): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN || !ADMIN_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: ADMIN_CHAT_ID, text, disable_web_page_preview: true }),
    });
  } catch (e) {
    console.warn("[telegram-news-pusher] admin alert failed:", String(e));
  }
}

async function recordSuccess(sb: SupabaseClient): Promise<void> {
  await sb.from("telegram_pusher_state").upsert(
    { id: 1, consecutive_failures: 0, last_run_at: new Date().toISOString(), last_error: null },
    { onConflict: "id" },
  );
}

async function recordFailure(sb: SupabaseClient, err: string): Promise<void> {
  let next = 1;
  try {
    const { data } = await sb.from("telegram_pusher_state").select("consecutive_failures").eq("id", 1).maybeSingle();
    next = ((data?.consecutive_failures as number) || 0) + 1;
  } catch (_) { /* default to 1 */ }
  await sb.from("telegram_pusher_state").upsert(
    { id: 1, consecutive_failures: next, last_run_at: new Date().toISOString(), last_error: err.slice(0, 500) },
    { onConflict: "id" },
  );
  if (next >= 3) {
    await alertAdmin(`AURUM telegram-news-pusher failed ${next}x in a row\n${err.slice(0, 300)}`);
  }
}

// ---------------------------------------------------------------------
// Main run
// ---------------------------------------------------------------------
async function runPush(sb: SupabaseClient) {
  // Missing config is a "not yet configured" state, not an outage — return a
  // soft skip so the 5-min cron stays quiet (no 3-strikes admin spam) until
  // Por adds the bot token / customer channel id. Once set it just works.
  if (!TELEGRAM_BOT_TOKEN || !CUSTOMER_CHANNEL_ID) {
    return {
      pending: 0,
      pushed: 0,
      with_image: 0,
      failed: 0,
      skipped: !TELEGRAM_BOT_TOKEN ? "missing_telegram_bot_token" : "missing_customer_channel_id",
    };
  }

  const { data: rows, error } = await sb
    .from("daily_news")
    .select("id, title, category, impact, published_at, image_url")
    .eq("pushed_to_telegram", false)
    .eq("impact", "high")
    .order("published_at", { ascending: false })
    .limit(BATCH_LIMIT);
  if (error) throw new Error(`select_failed: ${error.message}`);

  const pending = (rows || []) as NewsRow[];
  let pushed = 0, withImage = 0, failed = 0;

  for (const row of pending) {
    const ok = await pushToChannel(row);
    if (!ok) { failed++; continue; }
    if (row.image_url) withImage++;

    const { error: upErr } = await sb
      .from("daily_news")
      .update({ pushed_to_telegram: true, telegram_pushed_at: new Date().toISOString() })
      .eq("id", row.id);
    if (upErr) {
      // Sent but couldn't mark — log loudly; next tick may re-send this one.
      console.warn(`[telegram-news-pusher] sent but update failed for ${row.id}: ${upErr.message}`);
      failed++;
      continue;
    }
    pushed++;
  }

  return { pending: pending.length, pushed, with_image: withImage, failed };
}

serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  if (!SERVICE_ROLE_KEY) {
    return json({ ok: false, error: "missing_service_role_key" }, 500);
  }
  const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  try {
    const result = await runPush(sb);
    // A run that had rows to push but pushed none counts as a failure for the
    // 3-strikes alert; an empty queue (or all-pushed) is success.
    if (result.pending > 0 && result.pushed === 0) {
      await recordFailure(sb, `0/${result.pending} pushed`).catch(() => {});
    } else {
      await recordSuccess(sb);
    }
    console.log("[telegram-news-pusher] ok", JSON.stringify(result));
    return json({ ok: true, ...result });
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e);
    console.error("[telegram-news-pusher] run failed:", msg);
    await recordFailure(sb, msg).catch(() => {});
    // Soft-fail: 200 so pg_cron doesn't retry-storm; state table tracks health.
    return json({ ok: false, error: msg }, 200);
  }
});
