#!/usr/bin/env bash
# 管理 com.mtv.daily 这个 launchd 定时任务的小帮手,省得记 launchctl 命令。
#   ./scripts/cron.sh status   看状态(在不在 / 上次退出码)
#   ./scripts/cron.sh run      立刻手动跑一次(测试用)
#   ./scripts/cron.sh reload   改完 plist 后重载生效
#   ./scripts/cron.sh logs     跟踪日志(Ctrl-C 退出)
#   ./scripts/cron.sh history  各品类一行:结果 + 最近运行时间 + 最近成功时间
#   ./scripts/cron.sh on|off   永久开启/关闭自动跑
set -euo pipefail

LABEL="com.mtv.daily"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$ROOT/data/logs/daily-cron.log"
DB="$ROOT/data/mtv.db"
TARGET="gui/$(id -u)/$LABEL"

case "${1:-status}" in
  status)  launchctl print "$TARGET" | grep -E 'state|last exit code|program' ;;
  run)     launchctl kickstart -k "$TARGET" && echo "已触发,看日志: $0 logs" ;;
  reload)  launchctl bootout "$TARGET" 2>/dev/null || true
           launchctl bootstrap "gui/$(id -u)" "$PLIST" && echo "已重载 $PLIST" ;;
  logs)    tail -f "$LOG" ;;
  history) [[ -f "$DB" ]] || { echo "数据库不存在: $DB(还没跑过 job?)" >&2; exit 1; }
           # 一类一行(跨全部历史去重):结果=最近一次运行的状态;两列时间——
           # 「最近运行」=该组最后一次跑的时刻(不论成败);「最近成功」=最后一次 success 的时刻
           # (从没成过显示 —)。失败时一眼看出「上次好的数据到哪一刻」。box 边框表格。
           sqlite3 -readonly -box "$DB" "
             SELECT
               CASE last.job_name
                 WHEN 'options'           THEN '美股期权'
                 WHEN 'options_crypto'    THEN 'BTC 期权'
                 WHEN 'vrp_inputs'        THEN 'VRP 输入'
                 WHEN 'vx_term_structure' THEN 'VX 期限结构'
                 WHEN 'btc_price'         THEN 'BTC 现货'
                 ELSE last.job_name
               END AS 品类,
               CASE last.status WHEN 'success' THEN '✅' WHEN 'partial' THEN '⚠️' ELSE '❌' END AS 结果,
               datetime(last.started_at,'localtime') AS 最近运行,
               COALESCE(datetime(succ.t,'localtime'), '—') AS 最近成功
             FROM (
               SELECT job_name, started_at, status FROM job_run
               WHERE run_id IN (SELECT MAX(run_id) FROM job_run GROUP BY job_name)
             ) last
             LEFT JOIN (
               SELECT job_name, MAX(started_at) t FROM job_run WHERE status='success' GROUP BY job_name
             ) succ ON succ.job_name = last.job_name
             ORDER BY last.started_at DESC;" ;;
  on)      launchctl enable "$TARGET" && echo "已启用自动跑" ;;
  off)     launchctl disable "$TARGET" && echo "已关闭自动跑(重启也不会再跑)" ;;
  *)       echo "用法: $0 {status|run|reload|logs|history|on|off}" >&2; exit 1 ;;
esac
