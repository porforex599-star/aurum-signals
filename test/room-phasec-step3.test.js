/* ============================================================================
 * Phase C Step 3 headless harness — TradingView username welcome popup + grant
 * banner at /room.
 *
 * Loads the REAL room.html in jsdom with the Supabase client + every edge
 * function (wallet-subscriptions gate, aurum-gold-get-my-subscription-state,
 * aurum-gold-submit-tv-username) stubbed, then drives the AurumGoldTV module
 * the way a freshly-paid customer / the grant bot would and asserts the
 * Phase C Step 3 contract:
 *
 *   1. awaiting_username → the welcome popup is forced open, the submit
 *      subscription_id is captured from state, no banner is shown.
 *   2. Client validation: '@AurumTrader1' strips the '@' and enables submit;
 *      'abc@' is invalid → submit disabled.
 *   3. Submit 200 → popup closes, success toast, and after the state re-pull
 *      the pending_bot banner appears.
 *   4. active (no awaiting) → no popup; the "พร้อมใช้งาน" banner shows the
 *      remaining-days countdown.
 *   5. ?welcome=1 on an already-active subscription → popup reconciles closed
 *      and the active banner shows instead (welcome=1 stripped from the URL).
 *   6. Submit 409 (already submitted) → popup closes.
 *
 * No test framework — plain `node test/room-phasec-step3.test.js` (requires
 * jsdom). Exits non-zero on the first failed assertion.
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
const SUBMIT_URL = 'aurum-gold-submit-tv-username';
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

/* ---- mock Supabase client (gate auth only; no feed rows needed here) ------- */
function makeSupabaseStub() {
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

/* ---- URL-aware fetch stub -------------------------------------------------
 * `ctx` is mutable so a test can change what the state endpoint returns
 * between polls (e.g. awaiting_username → pending_bot after a submit), and
 * inspect what the submit endpoint received.
 * ------------------------------------------------------------------------- */
function makeFetch(ctx) {
  return async function fetch(url, opts) {
    const u = String(url);
    if (u.includes(WALLET_URL)) {
      // Gate entitlement — always an active analysis sub so the room reveals.
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
      ctx.stateCalls = (ctx.stateCalls || 0) + 1;
      return { ok: true, status: 200, async json() { return { subscriptions: ctx.state }; } };
    }
    if (u.includes(SUBMIT_URL)) {
      ctx.submitBody = JSON.parse(opts.body);
      const r = ctx.submitResult || { status: 200, body: { success: true } };
      return { ok: r.status === 200, status: r.status, async json() { return r.body; } };
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
  tv_grant_status: null, tradingview_username: null,
  tv_expires_at: null, tv_grant_notes: null, tv_days_remaining: null,
}, overrides);

const isPopupOpen = (d) => d.getElementById('tv-popup').classList.contains('open');
const bannerShown = (d) => d.getElementById('tv-banner').classList.contains('show');

/* ========================================================================== */
(async function run() {
  console.log('Phase C Step 3 — TV username popup + grant banner (jsdom harness):');

  /* --- 1. awaiting_username forces the popup open -------------------------- */
  {
    const ctx = { state: [sub({ tv_grant_status: 'awaiting_username' })], submitResult: { status: 200, body: { success: true } } };
    const { document, window } = await boot(ctx);
    await waitFor(() => isPopupOpen(document));

    await test('awaiting_username forces the welcome popup open', () => {
      assert.ok(isPopupOpen(document), 'popup must be open');
      assert.ok(!bannerShown(document), 'banner must be hidden while awaiting');
    });

    /* --- 2. client validation ------------------------------------------- */
    await test("'@AurumTrader1' strips the @ and enables submit", () => {
      const input = document.getElementById('tv-username');
      input.value = '@AurumTrader1';
      input.dispatchEvent(new window.Event('input'));
      assert.strictEqual(input.value, 'AurumTrader1', 'leading @ must be stripped live');
      assert.strictEqual(document.getElementById('tv-submit').disabled, false, 'submit enabled for a valid name');
    });
    await test("'abc@' is invalid → submit disabled", () => {
      const input = document.getElementById('tv-username');
      input.value = 'abc@';
      input.dispatchEvent(new window.Event('input'));
      assert.strictEqual(document.getElementById('tv-submit').disabled, true, 'submit disabled for an invalid name');
    });

    /* --- 3. submit 200 → popup closes + pending_bot banner --------------- */
    await test('submit 200 closes the popup and queues a pending_bot banner', async () => {
      const input = document.getElementById('tv-username');
      input.value = 'AurumTrader1';
      input.dispatchEvent(new window.Event('input'));
      // The next state pull (post-submit refresh) reflects the bot enqueue.
      ctx.state = [sub({ tv_grant_status: 'pending_bot' })];
      document.getElementById('tv-submit').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

      await waitFor(() => !isPopupOpen(document) && bannerShown(document));
      assert.deepStrictEqual(ctx.submitBody, { subscription_id: 'sub-1', tradingview_username: 'AurumTrader1' });
      assert.ok(!isPopupOpen(document), 'popup closes on 200');
      const banner = document.getElementById('tv-banner');
      assert.ok(banner.querySelector('.tv-banner-pending'), 'pending_bot banner shown');
      assert.ok(/กำลังเปิดสิทธิ์/.test(banner.textContent), 'pending copy present');
      assert.ok(document.querySelector('#toast-wrap .toast'), 'success toast shown');
    });
  }

  /* --- 4. active state → no popup, countdown banner ----------------------- */
  {
    const ctx = { state: [sub({ tv_grant_status: 'active', tv_days_remaining: 27,
      tv_expires_at: new Date(Date.now() + 27 * 86400000).toISOString() })] };
    const { document } = await boot(ctx);
    await waitFor(() => bannerShown(document));

    await test('active subscription shows the ready banner with a day countdown', () => {
      assert.ok(!isPopupOpen(document), 'no popup when already active');
      const banner = document.getElementById('tv-banner');
      assert.ok(banner.querySelector('.tv-banner-active'), 'active banner shown');
      assert.ok(/พร้อมใช้งาน/.test(banner.textContent), 'ready copy present');
      assert.ok(/เหลือ 27 วัน/.test(banner.textContent), 'countdown present');
    });
  }

  /* --- 5. ?welcome=1 on an already-active sub → reconcile to banner -------- */
  {
    const ctx = { state: [sub({ tv_grant_status: 'active', tv_days_remaining: 12 })] };
    const { document, window } = await boot(ctx, 'https://room.test/?welcome=1');
    // Popup flashes open immediately, then state reconciles it closed.
    await waitFor(() => bannerShown(document) && !isPopupOpen(document));

    await test('?welcome=1 with an active sub reconciles the popup closed', () => {
      assert.ok(!isPopupOpen(document), 'popup must reconcile closed when not awaiting');
      assert.ok(document.getElementById('tv-banner').querySelector('.tv-banner-active'), 'active banner shown');
    });
    await test('welcome=1 is stripped from the URL', () => {
      assert.ok(!/welcome=1/.test(window.location.search), 'welcome=1 removed via replaceState');
    });
  }

  /* --- 6. submit 409 (already submitted) → popup closes -------------------- */
  {
    const ctx = {
      state: [sub({ tv_grant_status: 'awaiting_username' })],
      submitResult: { status: 409, body: { error: 'invalid_state', tv_grant_status: 'pending_bot' } },
    };
    const { document, window } = await boot(ctx);
    await waitFor(() => isPopupOpen(document));

    await test('submit 409 closes the popup (already submitted elsewhere)', async () => {
      const input = document.getElementById('tv-username');
      input.value = 'AurumTrader1';
      input.dispatchEvent(new window.Event('input'));
      ctx.state = [sub({ tv_grant_status: 'pending_bot' })];
      document.getElementById('tv-submit').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await waitFor(() => !isPopupOpen(document));
      assert.ok(!isPopupOpen(document), 'popup closes on 409');
    });
  }

  console.log('\n' + passed + ' test(s) passed.\n');
  // The page installs 30s poll intervals per booted instance; exit cleanly
  // instead of letting the harness hang on those timers.
  process.exit(0);
})().catch((err) => {
  console.error('\n  ✗ ' + (err && err.message ? err.message : err) + '\n');
  process.exit(1);
});
