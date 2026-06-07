# Phase 4 — Gold Panel rendering in `/room` (Design Plan)

> **Status:** Design only — no implementation in this document.
> **Goal:** Bring the *Gold Panel V.1* TradingView indicator's visual language into the
> Aurum Analysis room (`room.html`), rendered on the existing TradingView **Lightweight
> Charts** instance.
> **Sources read:** `room.html` (current `/room`, Variant C — Pro Dashboard) and
> `docs/reference/gold_panel_v1.pine` (Gold Panel V.1 indicator).

## Context recap

The room already runs Lightweight Charts 4.2.0 (`room.html:447`) with:

- a candlestick series (`candleSeries`) and one line series (`ema9Series`),
- per-symbol price precision (`PRICE_FMT`, `room.html:461`),
- overlay helpers `addPriceLine()` / `clearOverlays()` (`room.html:727`),
- a single direction marker via `setMarkers()` (`room.html:759`),
- candles fed from `window.MOCK_CANDLES` (`js/mock-candles.js`), Phase 3 swaps in real candles,
- a realtime contract on `analysis_posts` (`sql/2026_06_06_analysis_posts.sql`) with
  `handleInsert` / `handleConfirm` hooks (`room.html:983`).

This is the substrate Phase 4 extends. Nothing below requires re-creating the chart;
every feature is either a new series, a new marker batch, a new price line, or a new
canvas overlay layered on the existing `chart`.

---

## 1. Feature Inventory

Every visual feature emitted by Gold Panel V.1, with its Pine source location.

| # | Feature | Pine V.1 lines | What it does |
|---|---------|----------------|--------------|
| F1 | **21 SMMA** (white) | `4–13` | Smoothed MA, length 21 on close. Seeded by SMA(21), then `smma := (smma[1]*(len-1)+src)/len`. Plotted white, width 2. |
| F2 | **50 SMMA** (green `#6aff00`) | `15–22` | Same SMMA recurrence, length 50. |
| F3 | **100 SMMA** (yellow) | `24–32` | Length 100, toggle `h100` (default on). |
| F4 | **200 SMMA** (red `#ff0500`) | `34–41` | Length 200. Also the trend reference line for F5 + F11. |
| F5 | **Trend Fill** | `43–49` | `ema2 = ta.ema(close, 2)`. Fills the band between EMA(2) and the 200 SMMA — **green** when `ema2 > smma200`, **red** when below, transparency 85. Pure trend-direction shading. |
| F6 | **3-Line Strike — Bullish** | `53–61` | `close[3]<open[3] && close[2]<open[2] && close[1]<open[1] && close>open[1]` → green up-triangle below bar, text `3s-Bull`. |
| F7 | **3-Line Strike — Bearish** | `53–62` | Three up candles then a down close below `open[1]` → red down-triangle above bar, text `3s-Bear`. |
| F8 | **Bullish Engulfing** ("Big A$$ Candle") | `66–84` | `open<=close[1] && open<open[1] && close>open[1]` → green up-triangle below bar (tiny). |
| F9 | **Bearish Engulfing** | `66–85` | `open>=close[1] && open>open[1] && close<open[1]` → red down-triangle above bar (tiny). |
| F10 | **Trading Session highlight** | `95–172` | Two intraday windows (an "analysis" window from `startHour:startMinute`, and a "session" window `08:30–12:00` CME default), drawn as `bgcolor` shading on bars inside the window, per-weekday toggles, timezone-aware (default `America/Chicago`). |
| F11 | **Bull UP / Bear Down label** | `635–641` | A single floating label at the last bar: `▲ Bull UP` (green) when `close > smma200`, else `Bear Down ▼` (red). Updates on every bar (deletes the previous one). |
| F12 | **MTF Supply & Demand zones** | `179–631` | Multi-timeframe demand (bullish) and supply (bearish) **boxes**. Pivots are detected via `request.security` on TF1 (default 2H) and TF2 (default 30Min) using `ta.pivothigh/low` + `ta.atr(200)`. Zones are drawn as colored boxes (top/bottom/left/right), mitigated (removed) once price closes through them, and only the last N per side are shown. |
| F13 | *(alerts, not visual)* | `87–91`, `508–533` | `alertcondition` / `alert()` messages. **Not a chart visual** — these map to the room's existing toast/notification path, listed here only for completeness. |

