/* ============================================================================
 * Banned-vocabulary guard (Node mirror of scripts/check-banned-vocab.sh).
 *
 * The customer-facing room must never expose trading-desk jargon. This scans
 * the user-facing deliverable files and fails if any forbidden term appears, so
 * the check can run as part of `npm test` (the shell script remains the CI
 * gate). README.md and the guards themselves are intentionally NOT scanned.
 *
 * Plain `node test/banned-vocab.test.js` — exits non-zero on the first hit.
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Same scope as the shell guard: root *.html + js/*.js + sql/*.sql.
function listFiles() {
  const out = [];
  for (const f of fs.readdirSync(ROOT)) {
    if (f.endsWith('.html')) out.push(f);
  }
  for (const dir of ['js', 'sql']) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    const ext = dir === 'js' ? '.js' : '.sql';
    for (const f of fs.readdirSync(abs)) {
      if (f.endsWith(ext)) out.push(path.join(dir, f));
    }
  }
  return out;
}

// Substring matches, case-insensitive (these never appear inside an allowed
// word; note 'TradingView' does NOT contain 'trade').
const SUBSTR = /signal|trade|profit|stop loss|take profit|win rate/i;
// Thai terms.
const THAI = /สัญญาณ|เทรด|นักเทรด/;
// Short / ambiguous tokens — word-bounded so they don't trip on substrings.
const WORD = /\bBUY\b|\bSELL\b|\bTP\b|\bSL\b|\bROI\b|\bMT5\b|\bentry\b|\bpips\b/;

let failed = false;
for (const rel of listFiles()) {
  const lines = fs.readFileSync(path.join(ROOT, rel), 'utf8').split(/\r?\n/);
  const hits = [];
  lines.forEach((line, i) => {
    if (SUBSTR.test(line) || THAI.test(line) || WORD.test(line)) {
      hits.push((i + 1) + ': ' + line.trim());
    }
  });
  if (hits.length) {
    failed = true;
    console.error('❌ Banned vocabulary found in ' + rel + ':');
    hits.forEach((h) => console.error('    ' + h));
  }
}

if (failed) {
  console.error('\nForbidden terms detected. Use approved analysis vocabulary only.');
  process.exit(1);
}

console.log('✅ No banned vocabulary found (' + listFiles().join(', ') + ').');
