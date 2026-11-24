#!/usr/bin/env bash
# 把最近一个月的期权(25Δ skew)导出成 CSV 给外部分析用。现货 OHLC 已改读时现拉、不在库里(见 server/live/market)。
# 固定文件名、每天覆盖 —— 对家永远读同一路径,不堆历史快照。
set -euo pipefail

cd "$(dirname "$0")/.."
DB="data/mtv.db"
OUT="reports"
SINCE="$(date -v-1m +%Y-%m-%d 2>/dev/null || date -d '-1 month' +%Y-%m-%d)"  # macOS / Linux 都兼容
mkdir -p "$OUT"

sqlite3 -readonly -header -csv "$DB" \
  "SELECT * FROM option_snapshot_25delta WHERE snapshot_date >= '$SINCE'
   ORDER BY underlying, snapshot_date;" > "$OUT/options_25delta.csv"

echo "导出完成($SINCE 起): $OUT/options_25delta.csv"
