#!/usr/bin/env bash
# ============================================================================
# Banned-vocabulary guard for the Aurum Analysis surface.
#
# The room must never expose trading-desk jargon. This scans the user-facing
# deliverable files (HTML + SQL) and fails if any forbidden term appears.
#
# Scope: *.html at repo root + js/*.js + sql/*.sql. README.md and this script
# are NOT scanned (they legitimately reference the forbidden words to document
# them).
#
# Approved vocabulary only:
#   บทวิเคราะห์, มุมมองขาขึ้น/ขาลง, จุดสำคัญ, โซนเป้าหมาย, ระดับความเสี่ยง,
#   อัตราส่วน, ความเชื่อมั่น, อัตราความแม่นยำ, สมาชิก/analyst, ยืนยันแล้ว
# ============================================================================
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# Files to scan (only those that exist).
mapfile -t FILES < <(git ls-files '*.html' 'js/*.js' 'sql/*.sql')
if [ "${#FILES[@]}" -eq 0 ]; then
  echo "check-banned-vocab: no HTML/SQL files to scan."
  exit 0
fi

# Substring matches, case-insensitive (safe — these never appear inside an
# allowed word; note 'TradingView' does NOT contain 'trade').
SUBSTR='signal|trade|profit|stop loss|take profit|win rate'

# Thai terms (case is irrelevant).
THAI='สัญญาณ|เทรด|นักเทรด'

# Short / ambiguous tokens — word-bounded so they don't trip on substrings
# (e.g. 'slice', 'https', 'style', 'translate', 'android').
WORD='\bBUY\b|\bSELL\b|\bTP\b|\bSL\b|\bROI\b|\bMT5\b|\bentry\b|\bpips\b'

status=0
for f in "${FILES[@]}"; do
  if matches=$(grep -niE -e "$SUBSTR" -e "$THAI" -e "$WORD" "$f"); then
    echo "❌ Banned vocabulary found in $f:"
    echo "$matches" | sed 's/^/    /'
    status=1
  fi
done

if [ "$status" -ne 0 ]; then
  echo ""
  echo "Forbidden terms detected. Use approved analysis vocabulary only."
  echo "(signal/สัญญาณ, trade/เทรด, BUY/SELL, entry/TP/SL, ROI, profit, นักเทรด,"
  echo " MT5, Stop Loss, Take Profit, Win Rate, pips → use ระยะการเคลื่อนไหว)"
  exit 1
fi

echo "✅ No banned vocabulary found in: ${FILES[*]}"
