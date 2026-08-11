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
#   - 没配 OPEND_CMD 且 OpenD 没在跑 → 警告后照样跑 job。
#   - **OpenD 起不来 / 起来后中途自退 / qot 会话始终不就绪 → 一律只告警,照样跑 job**。
#     任何一条路径都不 exit —— 一个 daemon 挂掉不该连坐掉不依赖它的抓取组。
#     实测踩过(2026-08-04):这里曾 `exit 1`,OpenD 连崩三天 → MOVE / AI CDS / eris /
#     VX / sox_fng 也停了三天,而 MOVE 是快照型、漏一天永久缺一格。
#     ⚠ 期权组与 sox_putcall 照旧会失败(两者都是快照型,当天不记就永久丢),本脚本救不了。
#       VRP 输入不失败:ETF 现货腿整体降级 Yahoo 后仍记 success(见 vrpInputs.ts)。
set -euo pipefail

cd "$(dirname "$0")/.."

# 载入 .env(MOOMOO_WS_PORT / OPEND_CMD / OPEND_* 等)
if [[ -f .env ]]; then set -a; source .env; set +a; fi

HOST="${MOOMOO_WS_HOST:-127.0.0.1}"
PORT="${MOOMOO_WS_PORT:-33333}"
READY_TIMEOUT="${OPEND_READY_TIMEOUT:-60}"        # 等端口监听的最长秒数
QOT_READY_TIMEOUT="${OPEND_QOT_READY_TIMEOUT:-60}" # 端口起来后,等行情(qot)会话真就绪的最长秒数
LOG_DIR="data/logs"
mkdir -p "$LOG_DIR"

port_open() { nc -z "$HOST" "$PORT" 2>/dev/null; }
# 端口开 ≠ 能取行情:trd 登录成功但 qot 会话可能悬空(memory opend-qot-session-drop),
# 老逻辑只探端口 + 固定 sleep 预热就跑,遇悬空会全标的静默降级 Yahoo。探真状态。
qot_ready() { bun run src/server/fetchers/moomooClient.ts >/dev/null 2>&1; }

# OPEND_PID:本轮由脚本亲自拉起的 OpenD 的 PID(用于启动期存活检测)。
# 预先在跑的 OpenD 走不进拉起分支,PID 保持空 —— 这正是"该不该自愈重启"的判据。
OPEND_PID=""

# 后台拉起 headless OpenD,等 WebSocket 端口就绪。成功返 0,进程早退/端口超时返 1。
launch_opend() {
  echo "启动 OpenD(headless,起完常驻不杀)…"
  # exec 让后台进程直接 *是* OpenD,$! 即其 PID;nohup 忽略 SIGHUP,脚本退出后 OpenD 成孤儿续活。
  nohup bash -c "exec $OPEND_CMD" >> "$LOG_DIR/opend.log" 2>&1 &
  OPEND_PID=$!

  echo "等待 OpenD WebSocket $HOST:$PORT 就绪(≤${READY_TIMEOUT}s)…"
  local waited=0
  until port_open; do
    if ! kill -0 "$OPEND_PID" 2>/dev/null; then
      echo "OpenD 进程已退出,见 $LOG_DIR/opend.log" >&2; return 1
    fi
    sleep 1; waited=$((waited + 1))
    if (( waited >= READY_TIMEOUT )); then
      echo "等 OpenD 端口超时($READY_TIMEOUT s),见 $LOG_DIR/opend.log" >&2; return 1
    fi
  done
}

