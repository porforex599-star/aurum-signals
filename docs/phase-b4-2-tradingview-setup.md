# Phase B.4.2 — AI briefings พร้อม AURUM chart อัตโนมัติ (chart-img.com)

> เป้าหมาย: ให้ briefing 3 รอบ/วัน (09:00 / 14:00 / 20:00 เวลาไทย) แสดง **chart
> ที่มี AURUM custom indicators** (EMA white/green/yellow/red · 3s-Bear/Bull
> markers · S/D zones · gold areas) — โดย **อัตโนมัติ** ไม่ต้องตั้ง TradingView
> alert เอง

> **TL;DR สำหรับ Por:** สิ่งเดียวที่ต้องทำคือเพิ่ม secret **`CHART_IMG_API_KEY`**
> ใน Supabase (ดู [ส่วน "Por's setup"](#por-setup)) — ที่เหลือ `scheduled-analyzer`
> ทำให้เองทุกรอบ

---

## STEP 1 — chart_image_url ปัจจุบันมาจากไหน (ผลการตรวจสอบ)

ตรวจ `analysis_posts` + Supabase Storage พบว่า:

| source | จำนวน | มี chart_image_url | URL ชี้ไปไหน |
|---|---|---|---|
| `admin_manual` | 11 | 11/11 | **Supabase Storage** bucket `analysis-snapshots` |
| `ai_scheduled` | 3 | 0/3 | briefing เดิม (Phase B.4) ยังไม่มี chart |
| `pine_webhook` | 0 | — | ยังไม่มีแถวในระบบนี้ |

**URL pattern จริง:**

```
https://etwlurpjrqlvrxgsbhkd.supabase.co/storage/v1/object/public/analysis-snapshots/<id>.png
```

→ **ไม่ใช่** `s3.tradingview.com` / `res.cloudinary.com` · เป็น **Supabase
Storage** bucket `analysis-snapshots` (public)

**กลไกที่สร้าง PNG:** render โดย **chart-img.com** จาก *TradingView saved
layout* `uoSX32t7` (ฝัง AURUM Pine V.2 indicators ครบ) → upload เข้า Supabase
Storage. เดิมงานนี้ทำใน service `aurum-ai-engine` (Railway). Phase B.4.2 Part 2
ย้าย/จำลองกลไกนี้มาไว้ใน `scheduled-analyzer` โดยตรง เพื่อให้ briefing cron
สร้าง chart เองได้ทุกรอบ

**สรุป:** `analysis_posts.chart_image_url` เป็นแค่ column `text` เก็บ URL —
`/room` ทำ `<img src=chart_image_url>` ให้เอง ใส่ URL ไหนก็แสดงทันที

---

## STEP 2 — กลไกใหม่: chart-img.com auto-generation (PRIMARY) {#chart-img}

`scheduled-analyzer` v5 สร้าง chart เองทุกครั้งที่โพสต์ briefing:

```
cron ({"slot":"morning"})
        │
        ▼
  Claude เขียน briefing ภาษาไทย  ──►  banned-vocab guard
        │
        ▼
  generateAurumChart():
    POST https://api.chart-img.com/v2/tradingview/layout-chart/uoSX32t7
      headers: x-api-key: CHART_IMG_API_KEY
      body:    { symbol:"OANDA:XAUUSD", interval:"15", theme:"dark", 1280×720 }
        │  PNG bytes
        ▼
    upload → Supabase Storage bucket "analysis-snapshots"
             ไฟล์ briefing-<slot>-<uuid>.png
        │  public URL
        ▼
  INSERT analysis_posts (chart_image_url = public URL)
        │
        ▼
  /room  ──►  <img src=chart_image_url>  = AURUM chart จริง
```

จุดสำคัญของการออกแบบ:

- ใช้ endpoint **`layout-chart/{LAYOUT_ID}`** ไม่ใช่ `advanced-chart` — เพราะ
  layout-chart เป็นตัวที่พก **custom Pine studies** ของ layout ที่บันทึกไว้
  (AURUM indicators) มาด้วย ส่วน advanced-chart สร้างจาก public studies เท่านั้น
- upload เข้า bucket **`analysis-snapshots`** ของเราเอง (ตัวเดียวกับ Pine/admin
  charts) → URL ไม่หมดอายุ (ต่างจาก chart-img storage ที่หมดอายุตามแพ็กเกจ)
- **fail-soft:** ถ้าไม่มี `CHART_IMG_API_KEY` หรือ chart-img/upload error →
  log + `chart_image_url` เป็น `NULL` → briefing ยังโพสต์ปกติ แค่ /room แสดง
  placeholder `รอข้อมูลแท่งเทียน` (ไม่ crash, ไม่ค้าง)
- **webhook ยังใช้ได้:** ถ้ามี webhook ส่ง `chart_image_url` มา จะใช้ของ webhook
  (ไม่เรียก chart-img ซ้ำ) — เก็บ path นี้ไว้เผื่ออนาคต

ปรับแต่งผ่าน env (มี default แล้ว ไม่ต้องตั้งก็ได้):

| env | default | ความหมาย |
|---|---|---|
| `CHART_IMG_API_KEY` | — (**ต้องตั้ง**) | API key จาก chart-img.com |
| `CHART_IMG_LAYOUT_ID` | `uoSX32t7` | TradingView saved layout ของ Por |
| `CHART_IMG_SYMBOL` | `OANDA:XAUUSD` | symbol |
| `CHART_IMG_INTERVAL` | `15` | timeframe (M15) |

---

## STEP 3 — Por's setup (สิ่งเดียวที่ต้องทำ) {#por-setup}

### 3.1 สร้าง chart-img.com API key + เชื่อม layout uoSX32t7

1. เข้า https://chart-img.com → dashboard → คัดลอก **API Key**
2. ใน chart-img account ต้องมี TradingView layout `uoSX32t7` ที่เข้าถึงได้
   (layout ที่มี AURUM Pine V.2 indicators) — chart-img ต้องลิงก์กับ TradingView
   account ที่ layout นี้ถูกบันทึก/แชร์ไว้ มิฉะนั้น layout-chart จะคืน 4xx
   - แพ็กเกจ chart-img ต้องรองรับ **layout-chart / custom indicators**
     (แพ็กเกจฟรีมักจำกัด — ตรวจสอบ plan)

### 3.2 เพิ่ม secret ใน Supabase

**ผ่าน Dashboard:** Project `aurum-customers` → Edge Functions → Manage secrets
→ Add new secret:
```
Name:  CHART_IMG_API_KEY
Value: <API key จาก chart-img.com>
```

**หรือผ่าน CLI:**
```bash
supabase secrets set CHART_IMG_API_KEY=xxxxxxxx --project-ref etwlurpjrqlvrxgsbhkd
```

> secret มีผลทันทีกับ `scheduled-analyzer` ที่ deploy ไว้แล้ว (v5) — ไม่ต้อง
> redeploy

### 3.3 ทดสอบ

```sql
-- ลบ briefing slot ที่จะทดสอบของวันนี้ออกก่อน (idempotency จะกันไม่ให้โพสต์ซ้ำ)
DELETE FROM analysis_posts
WHERE source='ai_scheduled' AND schedule_slot='morning'
  AND created_at >= (now() AT TIME ZONE 'Asia/Bangkok')::date;

-- trigger cron-style (chart-img จะถูกเรียกภายใน)
SELECT net.http_post(
  url     := 'https://etwlurpjrqlvrxgsbhkd.supabase.co/functions/v1/scheduled-analyzer',
  headers := '{"Content-Type":"application/json"}'::jsonb,
  body    := '{"slot":"morning"}'::jsonb,
  timeout_milliseconds := 90000
);

-- ~30 วินาที แล้วตรวจผล
SELECT id, schedule_slot, left(chart_image_url,80) AS chart, created_at
FROM analysis_posts
WHERE source='ai_scheduled' AND schedule_slot='morning'
ORDER BY created_at DESC LIMIT 1;
```

→ `chart_image_url` ต้องเป็น `…/storage/v1/object/public/analysis-snapshots/briefing-morning-<uuid>.png`
→ เปิด URL ใน browser → ต้องเห็น **AURUM chart พร้อม indicators**
→ เปิด `/room` → คลิก briefing → เห็น chart

ตรวจ response ของ function (ดู field `chart_source`):
- `"chart-img"` = สร้างจาก chart-img สำเร็จ ✅
- `"none"` = ไม่ได้ chart (ไม่มี key หรือ chart-img/upload ล้มเหลว) → ดู
  Edge Function logs หา `[scheduled-analyzer] CHART_IMG_API_KEY not set` หรือ
  `chart-img <status>` เพื่อ debug

---

## STEP 4 — Disable cron? (ไม่ต้อง)

ต่างจาก plan เดิม — **cron คือ path หลักแล้ว** (มันสร้าง chart เอง) จึง **เก็บ
cron ไว้** 3 jobs ทำงานต่อ:

```
scheduled_analyzer_morning   · 09:00 Asia/Bangkok
scheduled_analyzer_afternoon · 14:00
scheduled_analyzer_evening   · 20:00
```

ไม่ต้อง unschedule อะไร

---

## ภาคผนวก (OPTIONAL / DEPRECATED) — Pine V.2 webhook + TradingView alerts

> Phase B.4.2 Part 1 เพิ่ม webhook path ไว้ ตอนนี้ **ไม่จำเป็นแล้ว** เพราะ
> chart-img auto-generation ทำงานแทน เก็บไว้เป็น future-proof เท่านั้น —
> **Por ไม่ต้อง setup TradingView alerts**

เหตุผลที่เลิกใช้: TradingView **ไม่มี** placeholder `{{chart}}` ที่ใส่ URL รูป
ลงใน webhook body ได้ (ตัวเลือก "Include chart screenshot" แนบรูปไปกับ
email/app เท่านั้น ไม่ใช่ webhook) — ดังนั้นการพึ่ง TradingView แนบ chart
จึงทำไม่ได้ chart-img จึงเป็นทางออกที่ถูกต้อง

หากภายหลังต้องการใช้ webhook path (เช่นมีแหล่ง chart อื่นที่ให้ URL จริง):
`scheduled-analyzer` ยังรับ body นี้อยู่ และจะใช้ `chart_image_url` ที่ส่งมา
แทนการเรียก chart-img:

```json
{"type":"briefing_webhook","slot":"morning","chart_image_url":"https://.../chart.png"}
```

handler รับเฉพาะ URL ที่ขึ้นต้น `http(s)` เท่านั้น (กัน `{{chart}}` ที่ไม่ถูกแทนค่า)

---

## สรุป behaviour ของ scheduled-analyzer v5

| invocation | chart_image_url ที่บันทึก | chart_source |
|---|---|---|
| cron `{"slot":"morning"}` + มี CHART_IMG_API_KEY | chart-img → Supabase Storage URL | `chart-img` |
| cron + **ไม่มี** CHART_IMG_API_KEY | `NULL` → placeholder | `none` |
| webhook ที่พก `chart_image_url` (http) | URL นั้น (ไม่เรียก chart-img) | `webhook` |
| chart-img / upload error | `NULL` → placeholder (soft) | `none` |

ทุก path เรียก Claude (Sonnet 4.5) เขียน briefing ไทย + ผ่าน banned-vocab guard
เหมือนเดิม · idempotency กัน duplicate ต่อ slot/วัน ไม่เปลี่ยน
