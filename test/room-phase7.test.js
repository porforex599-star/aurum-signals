/* ============================================================================
 * Phase 7 headless harness — inline chart-img.com PNG + filter no-chart posts.
 *
 * Loads the REAL room.html in jsdom (a headless DOM; Chromium isn't available
 * in this environment) with the Supabase client, the entitlement fetch and the
 * realtime channels stubbed, then drives it the way a customer / the backend
 * would and asserts the Phase 7 contract:
 *
 *   1. loadRealFeed applies .not('chart_image_url','is',null) and only posts
 *      WITH a chart_image_url reach the feed (old test webhooks are hidden).
 *   2. The post detail renders the chart_image_url as an inline <img> (no
 *      Lightweight Charts canvas / #chart-container).
 *   3. Clicking the inline image opens the Phase 5b full-screen modal.
 *   4. Realtime: INSERT with no image → row NOT in the list; a later UPDATE
 *      that fills chart_image_url → the row appears at the top of the list.
 *   5. Empty state when zero posts have an image.
 *   6. Modal close interactions (ESC, × button) still tear the modal down.
 *
 * No test framework — plain `node test/room-phase7.test.js` (requires jsdom:
 *   npm install jsdom
 * ). Exits non-zero on the first failed assertion.
 * ========================================================================== */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch (e) {
  console.error('\n  jsdom is required for this harness. Install it first:\n    npm install jsdom\n');
  process.exit(1);
}

const ROOM_HTML = fs.readFileSync(path.join(__dirname, '..', 'room.html'), 'utf8');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log('  ✓ ' + name);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(predicate, { timeout = 2000, step = 15 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (predicate()) return true;
    await wait(step);
  }
  return predicate();
}

/* ---- fixtures ------------------------------------------------------------- */
function row(id, symbol, bias, chartUrl, secondsAgo, extra) {
  return Object.assign({
    id, symbol, timeframe: 'M15', bias,
    candles: [], target_zones: [], sd_zones: [], pattern_markers: [],
    confidence: 80, key_level: 2400, invalidation_price: 2390, rr_ratio: 2,
    note: 'บทวิเคราะห์ทดสอบ',
    created_at: new Date(Date.now() - (secondsAgo || 0) * 1000).toISOString(),
    chart_image_url: chartUrl,
    chart_image_generated_at: chartUrl ? new Date().toISOString() : null,
  }, extra || {});
}

// An AI-scheduled briefing (Phase B.4): no chart image, surfaced on source.
function aiRow(id, slot, secondsAgo) {
  return row(id, 'XAUUSD', 'bullish', null, secondsAgo, {
    source: 'ai_scheduled', schedule_slot: slot, timeframe: 'briefing',
    note: 'บทวิเคราะห์ XAUUSD ช่วงเช้า\n\n📊 ภาพรวมตลาด\nทดสอบเนื้อหา',
  });
}

/* ---- mock Supabase client (gate auth + feed query + realtime channels) ---- */
function makeSupabaseStub(rows, captures) {
  function createClient() {
    return {
      auth: {
        async getSession() {
          return { data: { session: { access_token: 'tok', user: { email: 'test@aurum' } } } };
        },
        async signOut() { return {}; },
      },
      from() {
        const qb = {
          _filtered: false,
          select() { return qb; },
          order() { return qb; },
          // Phase B.4 — loadRealFeed now uses .or() to admit AI-scheduled posts
          // alongside chart-image Pine posts.
          or(filter) { captures.or = filter; qb._filtered = true; return qb; },
          // The real query resolves on .limit(); emulate the server-side filter:
          // chart_image_url IS NOT NULL OR source = 'ai_scheduled'.
          async limit() {
            const data = qb._filtered
              ? rows.filter((r) => r.chart_image_url != null || r.source === 'ai_scheduled')
              : rows.slice();
            return { data, error: null };
          },
        };
        return qb;
      },
      channel() {
        const ch = {
          on(evt, cfg, cb) {
            if (cfg && cfg.event === 'INSERT') captures.insertCb = cb;
            if (cfg && cfg.event === 'UPDATE') captures.updateCb = cb;
            return ch;
          },
          subscribe() { return ch; },
        };
        return ch;
      },
    };
  }
  return { createClient };
}

/* ---- boot a room.html instance with everything external stubbed ----------- */
async function boot(rows) {
  const captures = {};
  const dom = new JSDOM(ROOM_HTML, {
    runScripts: 'dangerously',
    url: 'https://room.test/',
    pretendToBeVisual: true,
    beforeParse(window) {
      // Supabase loaded from CDN in the page; provide the stub before any script.
      window.supabase = makeSupabaseStub(rows, captures);
      // tailwind.config = {...} runs as an inline script — give it a home.
      window.tailwind = {};
      // Entitlement check (wallet-subscriptions) — return an active analysis sub
      // so the access gate passes and the room markup survives.
      window.fetch = async () => ({
        ok: true,
        async json() {
          return {
            subscriptions: [{
              product_type: 'aurum_analysis', status: 'active',
              expires_at: new Date(Date.now() + 30 * 86400000).toISOString(),
            }],
          };
        },
      });
    },
  });
  const { window } = dom;
  const { document } = window;
  // Let the gate + loadRealFeed promises settle.
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  return { dom, window, document, captures };
}