> **Note on F10 timezone & session times:** the Pine session windows are authored around
> CME/Chicago hours. The room serves a Thai audience (`lang="th"`). Whether to keep
> Chicago, convert to `Asia/Bangkok`, or make it configurable is an **open question (§7)**.

---

## 2. Architecture Split — Client vs Server

The dividing line: **anything computable from the OHLC candles the room already holds is
client-side.** Anything that depends on *realtime detection state*, *higher-timeframe
`request.security` lookups*, or the *non-repaint confirmation contract* must come from the
server (Pine V.3 webhook → Supabase → room subscribe).

### A. Client-side compute (in `room.html` JS, from existing candles)

These need only `window.MOCK_CANDLES[symbol]` (Phase 3: real candles) and recompute on each
`updateChart(p)` call. They are deterministic functions of the visible series — exactly like
the existing `computeEMA()` (`room.html:721`).

| Feature | Formula | Lightweight Charts API |
|---------|---------|------------------------|
| **F1–F4 SMMA 21/50/100/200** | Seed `smma = SMA(len)` over first `len` closes, then iterate `smma = (smma*(len-1) + close)/len`. (SMMA = Wilder's RMA.) | One `addLineSeries()` per MA (4 series), `series.setData([{time, value}])`. Reuse the `ema9Series` pattern. |
| **F5 Trend Fill** | Compute `ema2 = EMA(close, 2)` and `smma200`. Sign of `(ema2 - smma200)` per bar → green/red band. | **No native fill-between-series in v4.** Either (a) a `LineSeries` with per-point area coloring is *not* supported, so use a **custom canvas overlay** (semi-transparent polygon between the two lines), or (b) approximate with `addBaselineSeries()` using `smma200` as the baseline and `ema2` as the value (baseline series shades above/below a price). Option (b) is the cheap path; see §4. |
| **F6/F7 3-Line Strike** | Pattern over `close/open[0..3]` (see F6/F7 rows in §1). Evaluate per closed candle. | `candleSeries.setMarkers([...])` — append to the existing marker array. Triangles up/down. |
| **F8/F9 Engulfing** | Pattern over current vs previous candle (see §1). | `setMarkers([...])` — same batch as F6/F7. |
| **F10 Trading Session highlight** | For each candle `time`, convert to the configured timezone, test weekday + hour:minute window membership. | **No native bar background in v4.** Use a **custom canvas overlay** keyed off `timeScale().timeToCoordinate()` to paint vertical bands, OR (cheap approximation) a series of `setMarkers` is *not* suitable. Realistically this is a custom primitive — see §4 / §5. |
| **F11 Bull UP / Bear Down label** | `close_last > smma200_last ? bull : bear`. Pure function of the last candle + F4. | Could be a chart marker at the last bar via `setMarkers`, but cleaner as a **DOM badge** in the existing detail panel (it's one label, not per-bar). Recommend DOM. |

**Why these are client-side:** they are stateless transforms of candles the browser already
renders. Computing them server-side would mean shipping a parallel candle pipeline and
re-deriving values the client can produce for free — and they don't carry the non-repaint
risk that patterns/zones do (the client only ever draws them on **closed** candles it holds).

> **Caveat — repaint on the *forming* candle:** F6–F9 patterns and F11 must be evaluated on
> **closed** candles only, mirroring Pine's bar-close semantics. The client must skip the
> last (still-forming) candle when it is live, otherwise a marker can flicker/disappear —
> the same repaint trap the `analysis_posts.confirmed` contract guards against. See §7.

### B. Server-delivered (Pine V.3 webhook → Supabase `analysis_posts` → room subscribe)

These cannot be faithfully reproduced from the room's candle array, because they depend on
**TradingView-side realtime detection** and **multi-timeframe `request.security`** that the
browser does not have.

| Feature | Why it must be server-delivered |
|---------|-------------------------------|
| **F12 MTF Supply & Demand zones** | Pivots are pulled from *higher timeframes* via `request.security` with `ta.pivothigh/low` and `ta.atr(200)` (`pine:409–423`). The room only holds the chart-timeframe candles for one symbol, not the 2H/30Min pivot history, and re-deriving HTF pivots + ATR + mitigation client-side would diverge from what the trader sees in TradingView. Ship the resolved zone rectangles (top/bottom/left-time/side/timeframe-label/mitigated) as data. |
| **F6–F9 patterns — *authoritative* copy** | Although the client *can* compute these (Group A), the **source of truth** the trader acts on is Pine's realtime detection at bar close. To keep room markers byte-for-byte consistent with the indicator and to honor the non-repaint contract, the **confirmed** pattern hits should also arrive from the webhook. **Recommended hybrid:** client computes for instant/preview rendering; server-delivered `pattern_markers` overwrite/confirm them on bar close (same false→true flip as `confirmed`). |

**New fields required on `analysis_posts`** (full DDL in §3):

- `pattern_markers jsonb` — array of `{ kind, time, side }` for F6–F9.
- `sd_zones jsonb` — array of `{ side, top, bottom, left_time, tf_label, mitigated }` for F12.
- `smma_snapshot jsonb` *(optional)* — only if we decide MAs must match Pine exactly rather
  than be recomputed client-side; default plan is **client-side**, so this is optional.

**JSON shapes** (see §3 for the canonical versions):

```jsonc
// pattern_markers
[
  { "kind": "3ls_bull",   "time": 1749208500, "side": "bull" },
  { "kind": "engulf_bear","time": 1749210300, "side": "bear" }
]

// sd_zones
[
  { "side": "demand", "top": 4462.6, "bottom": 4456.7,
    "left_time": 1749200000, "tf_label": "2H",   "mitigated": false },
  { "side": "supply", "top": 4490.0, "bottom": 4486.3,
    "left_time": 1749150000, "tf_label": "30Min","mitigated": false }
]
```

---

## 3. Schema Additions Required

Additive, nullable, backward-compatible — existing rows and the existing room keep working
without these columns populated. Target table: `public.analysis_posts` (aurum-customers).

```sql
-- Phase 4 — Gold Panel visuals. All additive + nullable (fail-safe: a row with
-- NULL/absent values renders exactly like today).

alter table public.analysis_posts
  add column if not exists pattern_markers jsonb not null default '[]'::jsonb,
  add column if not exists sd_zones        jsonb not null default '[]'::jsonb,
  add column if not exists smma_snapshot   jsonb;          -- optional, nullable

comment on column public.analysis_posts.pattern_markers is
  'Gold Panel pattern hits on closed bars: [{kind, time, side}]. '
  'kind ∈ 3ls_bull|3ls_bear|engulf_bull|engulf_bear; time = UNIX seconds; side = bull|bear.';

comment on column public.analysis_posts.sd_zones is
  'MTF supply/demand zones: [{side, top, bottom, left_time, tf_label, mitigated}]. '
  'side = demand|supply; top/bottom = numeric price; left_time = UNIX seconds; '
  'tf_label e.g. "2H"/"30Min"; mitigated = bool (true once price closed through).';

comment on column public.analysis_posts.smma_snapshot is
  'OPTIONAL. Only if MAs must match Pine exactly: {"21":[{time,value}],"50":[...],...}. '
  'Default plan computes SMMA client-side; leave NULL unless that decision changes.';
```

### Column summary

| Column | Type | Nullable | Default | Notes |
|--------|------|----------|---------|-------|
| `pattern_markers` | `jsonb` | no | `'[]'` | F6–F9 confirmed hits |
| `sd_zones` | `jsonb` | no | `'[]'` | F12 zones |
| `smma_snapshot` | `jsonb` | yes | `NULL` | optional, only if server-authoritative MAs |

### `jsonb` shapes (canonical)

```jsonc
// pattern_markers — each entry corresponds to one Pine plotshape() hit on a CLOSED bar
{
  "kind": "3ls_bull",       // "3ls_bull" | "3ls_bear" | "engulf_bull" | "engulf_bear"
  "time": 1749208500,        // UNIX seconds, the candle the pattern completed on
  "side": "bull"             // "bull" | "bear"  (drives marker color/position)
}

// sd_zones — each entry is one box from the MTF S&D engine
{
  "side": "demand",          // "demand" (bullish) | "supply" (bearish)
  "top": 4462.60,            // numeric, zone upper bound
  "bottom": 4456.70,         // numeric, zone lower bound
  "left_time": 1749200000,   // UNIX seconds, box left edge (zone origin)
  "tf_label": "2H",          // source timeframe shorthand (Pine TF_Display)
  "mitigated": false         // true once price closed through → client hides it
}

// smma_snapshot — OPTIONAL, only if §7 decides server-authoritative MAs
{
  "21":  [{ "time": 1749208500, "value": 4467.21 }, /* ... */ ],
  "50":  [/* ... */],
  "100": [/* ... */],
  "200": [/* ... */]
}
```

> **Realtime note:** `analysis_posts` already has `replica identity full`
> (`sql/2026_06_06_analysis_posts.sql`), so UPDATEs that flip `sd_zones[*].mitigated` or
> append confirmed `pattern_markers` emit full payloads — the room can diff them the same
> way it diffs `confirmed` false→true today. No publication change needed.

---

## 4. Lightweight Charts API Mapping

Lightweight Charts v4.2.0 (`room.html:447`). Key constraint: **v4 has no native "box"
drawing and no native fill-between-two-series or bar-background.** Those require either the
v4 **Series Primitives / custom series** API or a hand-rolled **canvas overlay** positioned
with `timeScale().timeToCoordinate()` + `series.priceToCoordinate()`.

| Feature | API / approach | Limitation / note |
|---------|----------------|-------------------|
| **F1–F4 SMMA** | `chart.addLineSeries({ color, lineWidth })` ×4 + `setData()` | Native, trivial. Mirror `ema9Series` (`room.html:697`). 4 extra series is fine. Add per-line visibility toggles. |
| **F5 Trend Fill** | **Preferred:** `chart.addBaselineSeries({ baseValue:{type:'price', price: <smma200>}, topFillColor1/2, bottomFillColor1/2 })` driven by `ema2`. **Fallback:** custom canvas overlay polygon between the two line series. | Baseline shades value-above vs value-below a single baseline price — but the Pine fill is between **two moving curves** (ema2 vs smma200), and a baseline takes only a **scalar** baseValue. So baseline is an *approximation* (good enough visually); an exact fill needs a **custom canvas overlay**. Flagged §7. |
| **F6–F9 Pattern markers** | `candleSeries.setMarkers([{ time, position:'aboveBar'|'belowBar', shape:'arrowUp'|'arrowDown', color, text }])` | Native (already used at `room.html:759`). **Caveat:** `setMarkers` **replaces** the whole array — the existing direction marker (§ `updateChart`) and all pattern markers must be merged into **one** array and set together. Lightweight Charts auto-stacks markers on the same bar. |
| **F10 Trading Session highlight** | **Custom canvas overlay** (absolutely-positioned `<canvas>` over the chart container) painting vertical bands; X from `timeScale().timeToCoordinate(time)`, redraw on `timeScale().subscribeVisibleTimeRangeChange()` + resize. | **No native bar background in v4.** This is the heaviest item. A v4 *Series Primitive* could also do it but the canvas overlay is more self-contained. |
| **F11 Bull UP / Bear Down label** | **DOM badge** in the detail panel (not a chart primitive). | Single label, not per-bar. Could be a last-bar marker but DOM is cleaner and avoids fighting the marker array. |
| **F12 S&D zones (boxes)** | **Custom canvas overlay** drawing rectangles: X from `timeToCoordinate(left_time)`→right edge, Y from `priceToCoordinate(top)`/`priceToCoordinate(bottom)`. Demand/supply fill + border + `tf_label` text. | **No native box/rectangle in v4.** Same overlay machinery as F10 — build once, reuse. `createPriceLine` can NOT express a bounded rectangle (it's a full-width horizontal line), so it's unsuitable here. Alternatively a lightweight zone could degrade to **two `createPriceLine`s** (top+bottom) as an MVP before the canvas overlay exists. |

### Reusable overlay primitive

F5 (fallback), F10, and F12 all want the same thing: **a transparent `<canvas>` pinned over
the chart, redrawn on pan/zoom/resize, using `timeToCoordinate` + `priceToCoordinate`.**
Build **one** `OverlayCanvas` helper and let the three features register draw callbacks. This
is the single biggest engineering decision in Phase 4 and the main source of the L estimates
below.

### Series/marker budget

- New line series: 4 (SMMA) + optional 1 (baseline trend fill) = up to 5.
- Markers: merge F6–F9 + existing direction marker into one `setMarkers` array.
- Canvas overlay: 1 shared layer serving F10 + F12 (+ F5 fallback).

---

## 5. Effort Estimate

Sizing: **S = 1–2h, M = 3–5h, L = 6h+.** Dependencies noted.

| Feature | Size | Dependency / rationale |
|---------|------|------------------------|
| F1–F4 SMMA (4 lines) | **M** | Pure client compute + 4 series + toggles. No deps. The SMMA seeding/recurrence + per-line UI is the only fiddly part. |
| F11 Bull UP / Bear Down label | **S** | Depends on F4 (needs smma200). Trivial once F4 lands — one DOM badge. |
| F6–F9 Pattern markers (client preview) | **M** | Pattern math + merge into the single `setMarkers` array + closed-bar guard. No schema dep for the *preview* copy. |
| F6–F9 Pattern markers (server-authoritative) | **M** | **Depends on Schema §3 `pattern_markers`** + Pine V.3 webhook emitting them + room subscribe mapping. |
| F5 Trend Fill (baseline approximation) | **M** | Depends on F4. Baseline series is quick; matching Pine's exact 2-curve fill is what pushes it from S→M. |
| F5 Trend Fill (exact, canvas) | **L** | Depends on the shared OverlayCanvas primitive. |
| F10 Trading Session highlight | **L** | Needs the OverlayCanvas primitive + timezone/session config + redraw-on-pan wiring. Heaviest pure-client item. |
| F12 MTF S&D zones | **L** | **Depends on Schema §3 `sd_zones`** + Pine V.3 webhook + OverlayCanvas primitive. Two-system change (backend emit + frontend draw). MVP degrade to top/bottom `createPriceLine`s = **M**. |
| Shared `OverlayCanvas` primitive | **L** | Foundational. F10, F12, and exact-F5 all block on it. Worth costing separately so it isn't double-counted. |

---

## 6. Recommended Implementation Order

Ordered by **low risk → high value → unblock-dependents**, front-loading wins that need no
schema/backend change and deferring the canvas-overlay-heavy work.

1. **F1–F4 SMMA + F11 label** *(M+S, no deps).*
   Highest value-per-risk. Pure client compute on candles already in the room, mirrors the
   existing `computeEMA`/`ema9Series` pattern, ships visible Gold-Panel identity immediately,
   and unblocks F5 and F11 (both need smma200). Zero backend/schema work, zero repaint risk
   (MAs are continuous, not event markers).

2. **F6–F9 Pattern markers — client preview** *(M, no deps).*
   Reuses the existing `setMarkers` path. Big perceived value (the arrows are the indicator's
   signature) for moderate effort. Implement the **closed-bar guard** here so the pattern
   never draws on the forming candle — this establishes the repaint discipline reused later.

3. **Schema §3 migration** *(S, additive/nullable).*
   Land `pattern_markers` + `sd_zones` early so backend (Pine V.3 → webhook) and frontend can
   proceed in parallel. Additive + nullable ⇒ deploy anytime with zero risk to the live room.

4. **F6–F9 Pattern markers — server-authoritative** *(M, depends on #3).*
   Upgrade the preview from #2 to the confirmed copy delivered by the webhook, flipping
   client-computed markers to server-confirmed on bar close (same non-repaint pattern as
   `analysis_posts.confirmed`). Now the room matches TradingView exactly.

5. **Shared `OverlayCanvas` primitive** *(L, foundational).*
   The gate for F10, F12, and exact-F5. Build and test it in isolation (draw one dummy rect
   that survives pan/zoom/resize) before wiring real features. Highest technical risk — do it
   deliberately, after the easy wins are already delivering value.

6. **F12 MTF S&D zones** *(L, depends on #3 + #5).*
   Highest *analytical* value (zones are what traders act on) but highest combined risk
   (backend emit + canvas draw + mitigation lifecycle). Optionally ship an **MVP via two
   `createPriceLine`s** (top/bottom) right after #3 to deliver value before the canvas exists,
   then upgrade to real boxes once #5 lands.

7. **F5 Trend Fill** *(M baseline / L exact).*
   Cosmetic polish, lowest urgency. Start with the `addBaselineSeries` approximation (no
   dependency on #5); upgrade to the exact canvas fill only if the founder wants pixel parity.

8. **F10 Trading Session highlight** *(L, depends on #5).*
   Deferred last: depends on the canvas primitive **and** carries the unresolved
   timezone/session-hours question (§7). Lowest value for a Thai audience until the session
   semantics are confirmed.

**One-line summary:** MAs + label → pattern markers (preview) → schema → patterns (confirmed)
→ overlay primitive → S&D zones → trend fill → session highlight.

---

## 7. Open Questions (confirm with founder before implementing)

1. **F10 session timezone & hours.** Pine defaults to `America/Chicago` and CME hours
   (`08:30–12:00`, `pine:99–108`). The room is Thai (`lang="th"`). Keep Chicago, convert to
   `Asia/Bangkok`, or make it user-configurable? This blocks F10 and affects its value.

2. **Patterns: client-computed vs server-authoritative (or hybrid)?** §2 recommends the
   hybrid (client preview, server confirms). Confirm the founder wants the webhook to be the
   source of truth — that decides whether Pine V.3 must emit `pattern_markers` at all, and
   whether #4 in §6 happens.

3. **SMMA: recompute client-side, or ship `smma_snapshot`?** Default plan recomputes
   client-side (cheaper, no schema cost). But the room's candles are currently **mock**
   (`js/mock-candles.js`) and Phase 3 may use a *different* candle source than TradingView —
   if the candles don't match TradingView's, the MAs won't either. Confirm Phase 3's candle
   source is faithful enough, or decide we need `smma_snapshot`.

4. **F5 Trend Fill fidelity.** Acceptable to ship the `addBaselineSeries` approximation
   (shades vs a scalar baseline) instead of the exact between-two-curves fill? Exact parity
   forces the L-sized canvas path.

5. **How many S&D timeframes?** Pine ships **two** active TFs (2H + 30Min; TF3 is commented
   out, `pine:424–425`). Render both in the room, or just the one matching the post's
   timeframe? Affects `sd_zones` payload size and visual density.

6. **Zone lifecycle in the room.** When `sd_zones[*].mitigated` flips true via realtime
   UPDATE, should the room **remove** the box (Pine's behavior) or **fade/strike** it to show
   history? Pine deletes; the room might prefer to keep context.

7. **Candle history depth.** F4 (200 SMMA) needs ≥200 candles to seed; `mock-candles.js`
   generates **120** (`js/mock-candles.js:35`). The 100/200 MAs will be short or empty on the
   current preview data. Confirm Phase 3 delivers ≥200 candles, or accept that 100/200 SMMA
   render partially until then.

8. **Performance budget on mobile.** A custom canvas overlay redrawing on every pan/zoom,
   plus 5 extra series, on the existing mobile-tuned chart (`handleScroll`/`handleScale`
   gated for mobile, `room.html:671`). Confirm the target device floor so we can decide
   whether to throttle overlay redraws.

---

*End of Phase 4 design plan. No implementation code is included by design — this document is
the input to the Phase 4 build.*
