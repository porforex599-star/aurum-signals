/* ============================================================================
 * Room menu bar headless harness — TradingView Username panel + placeholders.
 *
 * Loads the REAL room.html in jsdom with the Supabase client + edge functions
 * stubbed (same approach as room-phasec-step3.test.js), then drives the room
 * menu the way a customer would and asserts:
 *
 *   1. The three menu pills render with the expected labels.
 *   2. Clicking "TradingView Username" opens the panel and shows the username
 *      pulled from the subscription state (e.g. 'monthong128'), with a copy
 *      button and the LINE@ warning box.
 *   3. The copy button writes the username to the clipboard and confirms.
 *   4. Clicking the ✕ collapses the panel back to the default room view.
 *   5. The placeholder pills open a panel with the "เร็วๆ นี้" message.
 *   6. With no tradingview_username on any sub, the panel shows the
 *      "ยังไม่ได้ลงทะเบียน" guidance instead.
 *
 * No test framework — plain `node test/room-menu-bar.test.js` (requires jsdom).
 * Exits non-zero on the first failed assertion.
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

const STATE_URL  = 'aurum-gold-get-my-subscription-state';
const WALLET_URL = 'wallet-subscriptions';

let passed = 0;
function test(name, fn) {
  const r = fn();
  if (r && typeof r.then === 'function') return r.then(() => { passed++; console.log('  ✓ ' + name); });
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

function makeSupabaseStub() {
  function createClient() {
    return {
      auth: {
        async getSession() {
          return { data: { session: { access_token: 'tok', user: { email: 'porforex599@gmail.com' } } } };
        },
        async signOut() { return {}; },
      },
      from() {
        const qb = {
          select() { return qb; },
          order() { return qb; },
          not() { return qb; },
          async limit() { return { data: [], error: null }; },
        };
        return qb;
      },
      channel() {
        const ch = { on() { return ch; }, subscribe() { return ch; } };
        return ch;
      },
    };
  }
  return { createClient };
}

function makeFetch(ctx) {
  return async function fetch(url) {
    const u = String(url);
    if (u.includes(WALLET_URL)) {
      return {
        ok: true, status: 200,
        async json() {
          return { subscriptions: [{
            product_type: 'aurum_analysis', status: 'active',
            expires_at: new Date(Date.now() + 30 * 86400000).toISOString(),
          }] };
        },
      };
    }
    if (u.includes(STATE_URL)) {
      return { ok: true, status: 200, async json() { return { subscriptions: ctx.state }; } };
    }
    return { ok: false, status: 404, async json() { return {}; } };
  };
}

async function boot(ctx, url = 'https://room.test/') {
  const dom = new JSDOM(ROOM_HTML, {
    runScripts: 'dangerously',
    url,
    pretendToBeVisual: true,
    beforeParse(window) {
      window.supabase = makeSupabaseStub();
      window.tailwind = {};
      window.fetch = makeFetch(ctx);
      ctx.copied = null;
      Object.defineProperty(window.navigator, 'clipboard', {
        configurable: true,
        value: { async writeText(t) { ctx.copied = t; } },
      });
    },
  });
  const { window } = dom;
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  return { dom, window, document: window.document };
}

const sub = (overrides) => Object.assign({
  subscription_id: 'sub-1', status: 'active',
  expires_at: new Date(Date.now() + 30 * 86400000).toISOString(),
  plan_name: 'Aurum Analysis Weekly', product_type: 'aurum_analysis',
  tv_grant_status: 'active', tradingview_username: null,
  tv_expires_at: null, tv_grant_notes: null, tv_days_remaining: 27,
}, overrides);

const pill = (d, name) => d.querySelector('.room-menu-pill[data-panel="' + name + '"]');
const panelOpen = (d) => d.getElementById('room-panel').classList.contains('open');
function click(window, el) { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); }

/* ========================================================================== */
(async function run() {
  console.log('Room menu bar — TradingView Username panel + placeholders (jsdom harness):');

  /* --- 1-4. functional username panel ------------------------------------ */
  {
    const ctx = { state: [sub({ tradingview_username: 'monthong128' })] };
    const { document, window } = await boot(ctx);
    // Wait until the access gate revealed the room and AurumGoldTV booted.
    await waitFor(() => document.getElementById('tv-banner').classList.contains('show'));

    await test('three menu pills render with the expected labels', () => {
      const labels = Array.prototype.map.call(
        document.querySelectorAll('.room-menu-pill'), (b) => b.textContent.trim());
      assert.deepStrictEqual(labels, ['TradingView Username', 'ข้อมูลการใช้งาน', 'วิธีการใช้งาน']);
    });

    await test('clicking the TradingView pill opens the panel with the username', async () => {
      click(window, pill(document, 'tv'));
      await waitFor(() => {
        const n = document.querySelector('#room-panel .room-tv-name');
        return n && /monthong128/.test(n.textContent);
      });
      assert.ok(panelOpen(document), 'panel must be open');
      assert.ok(pill(document, 'tv').classList.contains('active'), 'TV pill must be highlighted');
      const name = document.querySelector('#room-panel .room-tv-name');
      assert.ok(name && /monthong128/.test(name.textContent), 'username displayed');
      assert.ok(document.querySelector('#room-panel .room-tv-copy'), 'copy button present');
      assert.ok(/หากกรอก Username ผิด/.test(document.getElementById('room-panel').textContent), 'warning box present');
    });

    await test('copy button writes the username to the clipboard and confirms', async () => {
      const btn = document.querySelector('#room-panel .room-tv-copy');
      click(window, btn);
      await waitFor(() => ctx.copied === 'monthong128');
      assert.strictEqual(ctx.copied, 'monthong128', 'clipboard received the username');
      await waitFor(() => btn.classList.contains('copied'));
      assert.ok(/คัดลอกแล้ว/.test(btn.textContent), 'copied confirmation shown');
    });

    await test('✕ collapses the panel back to the default room view', async () => {
      click(window, document.querySelector('#room-panel .room-panel-close'));
      await waitFor(() => !panelOpen(document));
      assert.ok(!panelOpen(document), 'panel collapsed');
      assert.strictEqual(document.getElementById('room-panel').innerHTML, '', 'panel emptied');
      assert.ok(!pill(document, 'tv').classList.contains('active'), 'no pill highlighted');
    });

    await test('placeholder pills open a panel with the "เร็วๆ นี้" message', async () => {
      click(window, pill(document, 'usage'));
      await waitFor(() => panelOpen(document) && /เร็วๆ นี้/.test(document.getElementById('room-panel').textContent));
      assert.ok(/เร็วๆ นี้/.test(document.getElementById('room-panel').textContent), 'usage placeholder shown');

      click(window, pill(document, 'howto'));
      await waitFor(() => /เร็วๆ นี้/.test(document.getElementById('room-panel').textContent)
        && pill(document, 'howto').classList.contains('active'));
      assert.ok(pill(document, 'howto').classList.contains('active'), 'howto pill highlighted');
      assert.ok(!pill(document, 'usage').classList.contains('active'), 'previous pill deactivated');
    });
  }

  /* --- 5. no registered username ----------------------------------------- */
  {
    const ctx = { state: [sub({ tradingview_username: null })] };
    const { document, window } = await boot(ctx);
    await waitFor(() => document.getElementById('tv-banner').classList.contains('show'));

    await test('no tradingview_username → shows the registration guidance', async () => {
      click(window, pill(document, 'tv'));
      await waitFor(() => /ยังไม่ได้ลงทะเบียน/.test(document.getElementById('room-panel').textContent));
      assert.ok(/ยังไม่ได้ลงทะเบียน TradingView Username/.test(document.getElementById('room-panel').textContent),
        'guidance message shown');
      assert.ok(!document.querySelector('#room-panel .room-tv-name'), 'no username display');
    });
  }

  console.log('\n' + passed + ' test(s) passed.\n');
  process.exit(0);
})().catch((err) => {
  console.error('\n  ✗ ' + (err && err.message ? err.message : err) + '\n');
  process.exit(1);
});
