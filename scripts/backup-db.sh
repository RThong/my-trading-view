#!/usr/bin/env bash
# 把 data/mtv.db 备份到 iCloud Drive(带日期、压缩、日+周两级轮转)。
#
# 为什么需要:库里有**不可再生**的快照型数据 —— 期权链、ICE CDS、MOVE、TWSE 月营收
# 都是"当天不抓就永久缺一格"的源,丢了补不回来(可回填的 SEC/FRED/CBOE 反倒不怕)。
#
# 为什么是 iCloud 而不是 git:压缩后约 5MB/份,进 git 历史 ≈ 1.3GB/年**且永久删不掉**
# (gzip 过的二进制几乎无法 delta 压缩,每份全量存一遍);而且本仓库是公开的,
# 库里有券商/交易所的批量数据,再分发条款是另一回事。iCloud 天然私有、零配置、异地。
#
# 为什么要留很多份、按日期分文件:**真正要防的不是磁盘挂**(那只需最新一份),
# 是「增量刷新静默污染了历史」这类逻辑损坏 —— 它可能几周后才被发现,靠磁盘冗余救不了,
# 只能回滚到污染之前那一天。所以回滚窗口必须长于"发现延迟":
#   · 最近 14 天逐日(刚出的问题精确回滚)
#   · 再往前 12 周每周一份(几周后才发现的,还有得救)
# 共 26 份约 138MB,窗口约 3 个月。
set -euo pipefail

cd "$(dirname "$0")/.."

ICLOUD_ROOT="$HOME/Library/Mobile Documents/com~apple~CloudDocs"
DEST="${MTV_BACKUP_DIR:-$ICLOUD_ROOT/mtv-backups}"
KEEP_DAILY="${MTV_BACKUP_KEEP:-14}"
KEEP_WEEKLY="${MTV_BACKUP_KEEP_WEEKLY:-12}"
SRC="data/mtv.db"

[[ -f "$SRC" ]] || { echo "找不到 $SRC" >&2; exit 1; }

# 份数必须是正整数:轮转用 `tail -n +$((KEEP+1))`,KEEP=0 会退化成 `tail -n +1` =
# **吐出全部文件然后删光**,包括刚生成的这一份。一个手滑的环境变量不该能清空所有备份。
for n in "$KEEP_DAILY" "$KEEP_WEEKLY"; do
  [[ "$n" =~ ^[1-9][0-9]*$ ]] || { echo "保留份数必须是正整数,得到:$n" >&2; exit 1; }
done

# iCloud 没启用时 $ICLOUD_ROOT 不存在,而 `mkdir -p` 会**默默建一个普通本地目录**,
# 然后一切照常报成功 —— 备份就不异地了,而且没人会发现。所以先确认容器真的在。
# (只对默认位置查;MTV_BACKUP_DIR 指到别处是测试/临时备份,不适用。)
if [[ "$DEST" == "$ICLOUD_ROOT"* && ! -d "$ICLOUD_ROOT" ]]; then
  echo "iCloud Drive 未启用($ICLOUD_ROOT 不存在),拒绝备份到一个只在本机的目录。" >&2
  echo "要么打开 iCloud Drive,要么用 MTV_BACKUP_DIR 显式指定位置。" >&2
  exit 1
fi
mkdir -p "$DEST"

stamp=$(date +%F)
out="$DEST/mtv-$stamp.db.gz"

# 短路:com.mtv.daily 一天触发五次(11/12/20/21/22),而多数轮次库根本没写入
# (daily.ts 有"当天已成功就跳过抓取"的守卫)。库不比今天这份新 = 这一轮没写进新东西,
# 再备一遍只是白跑 VACUUM 并让 iCloud 重传整整 5MB。库一被写 mtime 就变新,自然会重备。
if [[ -f "$out" && "$out" -nt "$SRC" ]]; then
  echo "库自上次备份后未变动,跳过($out)"
  exit 0
fi

# 中间的**未压缩**库落本地临时目录,不落 iCloud —— 那 14MB 会被同步一遍再删掉,白跑流量。
# 用 mktemp -d 而不是 mktemp:VACUUM INTO 要求目标不存在,建目录再拼文件名直接满足,
# 不用"先建文件再删掉"那一步(那中间还有个别人抢建同名文件的窗口)。
tmpd="$(mktemp -d)"
trap 'rm -rf "$tmpd"; rm -f "$DEST"/.mtv-*."$$".partial.gz' EXIT

# VACUUM INTO 而不是 cp:cp 会漏掉 WAL 里**已提交但未 checkpoint** 的事务,
# 并发写入时还可能拷到撕裂状态。VACUUM INTO 走读事务,产出的是自洽的新库。
#
# busy_timeout 必须显式设:sqlite3 CLI **默认没有 busy handler**,撞锁就 0 秒返回
# "database is locked"。而 com.mtv.daily / com.mtv.crypto / com.mtv.sec 是同点触发的独立 job,
# 撞锁是常态 —— 这条约定与理由(实测见过 SQLITE_BUSY_RECOVERY)写在 storage/db.ts:12。
# >/dev/null:PRAGMA 会把设定值回显到 stdout,污染日志(错误仍走 stderr,不会被吞)。
sqlite3 "$SRC" "PRAGMA busy_timeout = 30000; VACUUM INTO '$tmpd/db'" >/dev/null

# 验快照。**两条都要**,各管一半:
#  · integrity_check 查结构 —— 但它对"结构完好但内容是空的"照样返回 ok(0 字节的库也 ok)。
#  · 行数对源库比对 —— 这条才真正兑现"验证过可恢复":空库、截断、VACUUM 半途死都会被它抓住。
if [[ "$(sqlite3 "$tmpd/db" 'PRAGMA integrity_check;' | head -1)" != "ok" ]]; then
  echo "快照结构校验失败,已丢弃(原库可能已损坏,先查 $SRC)" >&2
  exit 1
