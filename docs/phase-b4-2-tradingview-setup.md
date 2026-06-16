# Phase B.4.2 — AI briefings ผ่าน Pine V.2 webhook (chart AURUM จริง)

> เป้าหมาย: ให้ briefing 3 รอบ/วัน (09:00 / 14:00 / 20:00 เวลาไทย) แสดง **chart
> screenshot ที่มี AURUM custom indicators** (EMA white/green/yellow/red ·
> 3s-Bear/Bull markers · S/D zones · gold areas) — ไม่ใช่ TradingView iframe
> เปล่าๆ ที่ไม่มี indicator (Phase B.4.1 ที่ถูกยกเลิก)

---

## STEP 1 — chart_image_url ปัจจุบันมาจากไหน (ผลการตรวจสอบ)

ตรวจ `analysis_posts` พบว่า:

| source | จำนวน | มี chart_image_url | หมายเหตุ |
|---|---|---|---|
| `admin_manual` | 11 | 11/11 | URL ทุกตัวชี้ไป **Supabase Storage** |
| `ai_scheduled` | 3 | 0/3 | briefing เดิม (Phase B.4) ยังไม่มี chart |
| `null` (legacy) | 13 | 2/13 | ของเก่า |
| `pine_webhook` | 0 | — | ยังไม่มีแถวในระบบนี้ |

**URL pattern ของ chart ที่ทำงานอยู่จริง:**

```
https://etwlurpjrqlvrxgsbhkd.supabase.co/storage/v1/object/public/...
```

→ **ไม่ใช่** `s3.tradingview.com` และ **ไม่ใช่** `res.cloudinary.com`
→ เป็น **Supabase Storage** (ไฟล์ PNG ที่ถูก upload เข้ามา)

