/* ============================================================================
 * Unit tests for detectPatterns (js/pattern-markers.js) — F6–F9.
 *
 * Hand-built candle fixtures whose open/close relationships reproduce the
 * Gold Panel V.1 Pine conditions (docs/reference/gold_panel_v1.pine):
 *   F6 3ls_bull  : close[3]<open[3] && close[2]<open[2] && close[1]<open[1] && close>open[1]
 *   F7 3ls_bear  : close[3]>open[3] && close[2]>open[2] && close[1]>open[1] && close<open[1]
 *   F8 engulf_bull: open<=close[1] && open<open[1] && close>open[1]
 *   F9 engulf_bear: open>=close[1] && open>open[1] && close<open[1]
 *
 * No test framework — plain `node test/pattern-markers.test.js`. Exits non-zero
 * on the first failed assertion.
 * ========================================================================== */
'use strict';
const assert = require('assert');
const { detectPatterns } = require('../js/pattern-markers.js');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log('  ✓ ' + name);
}

// Helper: a candle. high/low are unused by detection but kept realistic.
function bar(time, open, close) {
  return { time, open, high: Math.max(open, close) + 1, low: Math.min(open, close) - 1, close };
}
function kinds(markers) { return markers.map(m => m.kind); }

console.log('detectPatterns:');

// --- Guards -----------------------------------------------------------------
test('returns [] for empty / null input', () => {
  assert.deepStrictEqual(detectPatterns([]), []);
  assert.deepStrictEqual(detectPatterns(null), []);
  assert.deepStrictEqual(detectPatterns(undefined), []);
});

test('returns [] when fewer than 4 candles (3LS needs 4 bars)', () => {
  const three = [bar(100, 10, 9), bar(200, 9, 8), bar(300, 8, 7)];
  assert.strictEqual(three.length, 3);
  assert.deepStrictEqual(detectPatterns(three), []);
});

// --- F6 — 3-Line Strike Bullish (isolated, no engulfing) --------------------
test('F6 detects 3ls_bull and ONLY 3ls_bull', () => {
  // three down candles, then close (9) > open[1] (8). c0.open (8.5) >= open[1]
  // (8) so the bullish-engulfing condition (open < open[1]) does NOT also fire.
  const candles = [
    bar(100, 10, 9),   // c3 down
    bar(200, 9, 8),    // c2 down
    bar(300, 8, 7),    // c1 down
    bar(400, 8.5, 9),  // c0 close 9 > open[1] 8
  ];
  const m = detectPatterns(candles);
  assert.deepStrictEqual(kinds(m), ['3ls_bull']);
  assert.strictEqual(m[0].time, 400);
  assert.strictEqual(m[0].position, 'belowBar');
  assert.strictEqual(m[0].shape, 'arrowUp');
  assert.strictEqual(m[0].color, '#22c55e');
  assert.strictEqual(m[0].text, '3s-Bull');
  assert.strictEqual(m[0].size, 2);
});

// --- F7 — 3-Line Strike Bearish (isolated) ----------------------------------
test('F7 detects 3ls_bear and ONLY 3ls_bear', () => {
  // three up candles, then close (6) < open[1] (7). c0.open (6) < close[1] (8)
  // so the bearish-engulfing condition (open >= close[1]) does NOT also fire.
  const candles = [
    bar(100, 5, 6),   // c3 up
    bar(200, 6, 7),   // c2 up
    bar(300, 7, 8),   // c1 up
    bar(400, 6, 6),   // c0 close 6 < open[1] 7
  ];
  const m = detectPatterns(candles);
  assert.deepStrictEqual(kinds(m), ['3ls_bear']);
  assert.strictEqual(m[0].time, 400);
  assert.strictEqual(m[0].position, 'aboveBar');
  assert.strictEqual(m[0].shape, 'arrowDown');
  assert.strictEqual(m[0].color, '#ef4444');
  assert.strictEqual(m[0].text, '3s-Bear');
  assert.strictEqual(m[0].size, 2);
});

