/* ============================================================================
 * Mock OHLC candles for the Aurum Analysis room (Phase 2.5).
 *
 * Deterministic, seeded random walks — ~300 M15 candles per symbol. Each
 * candle opens at the previous close (no impossible gaps), with ~0.3% per-step
 * movement. Times are UNIX seconds (intraday resolution required by
 * TradingView Lightweight Charts).
 *
 * Exposes:
 *   window.MOCK_CANDLES       = { SYMBOL: [{ time, open, high, low, close }, ...] }
 *   window.MOCK_CANDLES_META  = { stepMin, count, endUnix }
 *
 * Phase 3 replaces this file with real candles from the aurum-ai-engine
 * candles endpoint OR the Polygon.io REST API (decision in the Phase 3 brief).
 * The room consumes window.MOCK_CANDLES, so the swap is drop-in.
 * ========================================================================== */
(function () {
  // Small seeded PRNG (mulberry32) — deterministic output per symbol so the
  // preview is stable across reloads.
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function seedFor(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  var COUNT = 300; // bumped from 120 (Decision D7) — seed SMMA 200 fully in preview
  var STEP_MIN = 15;
  var STEP = STEP_MIN * 60;
  // Fixed recent anchor so candle times are deterministic for the preview.
  var END = Math.floor(Date.UTC(2026, 5, 6, 12, 0, 0) / 1000); // 2026-06-06T12:00:00Z

  // base price · per-step movement (~0.3%) · rounding decimals
  var CFG = {
    XAUUSD: { base: 4456,   vol: 0.0030, dp: 2 }, // ~4400–4500
    EURUSD: { base: 1.1550, vol: 0.0016, dp: 5 }, // ~1.15–1.16
    BTCUSD: { base: 97000,  vol: 0.0040, dp: 0 }, // ~95000–100000
    NAS100: { base: 21300,  vol: 0.0028, dp: 1 }, // ~21000–21500
    SP500:  { base: 5825,   vol: 0.0022, dp: 1 }, // ~5800–5850
  };

  function round(n, dp) { var f = Math.pow(10, dp); return Math.round(n * f) / f; }

  function generate(symbol) {
    var cfg = CFG[symbol];
    var rng = mulberry32(seedFor(symbol));
    var start = END - (COUNT - 1) * STEP;
    var price = cfg.base;
    var out = [];
    for (var i = 0; i < COUNT; i++) {
      var time = start + i * STEP;
      var open = price;
      var drift = (rng() - 0.5) * 2 * cfg.vol * price;        // within ±vol
      var close = open + drift;
      var high = Math.max(open, close) + rng() * cfg.vol * price * 0.6;
      var low  = Math.min(open, close) - rng() * cfg.vol * price * 0.6;
      out.push({
        time: time,
        open: round(open, cfg.dp),
        high: round(high, cfg.dp),
        low: round(low, cfg.dp),
        close: round(close, cfg.dp),
      });
      price = close; // next candle opens where this one closed — no gaps
    }
    return out;
  }

  var data = {};
  Object.keys(CFG).forEach(function (sym) { data[sym] = generate(sym); });

  window.MOCK_CANDLES = data;
  window.MOCK_CANDLES_META = { stepMin: STEP_MIN, count: COUNT, endUnix: END };
})();
