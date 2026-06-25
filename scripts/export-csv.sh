#!/usr/bin/env bash
# 把最近一个月的期权(25Δ skew)+ 现货(EOD OHLC)导出成 CSV 给外部分析用。
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

sqlite3 -readonly -header -csv "$DB" \
  "SELECT * FROM price_eod WHERE obs_date >= '$SINCE'
   ORDER BY underlying, obs_date;" > "$OUT/price_eod.csv"

echo "导出完成($SINCE 起): $OUT/options_25delta.csv, $OUT/price_eod.csv"
