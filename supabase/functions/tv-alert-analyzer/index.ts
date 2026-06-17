// supabase/functions/tv-alert-analyzer/index.ts
//
// AURUM Analysis · TV Alert → AI Analysis Edge Function
//
// Pipeline:
//   1. Receive TradingView webhook payload (Pine alert from Aurum Gold V2.1.1)
//   2. Filter: only arrow_level === 3 (M5 or M15) → proceed; else skip
//   3. Render chart-img.com snapshot of the saved TV layout (Aurum Gold V2.1.1
//      baked in) via the SAME proven path as scheduled-analyzer:
//        POST /v2/tradingview/layout-chart/{layoutId}
//        headers: x-api-key + tradingview-session-id(+sign) for the private
//        indicator · body hides UI chrome for IP protection
//      → PNG bytes → upload to Supabase Storage (public URL for the room) and
//      send the PNG to Claude as a base64 image (no reliance on Anthropic being
//      able to fetch a header-authed chart-img URL).
//   4. Claude Sonnet 4.6 (vision) writes the analysis JSON.
//   5. Validate (no price numbers · no banned vocab · ≥3 indicator refs).
//   6. Retry up to 3x with feedback loop.
//   7. Write analysis_json + chart_image_url to analysis_posts.
//
// Env (Supabase secrets):
//   ANTHROPIC_API_KEY          · required
//   CHART_IMG_API_KEY          · required (chart-img.com)
//   CHART_IMG_LAYOUT_ID        · optional · defaults to public TV slug uoSX32t7
//   TV_SESSION_ID / TV_SESSION_ID_SIGN · render the private Aurum indicator
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY · auto

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ---------- Config ----------

const MODEL = "claude-sonnet-4-6";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_ATTEMPTS = 3;
const MIN_INDICATOR_REFS = 3;

const CHART_SNAPSHOT_BUCKET = "analysis-snapshots";
const CHART_IMG_SYMBOL_DEFAULT = "OANDA:XAUUSD";

const SYSTEM_PROMPT = `คุณคือ AI วิเคราะห์ทองคำ XAUUSD สำหรับลูกค้า AURUM ANALYSIS

หน้าที่ของคุณ: อ่านภาพ chart snapshot จาก TradingView ที่มี indicator "Aurum Gold V2.1.1" ติดอยู่ และข้อมูล Pine alert payload เพิ่มเติม จากนั้นเขียนบทวิเคราะห์เป็น JSON ตาม schema ที่กำหนด

=== กฎเหล็ก · ห้ามฝ่าฝืน ===

1. ห้ามใส่ตัวเลขราคาในผลลัพธ์ทุกประเภท
   ❌ ผิด: "ราคา 4,332.50" · "ที่ระดับ 4330" · "ขอบบน 4,348"
   ✅ ถูก: "ราคายืนเหนือ L1" · "ใกล้ขอบบนของ Zone B" · "เหนือเส้น L0"
   ลูกค้าต้องอ่านตัวเลขจากกราฟเอง

2. ห้ามใช้คำต้องห้าม (customer-facing banned vocabulary):
   ❌ signal · สัญญาณ · trade · เทรด · นักเทรด · trader · BUY · SELL
   ❌ entry · TP · SL · stop loss · take profit · ROI · profit · กำไร · pips · MT5 · MT4
   ✅ ใช้แทน: บทวิเคราะห์ · มุมมอง · จุดสำคัญ · โซนเป้าหมาย · ผู้ลงทุน · ผู้ร่วมตลาด · ทดสอบ · ยืน · หลุด

3. ต้องอ้างอิงจาก indicator component อย่างน้อย 3 ตัวในผลลัพธ์รวม:
   - L0 (เส้นขาว · EMA สั้น)
   - L1 / L2 / L3 / L4 (เส้นเหลือง/เขียว/แดง · SMMA หลายช่วง)
   - P1 / P2 (3-line strike pattern)
   - P3 / P4 (big candle pattern)
   - Zone A (โซนเขียวด้านล่าง · demand · แนวรับ)
   - Zone B (โซนแดงด้านบน · supply · แนวต้าน)
   - ▲▲ 3s-Bull (ลูกศรขึ้นระดับ 3) · ▼▼ 3s-Bear (ลูกศรลงระดับ 3)
   - BG1 / BG2 (session background) · S1 (CME open marker)

4. สไตล์: peer-to-peer · นิ่ง · มืออาชีพ · ไม่ hype · ไม่ใช้คำว่า "แน่นอน" "ชัวร์" "100%"

=== Output JSON schema (ต้องตอบเป็น raw JSON เท่านั้น · ห้ามใส่ markdown หรือ code fence) ===

{
  "direction": "bull" หรือ "bear",
  "direction_label": "มุมมองขาขึ้น" หรือ "มุมมองขาลง",
  "trend": "string · 2-3 ประโยค · อธิบายโครงสร้างราคาผ่าน indicator (L0 อยู่เหนือ/ใต้ L1 / โครงสร้างทำ HH-HL หรือ LH-LL / P1-P4 ปรากฏหรือไม่ / ลูกศรเกิดที่จุดไหน)",
  "position_in_range": "string · 1-2 ประโยค · ราคาอยู่ตำแหน่งไหนเทียบ Zone A / Zone B · ใกล้ขอบไหนมากกว่ากัน",
  "zone_a": "string · 1 ประโยคสั้น · บทบาทของ Zone A ขณะนี้ (เช่น เป็นแนวรับที่ราคากลับตัวขึ้นมาแล้วหลายครั้ง)",
  "zone_b": "string · 1 ประโยคสั้น · บทบาทของ Zone B ขณะนี้ (เช่น เป็นแนวต้านที่ต้องทดสอบต่อ)",
  "outlook": "string · 1-2 ประโยค · conditional 2 ทาง · ถ้าราคายืนเหนือ X → ทดสอบ Y · ถ้าหลุด X → กลับ Z"
}

ห้ามใส่ field อื่นนอกจากนี้`;

