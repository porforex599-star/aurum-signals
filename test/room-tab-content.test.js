/* ============================================================================
 * Room tab-content headless harness — วิธีการใช้งาน (howto) + ข้อมูลการใช้งาน
 * (usage) panels.
 *
 * Loads the REAL room.html in jsdom (Supabase client + edge functions stubbed
 * like room-menu-bar.test.js), opens each content pill, and asserts the
 * rendered copy + structure:
 *
 *   วิธีการใช้งาน: M5 / M15, แม่น้ำสีแดง / สีเขียว, 3s-Bull / 3s-Bear,
 *     Risk Level, the disclaimer (บทวิเคราะห์ทางเทคนิค / ไม่ใช่คำแนะนำการลงทุน).
 *   ข้อมูลการใช้งาน: Cheat Sheet, XAUUSD, ≥5 <details> FAQ items, LINE @aurumai.
 *
 * No test framework — plain `node test/room-tab-content.test.js` (requires jsdom).
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
async function test(name, fn) { await fn(); passed++; console.log('  ✓ ' + name); }
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
      from() { const qb = { select() { return qb; }, order() { return qb; }, not() { return qb; }, async limit() { return { data: [], error: null }; } }; return qb; },
      channel() { const ch = { on() { return ch; }, subscribe() { return ch; } }; return ch; },
    };
  }
  return { createClient };
}

function makeFetch(ctx) {
  return async function fetch(url) {
    const u = String(url);
    if (u.includes(WALLET_URL)) {
      return { ok: true, status: 200, async json() {
        return { subscriptions: [{ product_type: 'aurum_analysis', status: 'active', expires_at: new Date(Date.now() + 30 * 86400000).toISOString() }] };
      } };
    }
    if (u.includes(STATE_URL)) {
      return { ok: true, status: 200, async json() { return { subscriptions: ctx.state }; } };
    }
    return { ok: false, status: 404, async json() { return {}; } };
  };
}

async function boot(ctx) {
  const dom = new JSDOM(ROOM_HTML, {
    runScripts: 'dangerously',
    url: 'https://room.test/',
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

// active subscription so the room reveals and the menu wires up
const sub = (overrides) => Object.assign({
  subscription_id: 'sub-1', status: 'active',
  expires_at: new Date(Date.now() + 30 * 86400000).toISOString(),
  plan_name: 'Aurum Analysis Weekly', product_type: 'aurum_analysis',
  tv_grant_status: 'active', tradingview_username: 'monthong128',
  tv_expires_at: null, tv_grant_notes: null, tv_days_remaining: 27,
}, overrides);

const pill = (d, name) => d.querySelector('.room-menu-pill[data-panel="' + name + '"]');
const panel = (d) => d.getElementById('room-panel');
const click = (window, el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const has = (d, s) => panel(d).textContent.indexOf(s) !== -1;

/* ========================================================================== */
(async function run() {
  console.log('Room tab content — วิธีการใช้งาน + ข้อมูลการใช้งาน (jsdom harness):');

  const ctx = { state: [sub({})] };
  const { document, window } = await boot(ctx);
  await waitFor(() => document.getElementById('tv-banner').classList.contains('show'));

  /* --- วิธีการใช้งาน (howto) --------------------------------------------- */
  await test('วิธีการใช้งาน renders the 4-step guide content', async () => {
    click(window, pill(document, 'howto'));
    await waitFor(() => panel(document).classList.contains('open') && has(document, 'Timeframe ที่รองรับ'));
    ['M5', 'M15', 'แม่น้ำสีแดง', 'แม่น้ำสีเขียว', '3s-Bull', '3s-Bear', 'Risk Level',
     'บทวิเคราะห์ทางเทคนิค', 'ไม่ใช่คำแนะนำการลงทุน'].forEach((needle) => {
      assert.ok(has(document, needle), 'howto panel must contain: ' + needle);
    });
  });

  await test('วิธีการใช้งาน keeps the compliance disclaimer at the end', () => {
    const disc = panel(document).querySelector('.rtab-disclaimer');
    assert.ok(disc, 'disclaimer box present');
    assert.ok(/ข้อตกลงการใช้งาน/.test(disc.textContent), 'disclaimer heading present');
    assert.ok(/ไม่ใช่คำแนะนำการลงทุน/.test(disc.textContent), 'investment-advice waiver present');
    // It must be the final child of the rtab wrapper.
    const wrap = panel(document).querySelector('.rtab');
    assert.strictEqual(wrap.lastElementChild, disc, 'disclaimer must be the last block');
  });

  /* --- ข้อมูลการใช้งาน (usage) ------------------------------------------- */
  await test('ข้อมูลการใช้งาน renders the cheat sheet + reference content', async () => {
    click(window, pill(document, 'usage'));
    await waitFor(() => panel(document).classList.contains('open') && has(document, 'Cheat Sheet'));
    assert.ok(has(document, 'Cheat Sheet') || has(document, 'สรุปย่อ'), 'cheat sheet header present');
    assert.ok(has(document, 'XAUUSD'), 'XAUUSD asset present');
    assert.ok(has(document, 'LINE @aurumai'), 'contact CTA present');
  });

  await test('ข้อมูลการใช้งาน FAQ uses ≥5 semantic <details> (first open)', () => {
    const details = panel(document).querySelectorAll('details.rtab-faq');
    assert.ok(details.length >= 5, 'at least 5 FAQ <details> items, got ' + details.length);
    assert.ok(details[0].hasAttribute('open'), 'first FAQ item open by default');
    details.forEach((d) => assert.ok(d.querySelector('summary'), 'each <details> has a <summary>'));
  });

  console.log('\n' + passed + ' test(s) passed.\n');
  process.exit(0);
})().catch((err) => {
  console.error('\n  ✗ ' + (err && err.message ? err.message : err) + '\n');
  process.exit(1);
});
