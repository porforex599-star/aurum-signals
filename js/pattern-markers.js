/* ============================================================================
 * Gold Panel pattern markers (F6–F9) — client-side preview detection.
 *
 * Mirrors the Gold Panel V.1 indicator (docs/reference/gold_panel_v1.pine):
 *   F6 — 3-Line Strike Bullish   (Pine V.1 lines 53–61)
 *   F7 — 3-Line Strike Bearish   (Pine V.1 lines 53–62)
 *   F8 — Bullish Engulfing       (Pine V.1 lines 66–78)
 *   F9 — Bearish Engulfing       (Pine V.1 lines 66–85)
 *
 * Detection is DELIBERATELY split out from rendering. The room draws whatever
 * array this returns; the array can later be replaced wholesale with no change
 * to the draw code:
 *   future hybrid: Pine V.3 webhook will deliver authoritative pattern_markers
 *   that overwrite client-detected on bar close (Phase 4 Step 4, per design
 *   doc §6). The webhook is the source of truth; this client compute exists
 *   only to remove perceived latency (design doc §2B / §7 D1).
 *
 * Non-repaint contract (design doc §2 caveat): patterns must only ever be
 * evaluated on CLOSED candles, never the still-forming bar — otherwise a
 * marker can flicker/disappear. `candles` is therefore expected to contain
 * closed candles only (the mock feed has no forming bar; the Phase 3 real feed
 * must pass closed candles here, same contract as computeSMMA).
 *
 * Returns an array of Lightweight Charts marker objects, each tagged with a
 * `kind` (3ls_bull|3ls_bear|engulf_bull|engulf_bear — matches the canonical
 * jsonb shape in design doc §3) so toggle chips can filter by family. The
 * `kind` field is ignored by Lightweight Charts' setMarkers().
 * ========================================================================== */
(function (root) {
  'use strict';

  /* Pine bar offsets map directly onto array indices: at bar i,
       close  == candles[i],     close[1] == candles[i-1],
       close[2] == candles[i-2], close[3] == candles[i-3].
     The 3-Line Strike looks back 4 bars, so detection starts at i = 3.
     Fewer than 4 candles → nothing can match. */
  function detectPatterns(candles) {
    const markers = [];
    if (!candles || candles.length < 4) return markers;

    for (let i = 3; i < candles.length; i++) {
      const c0 = candles[i];      // close      / open
      const c1 = candles[i - 1];  // close[1]   / open[1]
      const c2 = candles[i - 2];  // close[2]
      const c3 = candles[i - 3];  // close[3]

      /* F6/F7 — 3-Line Strike. Bull and bear are mutually exclusive on one
         bar (a bar cannot satisfy both). */
      if (c3.close < c3.open && c2.close < c2.open && c1.close < c1.open && c0.close > c1.open) {
        // F6 — 3-Line Strike Bullish: three down candles, then close above open[1].
        markers.push({
          kind: '3ls_bull', time: c0.time,
          position: 'belowBar', shape: 'arrowUp', color: '#22c55e', text: '3s-Bull', size: 2,
        });
      } else if (c3.close > c3.open && c2.close > c2.open && c1.close > c1.open && c0.close < c1.open) {
        // F7 — 3-Line Strike Bearish: three up candles, then close below open[1].
        markers.push({
          kind: '3ls_bear', time: c0.time,
          position: 'aboveBar', shape: 'arrowDown', color: '#ef4444', text: '3s-Bear', size: 2,
        });
      }

      /* F8/F9 — Engulfing ("Big A$$ Candle"). Evaluated INDEPENDENTLY of the
         3-Line Strike above (Pine emits separate plotshapes, so a bar can carry
         both a 3LS and an engulfing marker — Lightweight Charts auto-stacks
         them). Bull/bear are mutually exclusive on one bar. */
      if (c0.open <= c1.close && c0.open < c1.open && c0.close > c1.open) {
        // F8 — Bullish Engulfing (tiny, no text).
        markers.push({
          kind: 'engulf_bull', time: c0.time,
          position: 'belowBar', shape: 'arrowUp', color: '#22c55e', size: 1,
        });
      } else if (c0.open >= c1.close && c0.open > c1.open && c0.close < c1.open) {
        // F9 — Bearish Engulfing (tiny, no text).
        markers.push({
          kind: 'engulf_bear', time: c0.time,
          position: 'aboveBar', shape: 'arrowDown', color: '#ef4444', size: 1,
        });
      }
    }
    return markers;
  }

  // Expose to the browser (window) and to Node (unit tests) without a bundler.
  root.detectPatterns = detectPatterns;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { detectPatterns };
  }
})(typeof window !== 'undefined' ? window : globalThis);
