#!/usr/bin/env bash
# 管理 com.mtv.daily 这个 launchd 定时任务的小帮手,省得记 launchctl 命令。
#   ./scripts/cron.sh status   看状态(在不在 / 上次退出码)
#   ./scripts/cron.sh run      立刻手动跑一次(测试用)
#   ./scripts/cron.sh reload   改完 plist 后重载生效
#   ./scripts/cron.sh logs     跟踪日志(Ctrl-C 退出)
#   ./scripts/cron.sh history  看历次运行记录(从 SQLite job_run 表,带本地时间/状态)
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
           n="${2:-30}"; [[ "$n" =~ ^[0-9]+$ ]] || { echo "条数须为正整数,实得: $n" >&2; exit 1; }
           sqlite3 -readonly -header -column "$DB" "
             SELECT datetime(started_at,'localtime') AS 本地时间, job_name AS 任务,
                    status AS 状态, records_written AS 写入, error_message AS 错误
             FROM job_run ORDER BY started_at DESC, run_id DESC LIMIT $n;" ;;
  on)      launchctl enable "$TARGET" && echo "已启用自动跑" ;;
  off)     launchctl disable "$TARGET" && echo "已关闭自动跑(重启也不会再跑)" ;;
  *)       echo "用法: $0 {status|run|reload|logs|history|on|off}" >&2; exit 1 ;;
esac
