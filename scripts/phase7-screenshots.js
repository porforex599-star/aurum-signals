/* Dev tool — render room.html in headless Chromium with the access gate and
 * Supabase feed stubbed, then capture the Phase 7 screenshots. NOT part of CI.
 *
 * Prereqs (the Tailwind Play CDN 403s through the sandbox proxy, so utilities
 * are compiled locally and injected):
 *   npm install --no-save puppeteer tailwindcss@3
 *   npx tailwindcss -i <(printf '@tailwind base;@tailwind components;@tailwind utilities;') \
 *     --content room.html -o scripts/.tailwind-screenshot.css --minify \
 *     # using a config that mirrors the inline tailwind.config in room.html
 *   node scripts/phase7-screenshots.js
 *
 * Chromium here sits behind a proxy with a custom CA, hence --ignore-certificate-errors.
 */
'use strict';
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const ROOM = 'file://' + path.join(__dirname, '..', 'room.html');
const OUT = path.join(__dirname, '..', 'docs', 'screenshots', 'phase7');
// The Tailwind Play CDN 403s through this sandbox's proxy, so we compile the
// page's utilities locally (see the npm tailwindcss CLI step) and inject them.
const TW_CSS = fs.readFileSync(path.join(__dirname, '.tailwind-screenshot.css'), 'utf8');