fi
src_rows=$(sqlite3 "$SRC" 'SELECT COUNT(*) FROM market_series;')
bak_rows=$(sqlite3 "$tmpd/db" 'SELECT COUNT(*) FROM market_series;')
if [[ "$bak_rows" -eq 0 || "$bak_rows" -ne "$src_rows" ]]; then
  echo "快照内容校验失败(market_series 源 $src_rows 行 / 备份 $bak_rows 行),已丢弃" >&2
  exit 1
fi

# 压缩件的暂存必须和最终位置**同一个文件系统**,否则最后那步 mv 是跨盘拷贝、不原子。
# 带 $$ 是为了两个实例并撞时各写各的,不用加锁(最后 rename 谁赢都是一份完整的)。
# 落位一律走"写 .partial → gzip -t 复验 → 同盘 mv":磁盘满 / 配额不足 / 进程被杀都会留下
# **看着正常的残缺 .gz**,而 gzip -t 校验整条流的 CRC 能抓到截断。上面已证解压后的内容是好的,
# 所以 CRC 通过 = 可恢复。mv 是原子 rename → 要么还是上次验过的那份,要么是这次验过的这份,
# **不存在中间态**(同日重跑因此安全:旧的一直有效,直到新的验完)。
publish() { # $1 = 源文件(未压缩库) $2 = 最终路径
  local part="$DEST/.mtv-$stamp.$$.partial.gz"
  gzip -6 -c "$1" > "$part"
  gzip -t "$part"
  mv -f "$part" "$2"
}

publish "$tmpd/db" "$out"

# 周备:本周还没有(或有但是坏的)就再落一份。用 ISO 周号命名,所以"这周备过没"是一次
# 文件判断,不用记状态。
# ⚠ 走同一个 publish 而不是 `cp "$out" "$weekly"` —— 周备是**保留最久的那批**(几周后才发现
# 污染时唯一能救的),一次写坏就驻留 12 周,和日备一样必须验过再落位。
# ⚠ 判据是"存在**且解得开**"而不是只判存在:只判存在的话,任何来源的坏周备(旧版脚本留下的、
#   同步中断的、外部损坏的)都会让这一周**永远不再重试**,而它还会被下面统计成一份有效周备。
weekly="$DEST/mtv-w-$(date +%G-W%V).db.gz"
if [[ ! -f "$weekly" ]] || ! gzip -t "$weekly" 2>/dev/null; then
  publish "$tmpd/db" "$weekly"
fi

# 两级各自轮转。glob 必须分开:`mtv-*` 会同时吃到周备。
# 日备 `mtv-20…`(日期以 20 开头),周备 `mtv-w-…`。
prune() { ls -1t "$DEST"/$1 2>/dev/null | tail -n +$(($2 + 1)) | while IFS= read -r old; do rm -f "$old"; done; }
prune 'mtv-20*.db.gz' "$KEEP_DAILY"
prune 'mtv-w-*.db.gz' "$KEEP_WEEKLY"

echo "备份完成:$out ($(du -h "$out" | cut -f1),market_series $bak_rows 行)"
echo "现有 日备 $(ls -1 "$DEST"/mtv-20*.db.gz 2>/dev/null | wc -l | tr -d ' ')/$KEEP_DAILY,周备 $(ls -1 "$DEST"/mtv-w-*.db.gz 2>/dev/null | wc -l | tr -d ' ')/$KEEP_WEEKLY"

# ── 怎么恢复(写在这里是因为要用到它的时候没人想去翻文档)────────────────────────
#   路径写死不用变量 —— 你在终端里没有这个脚本的变量。
#   1. 先停掉在写库的东西:
#        launchctl unload ~/Library/LaunchAgents/com.mtv.daily.plist
#        launchctl unload ~/Library/LaunchAgents/com.mtv.sec.plist
#        launchctl unload ~/Library/LaunchAgents/com.mtv.crypto.plist
#   2. 挑一份、解压到一边先验,**别直接盖**:
#        ls -1t ~/Library/Mobile\ Documents/com~apple~CloudDocs/mtv-backups/
#        gzip -dc ~/Library/Mobile\ Documents/com~apple~CloudDocs/mtv-backups/mtv-2026-08-11.db.gz > /tmp/restore.db
#        sqlite3 /tmp/restore.db "PRAGMA integrity_check;"                # 必须是 ok
#        sqlite3 /tmp/restore.db "SELECT COUNT(*) FROM market_series;"    # 眼看一下量级对不对
#   3. 把现库挪开(别删,万一恢复的那份更差):
#        cd ~/projects/my-trading-view
#        mv data/mtv.db data/mtv.db.bad
#        mv data/mtv.db-wal data/mtv.db.bad-wal 2>/dev/null || true   # ⚠ 跟着挪,别删
#        rm -f data/mtv.db-shm                                        # -shm 可删,会重建
#      ⚠ **-wal 千万别 rm**:库是 WAL 模式,-wal 里装的正是已提交但未 checkpoint 的事务
#        (就是本脚本用 VACUUM INTO 而非 cp 的同一个理由)。删了 mtv.db.bad 就永久少掉
#        最后一段数据 —— 而那段里可能正是当天不可再生的期权链 / CDS / MOVE。
#   4. mv /tmp/restore.db data/mtv.db,再把上面三个 launchctl load 回来。
#   ⚠ 恢复回来的是那天的快照 —— 之后的快照型数据(期权链 / CDS / MOVE / TWSE 月营收)
#     补不回来;可回填的(SEC / FRED / CBOE)重跑 job 就会自己追上。