// ---------- Validators ----------

const BANNED_VOCAB = [
  "signal", "สัญญาณ", "trade", "เทรด", "นักเทรด", "trader",
  "buy", "sell", "entry", "tp", "sl", "stop loss", "take profit",
  "roi", "profit", "กำไร", "pips", "mt5", "mt4"
];

const INDICATOR_REFS = [
  "L0", "L1", "L2", "L3", "L4",
  "P1", "P2", "P3", "P4",
  "Zone A", "Zone B",
  "3s-Bull", "3s-Bear",
  "▲▲", "▼▼",
  "BG1", "BG2", "S1"
];

const PRICE_REGEX = /\b\d{1,2}[,.]?\d{3}\.?\d*\b/;

function hasPriceNumber(text: string): string | null {
  const m = text.match(PRICE_REGEX);
  return m ? m[0] : null;
}

function hasBannedVocab(text: string): string | null {
  const lower = text.toLowerCase();
  for (const word of BANNED_VOCAB) {
    const re = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(lower)) return word;
  }
  return null;
}

function countIndicatorRefs(text: string): { count: number; found: string[] } {
  const found = new Set<string>();
  for (const ref of INDICATOR_REFS) {
    if (text.includes(ref)) found.add(ref);
  }
  return { count: found.size, found: [...found] };
}

interface ValidationResult {
  ok: boolean;
  reason?: string;
  feedback_for_retry?: string;
}

function validate(json: any): ValidationResult {
  const required = ["direction", "direction_label", "trend", "position_in_range", "zone_a", "zone_b", "outlook"];
  for (const k of required) {
    if (!(k in json)) return { ok: false, reason: `missing_field:${k}` };
  }
  if (!["bull", "bear"].includes(json.direction)) {
    return { ok: false, reason: `invalid_direction:${json.direction}` };
  }

  const fullText = [json.trend, json.position_in_range, json.zone_a, json.zone_b, json.outlook].join(" ");

  const priceHit = hasPriceNumber(fullText);
  if (priceHit) {
    return {
      ok: false,
      reason: `price_number:${priceHit}`,
      feedback_for_retry: `พบตัวเลขราคา "${priceHit}" ในผลลัพธ์ · เขียนใหม่โดยไม่มีตัวเลขราคาเลย · ใช้การอ้างอิงตำแหน่งจาก indicator เท่านั้น (เช่น "เหนือ L1" "ใกล้ Zone B" แทน "ที่ ${priceHit}")`
    };
  }

  const bannedHit = hasBannedVocab(fullText);
  if (bannedHit) {
    return {
      ok: false,
      reason: `banned_vocab:${bannedHit}`,
      feedback_for_retry: `พบคำต้องห้าม "${bannedHit}" · เขียนใหม่โดยใช้คำที่อนุญาต (บทวิเคราะห์ · มุมมอง · ผู้ลงทุน · ทดสอบ · ยืน · หลุด)`
    };
  }

  const { count, found } = countIndicatorRefs(fullText);
  if (count < MIN_INDICATOR_REFS) {
    return {
      ok: false,
      reason: `insufficient_refs:${count}`,
      feedback_for_retry: `อ้างอิง indicator แค่ ${count} ตัว (${found.join(", ") || "ไม่มีเลย"}) · ต้องอ้างอิงอย่างน้อย ${MIN_INDICATOR_REFS} ตัวจาก L0-L4 · P1-P4 · Zone A/B · 3s-Bull/3s-Bear · เขียนใหม่ให้มีการอ้างอิง indicator มากขึ้น`
    };
  }

  return { ok: true };
}

