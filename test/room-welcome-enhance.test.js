/* ============================================================================
 * Welcome popup enhancement headless harness — X close button, video tutorial
 * sub-modal, the awaiting-username reminder banner, and the chart lock state.
 *
 * Loads the REAL room.html in jsdom (Supabase client + edge functions stubbed
 * the same way as room-phasec-step3.test.js) and drives the AurumGoldTV module
 * through the enhancement contract:
 *
 *   1. awaiting_username → popup forced open AND the reminder banner + chart
 *      lock are present (the banner sits behind the popup overlay).
 *   2. X (or Esc) dismisses the popup → popup closes, banner + lock stay so the
 *      reminder is revealed. The poll does NOT re-pop it the same session.
 *   3. The reminder banner's "กรอกตอนนี้" button re-opens the popup.
 *   4. The video CTA opens the sub-modal (no autoplay); Esc closes the
 *      sub-modal first and leaves the popup open; a second Esc dismisses the
 *      popup.
 *   5. A successful submit hides the popup, the reminder banner, and the lock.
 *
 * No test framework — plain `node test/room-welcome-enhance.test.js`.
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
async function test(name, fn) {
  await fn();
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
        async getSession() { return { data: { session: { access_token: 'tok', user: { email: 'test@aurum' } } } }; },
        async signOut() { return {}; },
      },
      from() {
        const qb = { select() { return qb; }, order() { return qb; }, not() { return qb; }, async limit() { return { data: [], error: null }; } };
        return qb;
      },
      channel() { const ch = { on() { return ch; }, subscribe() { return ch; } }; return ch; },
    };
  }
  return { createClient };
}

function makeFetch(ctx) {
  return async function fetch(url, opts) {
    const u = String(url);
    if (u.includes(WALLET_URL)) {
      return { ok: true, status: 200, async json() {
        return { subscriptions: [{ product_type: 'aurum_analysis', status: 'active', expires_at: new Date(Date.now() + 30 * 86400000).toISOString() }] };
      } };
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
      // jsdom doesn't implement HTMLMediaElement.pause(); stub it so closeVideo() works.
      window.HTMLMediaElement.prototype.pause = function () {};
      window.HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
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

const has  = (d, id, cls) => d.getElementById(id).classList.contains(cls);
const open = (d) => has(d, 'tv-popup', 'open');
const click = (window, el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const esc   = (window, document) => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

/* ========================================================================== */
(async function run() {
  console.log('Welcome popup enhancement — X / video sub-modal / banner / lock (jsdom harness):');

  /* --- 1. awaiting_username → popup + reminder banner + lock --------------- */
  {
    const ctx = { state: [sub({ tv_grant_status: 'awaiting_username' })], submitResult: { status: 200, body: { success: true } } };
    const { document, window } = await boot(ctx);
    await waitFor(() => open(document));

    await test('awaiting_username opens the popup and reveals banner + lock', () => {
      assert.ok(open(document), 'popup open');
      assert.ok(has(document, 'tv-await-banner', 'show'), 'reminder banner shown (behind overlay)');
      assert.ok(has(document, 'tv-lock', 'show'), 'chart lock shown');
      assert.ok(!has(document, 'tv-banner', 'show'), 'grant-state banner stays hidden while awaiting');
    });

    /* --- 2. X dismisses the popup; banner + lock remain ------------------- */
    await test('X closes the popup but leaves the reminder banner + lock', async () => {
      click(window, document.getElementById('tv-popup-close'));
      await waitFor(() => !open(document));
      assert.ok(!open(document), 'popup closed by X');
      assert.ok(has(document, 'tv-await-banner', 'show'), 'reminder banner still visible');
      assert.ok(has(document, 'tv-lock', 'show'), 'chart lock still visible');
    });

    /* --- 2b. the poll does not re-pop a dismissed popup ------------------- */
    await test('a state refresh does not re-open a dismissed popup', async () => {
      await window.AurumGoldTV.loadSubscriptions(); // also re-run reconcile via refresh
      // Trigger an internal refresh by dispatching nothing — rely on the dismissed flag.
      await wait(60);
      assert.ok(!open(document), 'popup stays closed after dismissal');
    });

    /* --- 3. reminder banner CTA re-opens the popup ----------------------- */
    await test('the reminder banner button re-opens the popup', async () => {
      click(window, document.getElementById('tv-await-cta'));
      await waitFor(() => open(document));
      assert.ok(open(document), 'popup re-opened from the banner');
    });

    /* --- 4. video CTA opens the sub-modal; Esc layering ------------------- */
    await test('video CTA opens the sub-modal without autoplay', () => {
      const v = document.getElementById('tv-video-player');
      assert.ok(!v.hasAttribute('autoplay'), 'video must not autoplay');
      assert.ok(v.querySelector('source[src*="cloudinary"]'), 'cloudinary source wired');
      click(window, document.getElementById('tv-video-cta'));
      assert.ok(has(document, 'tv-video-modal', 'open'), 'sub-modal open');
      assert.ok(open(document), 'welcome popup still open underneath');
    });

    await test('Esc closes the sub-modal first, leaving the popup open', () => {
      esc(window, document);
      assert.ok(!has(document, 'tv-video-modal', 'open'), 'sub-modal closed by Esc');
      assert.ok(open(document), 'popup still open after closing the sub-modal');
    });

    await test('a second Esc dismisses the popup (banner stays)', async () => {
      esc(window, document);
      await waitFor(() => !open(document));
      assert.ok(!open(document), 'popup dismissed by Esc');
      assert.ok(has(document, 'tv-await-banner', 'show'), 'reminder banner remains');
    });
  }

  /* --- 5. successful submit hides popup + banner + lock -------------------- */
  {
    const ctx = { state: [sub({ tv_grant_status: 'awaiting_username' })], submitResult: { status: 200, body: { success: true } } };
    const { document, window } = await boot(ctx);
    await waitFor(() => open(document));

    await test('submit success tears down popup + reminder banner + lock', async () => {
      const input = document.getElementById('tv-username');
      input.value = 'JohnDoe123';
      input.dispatchEvent(new window.Event('input'));
      ctx.state = [sub({ tv_grant_status: 'active', tv_days_remaining: 30 })];
      click(window, document.getElementById('tv-submit'));
      await waitFor(() => !open(document) && !has(document, 'tv-await-banner', 'show'));
      assert.ok(!open(document), 'popup closed');
      assert.ok(!has(document, 'tv-await-banner', 'show'), 'reminder banner hidden');
      assert.ok(!has(document, 'tv-lock', 'show'), 'chart lock hidden');
      assert.ok(document.getElementById('tv-banner').querySelector('.tv-banner-active'), 'active grant banner shown');
    });
  }

  console.log('\n' + passed + ' test(s) passed.\n');
  process.exit(0);
})().catch((err) => {
  console.error('\n  ✗ ' + (err && err.message ? err.message : err) + '\n');
  process.exit(1);
});
