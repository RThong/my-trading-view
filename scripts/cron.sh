#!/usr/bin/env bash
# 管理 com.mtv.daily 这个 launchd 定时任务的小帮手,省得记 launchctl 命令。
#   ./scripts/cron.sh status   看状态(在不在 / 上次退出码)
#   ./scripts/cron.sh run      立刻手动跑一次(测试用)
#   ./scripts/cron.sh reload   改完 plist 后重载生效
#   ./scripts/cron.sh logs     跟踪日志(Ctrl-C 退出)
#   ./scripts/cron.sh history [天数]  看最近 N 天运行记录(默认 2 天;每天每组只显示最终结果)
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
           # 须为正整数:≥1、无前导零(挡掉 0 → '--1 day' 静默空;挡掉 08/09 → $((d-1)) 八进制报错)。
           d="${2:-2}"; [[ "$d" =~ ^[1-9][0-9]*$ ]] || { echo "天数须为正整数(≥1,无前导零),实得: $d" >&2; exit 1; }
           # 最近 d 个本地日(含今天):d=2 → 今天+昨天。
           # 成功即止:一天里每个 job 可能跑多次(失败重试到成功),只显示每(本地日, job)
           # 的最后一次(run_id 最大)= 当天该组的最终结果,省得翻一堆失败尝试。
           sqlite3 -readonly -header -column "$DB" "
             SELECT datetime(started_at,'localtime') AS 本地时间, job_name AS 任务,
                    status AS 状态, records_written AS 写入, error_message AS 错误
             FROM job_run
             WHERE run_id IN (
               SELECT MAX(run_id) FROM job_run
               WHERE date(started_at,'localtime') >= date('now','localtime','-$((d-1)) day')
               GROUP BY date(started_at,'localtime'), job_name
             )
             ORDER BY started_at DESC, run_id DESC;" ;;
  on)      launchctl enable "$TARGET" && echo "已启用自动跑" ;;
  off)     launchctl disable "$TARGET" && echo "已关闭自动跑(重启也不会再跑)" ;;
  *)       echo "用法: $0 {status|run|reload|logs|history|on|off}" >&2; exit 1 ;;
esac