// ---------- chart-img.com (saved layout → PNG bytes) ----------

function timeframeToInterval(tf: string): string {
  if (tf === "M5" || tf === "5" || tf === "5m") return "5m";
  if (tf === "M15" || tf === "15" || tf === "15m") return "15m";
  throw new Error(`unsupported_timeframe:${tf}`);
}

// UI chrome hidden for indicator IP protection (mirrors scheduled-analyzer v10).
const CHART_DISABLED_FEATURES = [
  "header_widget", "timeframes_toolbar", "header_chart_type", "header_settings",
  "header_indicators", "header_compare", "header_undo_redo", "header_screenshot",
  "header_fullscreen_button", "left_toolbar", "control_bar", "legend_widget",
  "edit_buttons_in_legend", "study_buttons_in_legend", "main_series_scale_menu",
  "context_menus"
];

async function fetchChartPng(opts: {
  layoutId: string;
  interval: string;
  symbol: string;
  apiKey: string;
  tvSession: string;
  tvSessionSign: string;
}): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; error: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  const headers: Record<string, string> = {
    "x-api-key": opts.apiKey,
    "content-type": "application/json"
  };
  if (opts.tvSession) headers["tradingview-session-id"] = opts.tvSession;
  if (opts.tvSessionSign) headers["tradingview-session-id-sign"] = opts.tvSessionSign;

  let res: Response;
  try {
    res = await fetch(`https://api.chart-img.com/v2/tradingview/layout-chart/${opts.layoutId}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        symbol: opts.symbol,
        interval: opts.interval,
        theme: "dark",
        width: 1280,
        height: 720,
        disabledFeatures: CHART_DISABLED_FEATURES,
        hideLegend: true,
        hideTopToolbar: true,
        hideSideToolbar: true,
        hideVolume: false
      }),
      signal: ctrl.signal
    });
  } catch (e: any) {
    return { ok: false, error: `fetch:${String(e?.message ?? e).slice(0, 200)}` };
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    return { ok: false, error: `chart-img ${res.status}:${detail}` };
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength === 0) return { ok: false, error: "chart-img empty body" };
  return { ok: true, bytes };
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

// ---------- Claude call with retry loop (REST API, base64 image) ----------

interface GenerateResult {
  ok: boolean;
  json?: any;
  attempts: number;
  fail_reason?: string;
  retry_reasons: string[];
}

interface ClaudeMessage {
  role: "user" | "assistant";
  content: any;
}

async function callClaude(
  apiKey: string,
  messages: ClaudeMessage[]
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json"
      },
      body: JSON.stringify({ model: MODEL, max_tokens: 1500, system: SYSTEM_PROMPT, messages })
    });
  } catch (e: any) {
    return { ok: false, error: `fetch_failed:${e.message}` };
  }
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    return { ok: false, error: `http_${res.status}:${detail}` };
  }
  const data = await res.json();
  const text: string = data?.content?.find((b: any) => b.type === "text")?.text ?? "";
  return { ok: true, text };
}

async function generateAnalysis(
  apiKey: string,
  imageBase64: string,
  pinePayload: any
): Promise<GenerateResult> {
  const messages: ClaudeMessage[] = [];
  const retryReasons: string[] = [];

  messages.push({
    role: "user",
    content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: imageBase64 } },
      {
        type: "text",
        text: `Pine alert payload (ใช้เป็น context เท่านั้น · ตัวเลขในนี้ห้ามนำออกมาแสดงในผลลัพธ์):
\`\`\`json
${JSON.stringify(pinePayload, null, 2)}
\`\`\`

อ่าน chart snapshot ด้านบน แล้ววิเคราะห์ตาม schema · ตอบเป็น raw JSON เท่านั้น`
      }
    ]
  });

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const call = await callClaude(apiKey, messages);
    if (!call.ok) {
      retryReasons.push(`api_error:${call.error}`);
      return { ok: false, attempts: attempt, fail_reason: `api_error:${call.error}`, retry_reasons: retryReasons };
    }

    const raw = call.text.trim();
    if (!raw) {
      retryReasons.push("no_text_block");
      continue;
    }
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();

    let parsed: any;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      retryReasons.push("invalid_json");
      messages.push({ role: "assistant", content: raw });
      messages.push({ role: "user", content: "ผลลัพธ์รอบนี้ไม่ใช่ valid JSON · ตอบใหม่เป็น raw JSON ตาม schema เท่านั้น · ห้ามใส่ markdown หรือ code fence" });
      continue;
    }

    const v = validate(parsed);
    if (v.ok) {
      return { ok: true, json: parsed, attempts: attempt, retry_reasons: retryReasons };
    }

    retryReasons.push(v.reason!);
    if (attempt < MAX_ATTEMPTS) {
      messages.push({ role: "assistant", content: raw });
      messages.push({ role: "user", content: v.feedback_for_retry! });
    }
  }

  return {
    ok: false,
    attempts: MAX_ATTEMPTS,
    fail_reason: retryReasons[retryReasons.length - 1],
    retry_reasons: retryReasons
  };
}