# 杀掉在跑的 headless OpenD,确认端口关闭后再清脏 wal(旁文件残留会让下次启动即崩,
# memory opend-headless-crash)。⚠ kill 会喂 OpenD 的 crashpad 上报,只在确诊 qot 悬空时
# 调用、每轮至多一次。端口 15s 内没关 = 没杀干净:返回非 0,且**不删 wal**——OpenD 可能还活着,
# 删它的活库会损坏数据。调用方据此放弃本次重启(旧实例照旧,仅告警)。
kill_opend() {
  local pid w=0
  pid=$(pgrep -f 'MacOS/OpenD' | head -1 || true)
  [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
  while port_open && (( w < 15 )); do sleep 1; w=$((w + 1)); done
  if port_open; then
    echo "kill_opend:端口 $HOST:$PORT 15s 内未关闭,放弃自愈重启(不删 wal 以免误删活库)。" >&2
    return 1
  fi
  rm -f "$HOME/.com.moomoo.OpenD/F3CNN/SecListDB.dat-wal" \
        "$HOME/.com.moomoo.OpenD/F3CNN/SecListDB.dat-shm" 2>/dev/null || true
}

# 轮询 qot_ready 至就绪或超时(真实墙钟:每次探测要连 OpenD、可能耗十几秒,只累加 sleep 会
# 让实际轮询远超配置值)。返回:0=就绪,1=超时未就绪,2=自启 OpenD 中途死亡(硬错误)。
wait_qot() {
  echo "等 OpenD 行情会话(qot)就绪(≤${QOT_READY_TIMEOUT}s)…"
  SECONDS=0
  while (( SECONDS < QOT_READY_TIMEOUT )); do
    if qot_ready; then return 0; fi
    if [[ -n "$OPEND_PID" ]] && ! kill -0 "$OPEND_PID" 2>/dev/null; then return 2; fi
    sleep 3
  done
  # 超时兜底:最后一次 sleep 期间自启 OpenD 可能已死,再确认一次,别把"进程死"误报成普通超时。
  if [[ -n "$OPEND_PID" ]] && ! kill -0 "$OPEND_PID" 2>/dev/null; then return 2; fi
  return 1
}

if port_open; then
  echo "OpenD 已在 $HOST:$PORT 运行。"
elif [[ -n "${OPEND_CMD:-}" ]]; then
  # 起不来只告警,**不 exit** ——否则一个 daemon 起不来会连带停掉压根不需要 OpenD 的那几组
  # (MOVE / AI CDS / eris / VX 期限结构 / sox_fng —— 注意是 sox_fng 不是 sox_*)。实测踩过(2026-08-04):OpenD 连崩三天,
  # 这几组也跟着停了三天,而 MOVE 是快照型、漏一天永久缺一格(真丢了两天)。
  # ⚠ 期权组与 sox_putcall 照旧会失败 —— 本改动救不了它们(VRP 输入不失败,ETF 腿降级 Yahoo),
  # 而 sox_putcall 也是快照型(daily.ts:「put/call 是 OpenD 实时、当天不记就永久丢」)。
  # 与下面「没配 OPEND_CMD」那条路对齐。
  launch_opend || echo "警告:OpenD 起不来,期权 / sox_putcall 会失败,VRP 降级 Yahoo(其余组照跑)。" >&2
else
  echo "警告:OpenD 未运行且未配置 OPEND_CMD,期权 / sox_putcall 会失败,VRP 降级 Yahoo(其余组照跑)。" >&2
fi

# qot 就绪门:端口开着才探(没 OpenD 的场景直接跳过,让非行情组照跑)。
if port_open; then
  rc=0; wait_qot || rc=$?
  if (( rc == 0 )); then
    echo "qot 会话就绪。"
  elif (( rc == 2 )); then
    # OpenD 中途自退(事故形态:先开端口、约 30s 后退)。**只告警不 exit** —— 同 A1:
    # 期权组自己会记 failed,不该连坐掉 MOVE / AI CDS / eris / VX 期限结构 / sox_fng 那几组
    # (是 sox_fng —— sox_putcall 走 OpenD 实时,和期权组同命,救不了)。
    echo "警告:OpenD 进程已退出(见 $LOG_DIR/opend.log),期权 / sox_putcall 会失败,VRP 降级 Yahoo(其余组照跑)。" >&2
  elif [[ -z "$OPEND_PID" && -n "${OPEND_CMD:-}" ]]; then
    # 预先在跑的 OpenD 行情会话悬空(反复发作的老坑):受控重启一次自愈。
    # 只对"预先存在"的做 —— 本轮刚亲手拉起就不就绪,多半是账号/网络问题,再重启无益、徒增 crashpad。
    echo "qot 会话悬空,重启 OpenD 自愈(单次)…" >&2
    # kill_opend 失败(端口没关干净)→ 短路,不重启、不误删活库,旧实例照旧,告警继续。
    if kill_opend && launch_opend; then
      rc=0; wait_qot || rc=$?
      if (( rc == 0 )); then
        echo "重启后 qot 会话就绪。"
      elif (( rc == 2 )); then
        echo "警告:重启后 OpenD 又退出(见 $LOG_DIR/opend.log),期权 / sox_putcall 会失败,VRP 降级 Yahoo(其余组照跑)。" >&2
      else
        echo "警告:重启后 qot ${QOT_READY_TIMEOUT}s 仍未就绪,期权 / sox_putcall 会失败,VRP 降级 Yahoo。" >&2
      fi
    else
      echo "警告:自愈重启未完成(见上),期权 / sox_putcall 会失败,VRP 降级 Yahoo。" >&2
    fi
  else
    echo "警告:qot 会话 ${QOT_READY_TIMEOUT}s 未就绪(行情会话悬空),期权 / sox_putcall 会失败,VRP 降级 Yahoo。重启 OpenD 可修。" >&2
  fi
fi

echo "跑 daily job…"
bun run job:daily

# 跑完导出最近一月的期权/现货 CSV 到 reports/(固定文件名,供外部分析读同一路径)。
# ⚠ 兜住失败:本脚本 set -e,而 CSV 导出只是派生产物 —— 它挂掉不该让整轮显示为失败,
# 更不该挡住后面的备份(数据已落库,备份才是那一步里唯一不可补的)。同本文件其余各处的理由。
echo "导出 CSV 报表…"
scripts/export-csv.sh || echo "警告:CSV 导出失败(不影响已落库的数据),见上。" >&2

# 备份放在最后:要备的正是这一轮刚写进去的数据。
# 同样只告警不 exit —— 备份挂了不该让这一轮抓取显示为失败。iCloud 没登录 / 磁盘满属于这一类。
echo "备份数据库到 iCloud…"
scripts/backup-db.sh || echo "警告:数据库备份失败(数据已落库,只是这一份没备成),见上。" >&2
