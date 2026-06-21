#!/usr/bin/env bash
# 一条龙:headless 启动 OpenD → 等 WebSocket 就绪 → 跑 daily job → 收尾杀掉 OpenD。
# 这样不用单独开 OpenD GUI。OpenD 的启动命令由 .env 的 OPEND_CMD 提供
# (你的账号/登录参数因人而异,不硬编码)。
#
# 行为:
#   - 若 OpenD 已在跑(WS 端口已监听,比如你开着 GUI)→ 不启动也不杀,直接跑 job。
#   - 否则用 OPEND_CMD 后台拉起 OpenD,等端口就绪 + 预热,跑完 job 再杀掉(只杀自己起的)。
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

OPEND_PID=""
cleanup() {
  if [[ -n "$OPEND_PID" ]] && kill -0 "$OPEND_PID" 2>/dev/null; then
    echo "停止 OpenD (pid $OPEND_PID)…"
    kill "$OPEND_PID" 2>/dev/null || true
    for _ in 1 2 3; do kill -0 "$OPEND_PID" 2>/dev/null || break; sleep 1; done
    kill -9 "$OPEND_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

if port_open; then
  echo "OpenD 已在 $HOST:$PORT 运行,直接跑 job(不接管、不杀)。"
elif [[ -n "${OPEND_CMD:-}" ]]; then
  echo "启动 OpenD(headless)…"
  # exec 让后台进程直接 *是* OpenD,$! 即其 PID,收尾时能精确杀掉。
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