// --- F8 — Bullish Engulfing (isolated, no 3LS) ------------------------------
test('F8 detects engulf_bull and ONLY engulf_bull', () => {
  // c2 is an UP candle so the three-down 3LS precondition is broken.
  // c0: open 8 <= close[1] 9, open 8 < open[1] 10, close 11 > open[1] 10.
  const candles = [
    bar(100, 3, 4),    // c3
    bar(200, 4, 5),    // c2 up  -> breaks 3ls_bull
    bar(300, 10, 9),   // c1 down (prev)
    bar(400, 8, 11),   // c0 engulfs upward
  ];
  const m = detectPatterns(candles);
  assert.deepStrictEqual(kinds(m), ['engulf_bull']);
  assert.strictEqual(m[0].time, 400);
  assert.strictEqual(m[0].position, 'belowBar');
  assert.strictEqual(m[0].shape, 'arrowUp');
  assert.strictEqual(m[0].color, '#22c55e');
  assert.strictEqual(m[0].size, 1);
  assert.strictEqual(m[0].text, undefined); // F8 carries no text
});

// --- F9 — Bearish Engulfing (isolated) --------------------------------------
test('F9 detects engulf_bear and ONLY engulf_bear', () => {
  // c2 is a DOWN candle so the three-up 3LS precondition is broken.
  // c0: open 11 >= close[1] 10, open 11 > open[1] 9, close 8 < open[1] 9.
  const candles = [
    bar(100, 13, 12),  // c3
    bar(200, 12, 11),  // c2 down -> breaks 3ls_bear
    bar(300, 9, 10),   // c1 up (prev)
    bar(400, 11, 8),   // c0 engulfs downward
  ];
  const m = detectPatterns(candles);
  assert.deepStrictEqual(kinds(m), ['engulf_bear']);
  assert.strictEqual(m[0].time, 400);
  assert.strictEqual(m[0].position, 'aboveBar');
  assert.strictEqual(m[0].shape, 'arrowDown');
  assert.strictEqual(m[0].color, '#ef4444');
  assert.strictEqual(m[0].size, 1);
  assert.strictEqual(m[0].text, undefined); // F9 carries no text
});

// --- Pine independence: 3LS and Engulfing can both fire on one bar ----------
test('a single bar can carry BOTH 3ls_bull and engulf_bull (independent plotshapes)', () => {
  // three down candles, then open 7 <= close[1] 7 AND open 7 < open[1] 8 AND
  // close 9 > open[1] 8 — satisfies 3ls_bull AND engulf_bull simultaneously.
  const candles = [
    bar(100, 10, 9),  // c3 down
    bar(200, 9, 8),   // c2 down
    bar(300, 8, 7),   // c1 down
    bar(400, 7, 9),   // c0
  ];
  const m = detectPatterns(candles);
  assert.deepStrictEqual(kinds(m), ['3ls_bull', 'engulf_bull']);
  // Both markers sit on the same closed bar.
  assert.strictEqual(m[0].time, 400);
  assert.strictEqual(m[1].time, 400);
});

// --- No false positives on a flat / no-pattern series -----------------------
test('returns [] for a monotonic series with no pattern', () => {
  // strictly rising opens & closes, each candle up, no down candles at all and
  // no engulfing (open always > previous open, close always > open).
  const candles = [];
  for (let i = 0; i < 10; i++) candles.push(bar(100 + i * 100, 10 + i, 10.5 + i));
  assert.deepStrictEqual(detectPatterns(candles), []);
});

// --- Markers come back sorted ascending by time across a longer series ------
test('markers are emitted in ascending time order', () => {
  // Build: [pad up-candle] then a 3ls_bull block, then padding, then another.
  const candles = [
    bar(100, 10, 9), bar(200, 9, 8), bar(300, 8, 7), bar(400, 7, 9),   // 3ls_bull @400 (+engulf)
    bar(500, 9, 10), bar(600, 10, 11),                                  // padding (up)
    bar(700, 11, 10), bar(800, 10, 9.5), bar(900, 9.5, 9),              // three down
    bar(1000, 9, 11),                                                   // 3ls_bull @1000 (+engulf)
  ];
  const m = detectPatterns(candles);
  for (let i = 1; i < m.length; i++) {
    assert.ok(m[i].time >= m[i - 1].time, 'times must be non-decreasing');
  }
  // sanity: the two strike bars are present.
  assert.ok(m.some(x => x.kind === '3ls_bull' && x.time === 400));
  assert.ok(m.some(x => x.kind === '3ls_bull' && x.time === 1000));
});

console.log('\n' + passed + ' test(s) passed.');