// A self-contained gold-themed candlestick PNG stand-in (SVG data URI) so the
// inline image + modal render a real picture without hitting chart-img.com.
function chartSvg(symbol, bias) {
  const up = bias === 'bullish';
  const candle = (x, o, c, hi, lo, green) => {
    const col = green ? '#22c55e' : '#ef4444';
    const top = Math.min(o, c), h = Math.max(2, Math.abs(o - c));
    return `<line x1="${x + 6}" y1="${hi}" x2="${x + 6}" y2="${lo}" stroke="${col}" stroke-width="1.5"/>`
      + `<rect x="${x}" y="${top}" width="12" height="${h}" fill="${col}"/>`;
  };
  let bars = '';
  let y = up ? 360 : 180;
  for (let i = 0; i < 24; i++) {
    const green = Math.random() > (up ? 0.38 : 0.62);
    const o = y, c = y + (green ? -22 - Math.random() * 18 : 22 + Math.random() * 18);
    bars += candle(60 + i * 34, o, c, Math.min(o, c) - 14, Math.max(o, c) + 14, green);
    y = Math.max(120, Math.min(440, c));
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="620" viewBox="0 0 1200 620">
    <rect width="1200" height="620" fill="#0a0420"/>
    <g stroke="rgba(212,175,55,0.08)" stroke-width="1">
      ${[140, 240, 340, 440, 540].map((gy) => `<line x1="40" y1="${gy}" x2="1160" y2="${gy}"/>`).join('')}
    </g>
    <line x1="40" y1="300" x2="1160" y2="300" stroke="#d4af37" stroke-width="2" stroke-dasharray="8 6"/>
    <text x="48" y="292" fill="#d4af37" font-family="monospace" font-size="18">จุดสำคัญ 2400.00</text>
    <line x1="40" y1="470" x2="1160" y2="470" stroke="#ef4444" stroke-width="2" stroke-dasharray="8 6"/>
    ${bars}
    <text x="40" y="48" fill="#e7c66e" font-family="monospace" font-size="30" font-weight="700">${symbol} · M15</text>
    <text x="40" y="78" fill="#7a6f99" font-family="monospace" font-size="16">TradingView shared layout · uoSX32t7</text>
    <text x="960" y="600" fill="#8b7029" font-family="serif" font-style="italic" font-size="20">AURUM ANALYSIS</text>
  </svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

function makeRow(id, symbol, bias, withImg, secAgo) {
  return {
    id, symbol, timeframe: 'M15', bias,
    candles: [], target_zones: [{ price: 2415 }, { price: 2430 }], sd_zones: [], pattern_markers: [],
    confidence: bias === 'bullish' ? 88 : 72, key_level: 2400, invalidation_price: 2388, rr_ratio: 2.4,
    risk_level: 'medium', note: 'ราคาเคลื่อนไหวเหนือจุดสำคัญ โซนเป้าหมายถัดไปอยู่บริเวณแนวต้านสำคัญ',
    created_at: new Date(Date.now() - (secAgo || 0) * 1000).toISOString(),
    chart_image_url: withImg ? chartSvg(symbol, bias) : null,
    chart_image_generated_at: withImg ? new Date().toISOString() : null,
  };
}

function installStubs(rows) {
  // Runs in the page before any document script — define the Supabase + fetch
  // stubs the gate and feed expect. (The supabase-js CDN script is blocked via
  // request interception so it can't overwrite this.)
  window.__ROWS__ = rows;
  function client() {
    return {
      auth: {
        getSession: async () => ({ data: { session: { access_token: 't', user: { email: 'demo@aurum' } } } }),
        signOut: async () => ({}),
      },
      from() {
        const qb = { _n: false, select() { return qb; }, order() { return qb; },
          not() { qb._n = true; return qb; },
          async limit() { return { data: qb._n ? window.__ROWS__.filter((r) => r.chart_image_url != null) : window.__ROWS__.slice(), error: null }; } };
        return qb;
      },
      channel() { const c = { on() { return c; }, subscribe() { return c; } }; return c; },
    };
  }
  window.supabase = { createClient: client };
  window.fetch = async () => ({ ok: true, json: async () => ({ subscriptions: [{ product_type: 'aurum_analysis', status: 'active', expires_at: new Date(Date.now() + 30 * 864e5).toISOString() }] }) });
}

async function newPage(browser, rows, viewport) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = req.url();
    if (u.includes('supabase-js') || u.includes('lightweight-charts') || u.includes('cdn.tailwindcss.com')) return req.abort();
    return req.continue();
  });
  await page.evaluateOnNewDocument(installStubs, rows);
  await page.goto(ROOM, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.addStyleTag({ content: TW_CSS });
  return page;
}

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors', '--force-color-profile=srgb'],
  });

  const twoPosts = [makeRow('p1', 'XAUUSD', 'bullish', true, 30), makeRow('p2', 'EURUSD', 'bearish', true, 240)];

  // 1 + 2 — room with 2 posts visible + inline chart in the detail pane.
  let page = await newPage(browser, twoPosts, { width: 1340, height: 860 });
  await page.waitForSelector('#inline-chart-img:not(.hidden)', { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 600));
  await page.screenshot({ path: path.join(OUT, 'room-two-posts.png') });
  console.log('✓ room-two-posts.png');
  await page.screenshot({ path: path.join(OUT, 'detail-inline-chart.png'), clip: { x: 470, y: 96, width: 860, height: 760 } });
  console.log('✓ detail-inline-chart.png');

  // 3 — modal opened by clicking the inline image.
  await page.click('#inline-chart-img');
  await page.waitForSelector('#chart-modal.open', { timeout: 5000 });
  await page.waitForSelector('#chart-modal-img:not(.hidden)', { timeout: 5000 });
  await new Promise((r) => setTimeout(r, 400));
  await page.screenshot({ path: path.join(OUT, 'modal-from-inline-click.png') });
  console.log('✓ modal-from-inline-click.png');
  await page.close();

  // 4 — empty state (no post has a chart image).
  const noCharts = [makeRow('q1', 'XAUUSD', 'bullish', false, 30), makeRow('q2', 'EURUSD', 'bearish', false, 90)];
  page = await newPage(browser, noCharts, { width: 1340, height: 860 });
  await page.waitForFunction(() => document.getElementById('list') && document.getElementById('list').textContent.includes('ยังไม่มีบทวิเคราะห์'), { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 400));
  await page.screenshot({ path: path.join(OUT, 'empty-state.png') });
  console.log('✓ empty-state.png');
  await page.close();

  // 5 — mobile responsive (inline image fills width minus padding).
  page = await newPage(browser, twoPosts, { width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.waitForSelector('#tab-detail', { timeout: 15000 });
  await page.click('#tab-detail');
  await page.waitForSelector('#inline-chart-img:not(.hidden)', { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 500));
  await page.screenshot({ path: path.join(OUT, 'mobile-inline-chart.png') });
  console.log('✓ mobile-inline-chart.png');
  await page.close();

  await browser.close();
  console.log('\nAll Phase 7 screenshots written to', OUT);
})().catch((e) => { console.error(e); process.exit(1); });