function listRowIds(document) {
  return Array.from(document.querySelectorAll('#list [id^="row-"]')).map((el) => el.id.slice(4));
}

/* ========================================================================== */
(async function run() {
  console.log('Phase 7 — inline chart + filter (jsdom harness):');

  /* --- 1. filter: only posts WITH chart_image_url reach the feed ----------- */
  {
    const rows = [
      row('p1', 'XAUUSD', 'bullish', 'https://img.test/p1.png', 5),
      row('p2', 'EURUSD', 'bearish', 'https://img.test/p2.png', 60),
      row('p3', 'BTCUSD', 'bullish', null, 120), // old test webhook, no image
      aiRow('a1', 'morning', 90),                // AI briefing, no image → still shown
    ];
    const { document, captures } = await boot(rows);
    await waitFor(() => listRowIds(document).length > 0);

    test('loadRealFeed uses .or(chart_image_url OR ai_scheduled)', () => {
      assert.strictEqual(captures.or, 'chart_image_url.not.is.null,source.eq.ai_scheduled');
    });
    test('chart-image posts AND ai_scheduled briefings appear; no-chart Pine row filtered', () => {
      const ids = listRowIds(document);
      assert.deepStrictEqual(ids.sort(), ['a1', 'p1', 'p2']);
      assert.strictEqual(document.getElementById('row-p3'), null);
    });
    test('ai_scheduled briefing renders its schedule-slot badge', () => {
      const rowEl = document.getElementById('row-a1');
      assert.ok(rowEl, 'ai_scheduled row must be in the list');
      assert.ok(rowEl.textContent.includes('AI · ช่วงเช้า'), 'morning badge expected on the list row');
    });

    /* --- 2. inline <img>, no Lightweight Charts canvas -------------------- */
    test('post detail renders chart_image_url as an inline <img>', () => {
      const img = document.getElementById('inline-chart-img');
      assert.ok(img, 'inline-chart-img must exist');
      assert.ok(!img.classList.contains('hidden'), 'inline image must be visible');
      assert.strictEqual(img.getAttribute('src'), 'https://img.test/p1.png');
      assert.ok(img.classList.contains('chart-inline-img'));
    });
    test('Lightweight Charts container is NOT rendered', () => {
      assert.strictEqual(document.getElementById('chart-container'), null);
      assert.strictEqual(document.getElementById('ema-toggle'), null);
      assert.strictEqual(document.getElementById('smma-toggle-bar'), null);
    });

    /* --- 3. clicking the inline image opens the modal -------------------- */
    test('clicking the inline image opens the full-screen modal', () => {
      const img = document.getElementById('inline-chart-img');
      img.dispatchEvent(new img.ownerDocument.defaultView.MouseEvent('click', { bubbles: true }));
      const modal = document.getElementById('chart-modal');
      assert.ok(modal.classList.contains('open'), 'modal should be open');
      assert.strictEqual(document.getElementById('chart-modal-img').getAttribute('src'), 'https://img.test/p1.png');
    });

    /* --- 6. modal close interactions ------------------------------------ */
    test('ESC closes the modal', async () => {
      const win = document.defaultView;
      win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await waitFor(() => !document.getElementById('chart-modal').classList.contains('open'), { timeout: 500 });
      assert.ok(!document.getElementById('chart-modal').classList.contains('open'), 'modal should close on ESC');
    });
    test('× button closes the modal', async () => {
      const win = document.defaultView;
      document.getElementById('inline-chart-img')
        .dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
      assert.ok(document.getElementById('chart-modal').classList.contains('open'));
      document.getElementById('chart-modal-close')
        .dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
      await waitFor(() => !document.getElementById('chart-modal').classList.contains('open'), { timeout: 500 });
      assert.ok(!document.getElementById('chart-modal').classList.contains('open'), 'modal should close on ×');
    });

    /* --- 4. realtime INSERT (no image) → not shown; UPDATE → appears ----- */
    test('realtime INSERT with no chart_image_url is NOT added to the feed', () => {
      assert.ok(typeof captures.insertCb === 'function', 'INSERT callback must be registered');
      captures.insertCb({ new: row('p3', 'BTCUSD', 'bullish', null, 0) });
      assert.strictEqual(document.getElementById('row-p3'), null);
      assert.deepStrictEqual(listRowIds(document).sort(), ['a1', 'p1', 'p2']);
    });
    test('realtime UPDATE filling chart_image_url adds the row at the top', () => {
      assert.ok(typeof captures.updateCb === 'function', 'UPDATE callback must be registered');
      captures.updateCb({ new: row('p3', 'BTCUSD', 'bullish', 'https://img.test/p3.png', 0) });
      const ids = listRowIds(document);
      assert.ok(ids.includes('p3'), 'p3 should now be in the feed');
      assert.strictEqual(ids[0], 'p3', 'p3 should be at the top of the list');
    });
    test('a second UPDATE on a visible row does not duplicate it', () => {
      captures.updateCb({ new: row('p3', 'BTCUSD', 'bullish', 'https://img.test/p3.png', 0) });
      const ids = listRowIds(document);
      assert.strictEqual(ids.filter((x) => x === 'p3').length, 1);
    });
    test('realtime INSERT of an ai_scheduled briefing (no image) appears immediately', () => {
      captures.insertCb({ new: aiRow('a2', 'evening', 0) });
      const ids = listRowIds(document);
      assert.ok(ids.includes('a2'), 'evening briefing should be added live without a chart image');
      assert.strictEqual(ids[0], 'a2', 'newest briefing should be at the top');
    });
  }

  /* --- 5. empty state when no post has an image --------------------------- */
  {
    const rows = [row('q1', 'XAUUSD', 'bullish', null, 5), row('q2', 'EURUSD', 'bearish', null, 9)];
    const { document } = await boot(rows);
    await waitFor(() => document.getElementById('list').textContent.trim().length > 0);
    test('empty state shows when zero posts have a chart image', () => {
      assert.strictEqual(document.getElementById('row-q1'), null);
      assert.ok(
        document.getElementById('list').textContent.includes('ยังไม่มีบทวิเคราะห์'),
        'empty-state copy should be shown'
      );
    });
  }

  /* --- Phase B.4.2: an ai_scheduled briefing carrying a chart_image_url (a
     Pine V.2 webhook screenshot) renders the inline <img>, exactly like a
     Pine post — no iframe, no special-casing on source. ------------------- */
  {
    const briefing = aiRow('b1', 'morning', 5);
    briefing.chart_image_url = 'https://img.test/aurum-briefing.png';
    briefing.chart_image_generated_at = new Date().toISOString();
    const { document } = await boot([briefing]);
    await waitFor(() => document.getElementById('row-b1'));
    test('ai_scheduled briefing with a Pine-webhook chart renders an inline <img>', () => {
      const img = document.getElementById('inline-chart-img');
      assert.ok(img, 'inline-chart-img must exist');
      assert.ok(!img.classList.contains('hidden'), 'inline image must be visible for a briefing carrying a chart');
      assert.strictEqual(img.getAttribute('src'), 'https://img.test/aurum-briefing.png');
      assert.strictEqual(document.getElementById('chart-modal-img') != null, true);
    });
    test('ai_scheduled chart credit reads "ภาพจาก AURUM AI" (not TradingView)', () => {
      const credit = document.getElementById('inline-chart-credit');
      assert.ok(credit, 'inline-chart-credit must exist');
      assert.ok(!credit.classList.contains('hidden'), 'credit caption must be visible with the image');
      assert.ok(credit.textContent.includes('AURUM AI'), 'briefing credit should attribute AURUM AI');
      assert.ok(!credit.textContent.includes('TradingView'), 'briefing credit must not say TradingView');
    });
  }

  /* A Pine post keeps the TradingView credit (regression guard for the source switch). */
  {
    const pineRow = row('pc1', 'XAUUSD', 'bullish', 'https://img.test/pine.png', 5);
    const { document } = await boot([pineRow]);
    await waitFor(() => document.getElementById('row-pc1'));
    test('pine post chart credit still reads "ภาพจาก TradingView"', () => {
      const credit = document.getElementById('inline-chart-credit');
      assert.ok(credit && !credit.classList.contains('hidden'));
      assert.ok(credit.textContent.includes('TradingView'), 'non-briefing credit stays TradingView');
    });
  }

  /* --- mobile responsive: inline image fills width (CSS rule present) ----- */
  test('inline image CSS fills container width (responsive)', () => {
    assert.ok(/\.chart-inline-img\s*\{[^}]*width:\s*100%/.test(ROOM_HTML), 'width:100% rule expected');
    assert.ok(/\.chart-inline-img\s*\{[^}]*max-width:\s*100%/.test(ROOM_HTML), 'max-width:100% rule expected');
    assert.ok(/\.chart-inline-img\s*\{[^}]*object-fit:\s*contain/.test(ROOM_HTML), 'object-fit:contain rule expected');
  });

  console.log('\n' + passed + ' test(s) passed.');
  process.exit(0);
})().catch((e) => {
  console.error('\n✗ ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