**กลไกที่สร้าง PNG:** PNG ถูก render โดย **chart-img.com** จาก *TradingView
shared layout* (`uoSX32t7`) ที่ฝัง AURUM indicators ไว้ครบ แล้ว upload เข้า
Supabase Storage (ดู `scripts/phase7-screenshots.js` และคอมเมนต์ใน
`room.html` → `renderInlineChart()` ที่ระบุว่า "chart-img.com PNG ... bakes in
every indicator from the TradingView shared layout").

**ตัว ingest ของ Pine webhook อยู่ที่ไหน:** ไม่ได้อยู่ใน repo นี้ — อยู่ใน
service `aurum-ai-engine` (Railway). repo นี้มี edge function แค่
`scheduled-analyzer`, `news-fetcher`, `news-article-generator`,
`aurum-gold-get-my-subscription-state`.

**สรุปสำหรับ briefings:** `analysis_posts.chart_image_url` เป็นแค่คอลัมน์
`text` ที่เก็บ URL เปล่าๆ แล้ว `/room` ก็ `<img src=chart_image_url>` ให้เอง
ดังนั้นถ้าเราใส่ URL ของ chart ลงไปได้ ไม่ว่ามาจากแหล่งไหน /room จะแสดงทันที
นี่คือสิ่งที่ Phase B.4.2 ทำ: `scheduled-analyzer` รับ webhook ที่พก
`chart_image_url` มา แล้วเขียนลง column เดียวกันนี้

---

## ⚠️ ข้อควรรู้สำคัญเกี่ยวกับ `{{chart}}` (อ่านก่อนทำ)

TradingView **ไม่มี** placeholder `{{chart}}` สำหรับใส่ "URL ของรูป chart" ลงใน
ข้อความ webhook — ตัวเลือก **"Include chart screenshot in alert"** จะแนบรูปไปกับ
**email / mobile push / SMS** เท่านั้น **ไม่ได้** ใส่ URL ลงใน JSON body ที่ POST
มาที่ webhook

ผลที่ตามมา:

- ถ้าใส่ `"chart_image_url":"{{chart}}"` ในข้อความ alert → TradingView จะส่งสตริง
  `{{chart}}` มาดื้อๆ (ไม่ถูกแทนค่า)
- `scheduled-analyzer` v4 **ป้องกันไว้แล้ว**: รับเฉพาะค่าที่ขึ้นต้นด้วย
  `http://` / `https://` เท่านั้น ถ้าเป็น `{{chart}}` หรือว่าง → `chart_image_url`
  จะเป็น `NULL` และ /room แสดง placeholder **"รอข้อมูลแท่งเทียน"** (degrade
  อย่างปลอดภัย ไม่ error)

### ทางเลือกในการได้ chart AURUM จริงเข้ามา

**ตัวเลือก A — TradingView แนบรูปเอง (ลองก่อน, ง่ายสุด):**
ตั้ง alert พร้อม "Include chart screenshot" แล้วทดสอบ 1 ครั้ง ดู log ว่า body
ที่เข้ามาจริงมี URL ของรูปไหม (บาง integration / แผนของ TradingView อาจมี field
ให้) — ถ้ามี ก็ map ค่านั้นเข้า `chart_image_url` ได้เลย

**ตัวเลือก B — สร้าง chart ฝั่ง server (robust, แนะนำระยะยาว):**
ใช้กลไกเดียวกับ Pine posts — ให้ `aurum-ai-engine` (หรือเพิ่มใน
`scheduled-analyzer`) เรียก **chart-img.com** ด้วย shared layout `uoSX32t7`
(ที่มี AURUM indicators) ตอนได้รับ webhook → upload Supabase Storage → ใส่ URL
ลง payload ก่อนเรียก `scheduled-analyzer` ข้อดี: ได้ chart AURUM แน่นอน
ไม่ต้องพึ่ง TradingView แนบรูป (งานนี้อยู่นอก scope PR #28 — เป็น follow-up)

> Handler ใน PR นี้ออกแบบให้ **agnostic ต่อแหล่งที่มาของ URL**: ไม่ว่า chart มา
> จากตัวเลือก A หรือ B ขอแค่เป็น URL `http(s)` ที่ถูกต้อง /room ก็แสดงได้

---

## STEP 2 — แก้ Pine V.2 script (`gold_panel_v2.pine`)

เพิ่มในส่วนล่างของ script (ก่อน export / ท้ายไฟล์):

```pinescript
// === AURUM Briefing alerts (09:00 / 14:00 / 20:00 Asia/Bangkok) ===
inMorningBriefing   = hour(time_close, "Asia/Bangkok") == 9  and minute(time_close, "Asia/Bangkok") == 0
inAfternoonBriefing = hour(time_close, "Asia/Bangkok") == 14 and minute(time_close, "Asia/Bangkok") == 0
inEveningBriefing   = hour(time_close, "Asia/Bangkok") == 20 and minute(time_close, "Asia/Bangkok") == 0

alertcondition(inMorningBriefing and barstate.isconfirmed,
  title="AURUM Briefing เช้า",
  message='{"type":"briefing_webhook","slot":"morning","symbol":"{{ticker}}","timeframe":"{{interval}}","price":{{close}}}')

alertcondition(inAfternoonBriefing and barstate.isconfirmed,
  title="AURUM Briefing บ่าย",
  message='{"type":"briefing_webhook","slot":"afternoon","symbol":"{{ticker}}","timeframe":"{{interval}}","price":{{close}}}')

alertcondition(inEveningBriefing and barstate.isconfirmed,
  title="AURUM Briefing ค่ำ",
  message='{"type":"briefing_webhook","slot":"evening","symbol":"{{ticker}}","timeframe":"{{interval}}","price":{{close}}}')
```

> หมายเหตุ: ตัวอย่างนี้ **ตัด** `"chart_image_url":"{{chart}}"` ออกแล้ว เพราะ
> TradingView ไม่แทนค่าให้ (ดูหัวข้อ ⚠️) — briefing จะมาพร้อมข้อความวิเคราะห์
> ไทยจาก Claude เสมอ ส่วน chart ค่อยเติมตามตัวเลือก A/B ด้านบน ถ้าภายหลังยืนยัน
> ว่า TradingView ส่ง URL รูปมาใน field ไหน ก็เพิ่ม `"chart_image_url":"..."`
> เข้าไปได้

⚠️ ต้องเป็น chart **M15** เพราะ `barstate.isconfirmed` + เงื่อนไขนาที == 0 จะตรง
เฉพาะตอนแท่ง M15 ปิดที่ 09:00/14:00/20:00 พอดี (ถ้าใช้ timeframe อื่นที่ไม่ปิด
ตรงนาทีนั้น alert จะไม่ยิง)

---

## STEP 3 — ตั้ง 3 TradingView alerts (Por ทำเอง)

ทำซ้ำ 3 รอบ สำหรับแต่ละ slot (เช้า / บ่าย / ค่ำ):

1. เปิด chart **XAUUSD · M15** ที่มี Pine V.2 (`gold_panel_v2`) loaded
2. Right-click บน chart → **Add Alert** (หรือกดปุ่มนาฬิกา → Create Alert)
3. **Condition**: เลือก indicator `AURUM Gold Panel V.2` → เลือกเงื่อนไข
   **"AURUM Briefing เช้า"** (หรือ บ่าย / ค่ำ)
4. **Trigger**: `Once Per Bar Close`
5. **Expiration**: `Open-ended` (ไม่หมดอายุ)
6. **Notifications → Webhook URL**:
   ```
   https://etwlurpjrqlvrxgsbhkd.supabase.co/functions/v1/scheduled-analyzer
   ```
7. ✅ เปิด **"Send WebHook"**
8. ✅ เปิด **"Include chart screenshot in alert"** (เผื่อใช้ตัวเลือก A — ดู ⚠️)
9. **Message**: ใช้ค่า default จาก `alertcondition` (ไม่ต้องแก้)
10. **Save**

---

## STEP 4 — ทดสอบ (ก่อน disable cron)

### 4.1 Manual test (ยืนยัน handler รับ webhook + เขียน chart_image_url)

รันใน Supabase SQL editor:

```sql
SELECT net.http_post(
  url     := 'https://etwlurpjrqlvrxgsbhkd.supabase.co/functions/v1/scheduled-analyzer',
  headers := '{"Content-Type":"application/json"}'::jsonb,
  body    := '{"type":"briefing_webhook","slot":"morning","symbol":"XAUUSD","timeframe":"15","price":4317.5,"chart_image_url":"https://etwlurpjrqlvrxgsbhkd.supabase.co/storage/v1/object/public/charts/test.png"}'::jsonb
);
```

ตรวจผล:

```sql
SELECT id, source, schedule_slot, left(chart_image_url, 60) AS chart, created_at
FROM analysis_posts
WHERE source='ai_scheduled'
ORDER BY created_at DESC LIMIT 3;
```

→ ต้องเห็นแถวใหม่ `source='ai_scheduled'`, `schedule_slot='morning'`,
`chart_image_url` = URL ที่ส่งไป

> ถ้ายิง slot เดิมซ้ำในวันเดียวกัน handler จะตอบ `skipped:
> already_posted_today` (idempotency) — ลบแถว test ก่อนถ้าจะทดสอบใหม่ slot เดิม

### 4.2 ทดสอบ 1 alert จริงทันที

ตั้ง alert ทดสอบ 1 ตัวให้เงื่อนไขยิงใน 1–2 นาที (เช่นแก้ชั่วคราวเป็นนาที
ปัจจุบัน) → เปิด `/room` → คลิก briefing → ต้องเห็น chart image (ถ้า URL จริง =
AURUM chart)

---

## STEP 5 — Disable cron (หลัง TradingView alerts ยืนยันว่าทำงาน)

```sql
SELECT cron.unschedule('scheduled_analyzer_morning');
SELECT cron.unschedule('scheduled_analyzer_afternoon');
SELECT cron.unschedule('scheduled_analyzer_evening');
```

หรือ **เก็บ cron ไว้เป็น fallback** ก็ได้ — `idempotency` กัน duplicate อยู่แล้ว
(ใครยิงก่อนชนะ slot/วันนั้น) ข้อแลกเปลี่ยน: ถ้า cron ยิงก่อน webhook ในวันนั้น
briefing จะ **ไม่มี chart** (cron ไม่พก chart) แล้ว webhook ตามมาจะถูก skip
→ แนะนำตั้งเวลา cron ให้ช้ากว่า alert เล็กน้อย หรือ disable ถ้าต้องการ chart
ทุกครั้ง

---

## สรุป behaviour ของ scheduled-analyzer v4

| invocation | body | chart_image_url ที่บันทึก |
|---|---|---|
| cron | `{"slot":"morning"}` | `NULL` → /room แสดง "รอข้อมูลแท่งเทียน" |
| webhook | `{"type":"briefing_webhook","slot":"morning","chart_image_url":"https://..."}` | URL นั้น → /room แสดง `<img>` |
| webhook (URL ไม่ใช่ http) | `..."chart_image_url":"{{chart}}"` | `NULL` (degrade ปลอดภัย) |

ทั้งสอง path เรียก Claude (Sonnet 4.5) เขียน briefing ไทยด้วย logic เดียวกัน
ผ่าน banned-vocab guard เหมือนเดิม ต่างกันแค่ `chart_image_url`