// ---------- Edge Function handler ----------

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: { "Content-Type": "application/json" } });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid_json_body" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }

  const symbol = body.symbol || "XAUUSD";
  const timeframe = body.timeframe;
  const arrowLevel = body.arrow_level;

  if (!timeframe || !["M5", "M15"].includes(timeframe)) {
    return new Response(JSON.stringify({ error: "invalid_timeframe", got: timeframe }), { status: 400, headers: { "Content-Type": "application/json" } });
  }

  // Level filter: only Level 3 triggers AI analysis
  if (arrowLevel !== 3) {
    return new Response(JSON.stringify({
      skipped: true,
      reason: `arrow_level_${arrowLevel}_not_level_3`,
      message: `AI วิเคราะห์เฉพาะลูกศรระดับ 3 เท่านั้น`
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  // Env
  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
  const chartImgKey = Deno.env.get("CHART_IMG_API_KEY");
  // The TradingView layout id is NOT a secret — it is the public chart slug
  // (tradingview.com/chart/uoSX32t7). Env override, else the known default.
  const layoutId = Deno.env.get("CHART_IMG_LAYOUT_ID") || "uoSX32t7";
  const tvSession = Deno.env.get("TV_SESSION_ID") ?? "";
  const tvSessionSign = Deno.env.get("TV_SESSION_ID_SIGN") ?? "";
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!anthropicKey || !chartImgKey || !supabaseUrl || !supabaseKey) {
    return new Response(JSON.stringify({
      error: "missing_env",
      need: ["ANTHROPIC_API_KEY", "CHART_IMG_API_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"],
      // presence-only diagnostic (no secret values leaked)
      present: {
        ANTHROPIC_API_KEY: !!anthropicKey,
        CHART_IMG_API_KEY: !!chartImgKey,
        CHART_IMG_LAYOUT_ID_env: !!Deno.env.get("CHART_IMG_LAYOUT_ID"),
        TV_SESSION_ID: !!tvSession,
        TV_SESSION_ID_SIGN: !!tvSessionSign,
        SUPABASE_URL: !!supabaseUrl,
        SUPABASE_SERVICE_ROLE_KEY: !!supabaseKey
      }
    }), { status: 500, headers: { "Content-Type": "application/json" } });
  }

  let interval: string;
  try {
    interval = timeframeToInterval(timeframe);
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), { status: 400, headers: { "Content-Type": "application/json" } });
  }

  const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

  // Sanitized Pine context (raw numbers stripped — Claude must not echo prices)
  const pineContext = {
    symbol,
    timeframe,
    arrow: { level: arrowLevel, direction: body.arrow_direction, label: body.arrow_label },
    zone_a_touched: body.zone_a?.touched ?? false,
    zone_b_touched: body.zone_b?.touched ?? false,
    line_arrangement_bullish: (body.lines?.L0 ?? 0) > (body.lines?.L1 ?? 0),
    patterns_active: {
      P1: !!body.patterns?.P1,
      P2: !!body.patterns?.P2,
      P3: !!body.patterns?.P3,
      P4: !!body.patterns?.P4
    },
    time_bkk: body.time
  };

  // Insert pending row first → post_id anchors telemetry + lets the room show a
  // "generating" card immediately.
  const sessionLabel = sessionLabelFromTime(body.time);
  const { data: inserted, error: insertErr } = await supabase
    .from("analysis_posts")
    .insert({
      symbol,
      timeframe,
      kind: "arrow_alert",
      arrow_level: arrowLevel,
      arrow_direction: body.arrow_direction,
      session_label: sessionLabel,
      analysis_status: "generating",
      pine_payload: body,
      published_at: body.time || new Date().toISOString()
    })
    .select("id")
    .single();

  if (insertErr || !inserted) {
    return new Response(JSON.stringify({ error: "db_insert_failed", detail: insertErr?.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
  const postId = inserted.id;

  async function fail(failReason: string, httpStatus: number) {
    await supabase.from("analysis_telemetry").insert({
      post_id: postId, symbol, timeframe, arrow_level: arrowLevel,
      status: "failed", attempts: 0, retry_reasons: [failReason], fail_reason: failReason
    });
    await supabase.from("analysis_posts").update({ analysis_status: "failed", fail_reason: failReason }).eq("id", postId);
    return new Response(JSON.stringify({ ok: false, post_id: postId, fail_reason: failReason }), { status: httpStatus, headers: { "Content-Type": "application/json" } });
  }

  // Render the chart (private indicator baked in) → PNG bytes
  const chart = await fetchChartPng({
    layoutId, interval, symbol: CHART_IMG_SYMBOL_DEFAULT,
    apiKey: chartImgKey, tvSession, tvSessionSign
  });
  if (!chart.ok) {
    return await fail(`chart_error:${chart.error}`, 502);
  }

  // Upload PNG → Supabase Storage (public URL for the room card)
  let chartPublicUrl: string | null = null;
  try {
    const path = `arrow-${timeframe}-${crypto.randomUUID()}.png`;
    const { error: upErr } = await supabase.storage
      .from(CHART_SNAPSHOT_BUCKET)
      .upload(path, chart.bytes, { contentType: "image/png", upsert: false });
    if (!upErr) {
      const { data: pub } = supabase.storage.from(CHART_SNAPSHOT_BUCKET).getPublicUrl(path);
      chartPublicUrl = pub?.publicUrl ?? null;
    }
  } catch (_) { /* non-fatal — analysis can still run from the base64 image */ }

  if (chartPublicUrl) {
    await supabase.from("analysis_posts")
      .update({ chart_image_url: chartPublicUrl, chart_image_generated_at: new Date().toISOString() })
      .eq("id", postId);
  }

  // Generate (send the PNG as base64 — Anthropic can't header-auth chart-img)
  const imageBase64 = bytesToBase64(chart.bytes);
  const result = await generateAnalysis(anthropicKey, imageBase64, pineContext);

  await supabase.from("analysis_telemetry").insert({
    post_id: postId, symbol, timeframe, arrow_level: arrowLevel,
    status: result.ok ? "success" : "failed",
    attempts: result.attempts,
    retry_reasons: result.retry_reasons,
    fail_reason: result.fail_reason ?? null
  });

  if (!result.ok) {
    await supabase.from("analysis_posts")
      .update({ analysis_status: "failed", fail_reason: result.fail_reason })
      .eq("id", postId);
    return new Response(JSON.stringify({
      ok: false, post_id: postId, attempts: result.attempts,
      fail_reason: result.fail_reason, retry_reasons: result.retry_reasons
    }), { status: 500, headers: { "Content-Type": "application/json" } });
  }

  await supabase.from("analysis_posts")
    .update({ analysis_json: result.json, analysis_status: "ready", generated_at: new Date().toISOString() })
    .eq("id", postId);

  return new Response(JSON.stringify({
    ok: true, post_id: postId, attempts: result.attempts,
    chart_image_url: chartPublicUrl, analysis: result.json
  }), { status: 200, headers: { "Content-Type": "application/json" } });
});

// ---------- helpers ----------

function sessionLabelFromTime(iso?: string): string {
  const d = iso ? new Date(iso) : new Date();
  const bkkHour = (d.getUTCHours() + 7) % 24;
  if (bkkHour >= 5 && bkkHour < 12) return "ช่วงเช้า";
  if (bkkHour >= 12 && bkkHour < 18) return "ช่วงบ่าย";
  return "ช่วงค่ำ";
}
