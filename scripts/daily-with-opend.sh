#!/usr/bin/env bash
# 一条龙:确保 headless OpenD 在跑 → 等 WebSocket 就绪 → 跑 daily job。**不杀 OpenD**:
# 起完留着常驻,供下次复用。OpenD 的启动命令由 .env 的 OPEND_CMD 提供
# (你的账号/登录参数因人而异,不硬编码)。
#
# 为何不收尾杀掉:headless OpenD 每次被 SIGTERM/KILL 都会喂长它的崩溃上报(crashpad)
# 循环,下次启动越来越慢直至超时(实测 3→9 分钟,得重启机器才能治)。所以常驻、只起一次。
#
# 行为:
#   - 若 OpenD 已在跑(WS 端口已监听)→ 直接跑 job(理想稳态:OpenD 由 launchd 常驻)。
#   - 否则用 OPEND_CMD 后台拉起 OpenD(nohup,脚本退出后继续活),等就绪 + 预热,跑 job,留着。
#   - 没配 OPEND_CMD 且 OpenD 没在跑 → 警告后照样跑 job(期权组会失败,BTC/VRP 组照常)。
set -euo pipefail

cd "$(dirname "$0")/.."

# 载入 .env(MOOMOO_WS_PORT / OPEND_CMD / OPEND_* 等)
if [[ -f .env ]]; then set -a; source .env; set +a; fi

HOST="${MOOMOO_WS_HOST:-127.0.0.1}"
PORT="${MOOMOO_WS_PORT:-33333}"
READY_TIMEOUT="${OPEND_READY_TIMEOUT:-60}"   # 等端口监听的最长秒数
WARMUP_SECS="${OPEND_WARMUP_SECS:-8}"        # 端口起来后,给 OpenD 登录 moomoo 账号的预热时间
                                             # ponytail: 固定预热,登录慢就调大 OPEND_WARMUP_SECS
LOG_DIR="data/logs"
mkdir -p "$LOG_DIR"

port_open() { nc -z "$HOST" "$PORT" 2>/dev/null; }

if port_open; then
  echo "OpenD 已在 $HOST:$PORT 运行,直接跑 job。"
elif [[ -n "${OPEND_CMD:-}" ]]; then
  echo "启动 OpenD(headless,起完常驻不杀)…"
  # exec 让后台进程直接 *是* OpenD,$! 即其 PID(仅用于启动期存活检测);
  # nohup 忽略 SIGHUP,脚本退出后 OpenD 成孤儿继续运行。
  nohup bash -c "exec $OPEND_CMD" >> "$LOG_DIR/opend.log" 2>&1 &
  OPEND_PID=$!

  echo "等待 OpenD WebSocket $HOST:$PORT 就绪(≤${READY_TIMEOUT}s)…"
  waited=0
  until port_open; do
    if ! kill -0 "$OPEND_PID" 2>/dev/null; then
      echo "OpenD 进程已退出,见 $LOG_DIR/opend.log" >&2; exit 1
    fi
    sleep 1; waited=$((waited + 1))
    if (( waited >= READY_TIMEOUT )); then
      echo "等 OpenD 端口超时($READY_TIMEOUT s),见 $LOG_DIR/opend.log" >&2; exit 1
    fi
  done
  echo "端口就绪,预热 ${WARMUP_SECS}s 等账号登录…"
  sleep "$WARMUP_SECS"
  # 预热期间 OpenD 可能(端口短暂监听后)又退出 —— 再确认一次还活着,
  # 否则别去跑注定失败的 job,直接报错让人察觉。
  if ! kill -0 "$OPEND_PID" 2>/dev/null; then
    echo "OpenD 在预热期间退出了,见 $LOG_DIR/opend.log" >&2; exit 1
  fi
else
  echo "警告:OpenD 未运行且未配置 OPEND_CMD,期权组会失败(BTC/VRP 仍会跑)。" >&2
fi

echo "跑 daily job…"
bun run job:daily

# 跑完导出最近一月的期权/现货 CSV 到 reports/(固定文件名,供外部分析读同一路径)。
echo "导出 CSV 报表…"
scripts/export-csv.sh
