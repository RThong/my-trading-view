#!/usr/bin/env bash
# 生成三个 launchd 定时任务 plist(股票 com.mtv.daily + 加密 com.mtv.crypto + 基本面 com.mtv.sec)并重载。
# 触发时间用数组维护:改下面的 HOURS(和 EQUITY_WEEKDAYS)后重跑本脚本即可,不用手改 plist。
set -euo pipefail

# ── 改这里即可 ────────────────────────────────────────────────────────────────
HOURS=(11 12 20 21 22)        # 触发小时(JST 本地时区);日频两个 job 共用
EQUITY_WEEKDAYS=(2 3 4 5 6)   # 股票 job 跑的星期(1=周一 … 7=周日);加密 job 天天跑(24/7)
# SEC 基本面 job:数据是季频,但**时效要日频** —— 公司交完 10-Q 到 companyfacts 吃进通常只隔一天,
# 每周才查一次会白等最多 6 天,把「转折发生」推迟到下一周才看见。天天查代价极小:
# job 先比 submissions 的 filed,没新申报就 no-op(几百 KB),多数天本来就该是空转。
SEC_HOURS=(13 19)             # 单独挑空档,别和日频那几个点撞;两个点兜「错过一次还有下次」
# ─────────────────────────────────────────────────────────────────────────────

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LA="$HOME/Library/LaunchAgents"
U="$(id -u)"

# 输出 StartCalendarInterval 的 <dict> 条目:$1=weekday(空=不带 Weekday,即天天)。
# 对 HOURS 里每个小时各出一条(整点)。
emit() {
  local wd="$1" h
  for h in "${HOURS[@]}"; do
    if [[ -n "$wd" ]]; then
      printf '        <dict><key>Weekday</key><integer>%s</integer><key>Hour</key><integer>%s</integer><key>Minute</key><integer>0</integer></dict>\n' "$wd" "$h"
    else
      printf '        <dict><key>Hour</key><integer>%s</integer><key>Minute</key><integer>0</integer></dict>\n' "$h"
    fi
  done
}
equity_intervals() { local wd; for wd in "${EQUITY_WEEKDAYS[@]}"; do emit "$wd"; done; }

cat > "$LA/com.mtv.daily.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.mtv.daily</string>
    <!-- 由 scripts/gen-cron.sh 生成,勿手改;改时间请改脚本里的 HOURS/EQUITY_WEEKDAYS 再重跑。
         股票组:EQUITY_WEEKDAYS × HOURS 触发。多触发兜「错过一次还有下次」;当天成功即止由
         daily.ts 守卫;睡眠中不跑、唤醒补跑最近一次错过的触发。 -->
    <key>StartCalendarInterval</key>
    <array>
$(equity_intervals)
    </array>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$ROOT/scripts/daily-with-opend.sh</string>
    </array>
    <key>WorkingDirectory</key><string>$ROOT</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin</string>
        <key>OPEND_READY_TIMEOUT</key><string>300</string>
    </dict>
    <key>StandardOutPath</key><string>$ROOT/data/logs/daily-cron.log</string>
    <key>StandardErrorPath</key><string>$ROOT/data/logs/daily-cron.log</string>
</dict>
</plist>
EOF

cat > "$LA/com.mtv.crypto.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.mtv.crypto</string>
    <!-- 由 scripts/gen-cron.sh 生成,勿手改。BTC 24/7:天天 × HOURS 触发(无 Weekday)。
         多触发 + cryptoDaily 守卫「当天成功即止」;睡眠中不跑、唤醒补跑。 -->
    <key>StartCalendarInterval</key>
    <array>
$(emit "")
    </array>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/bun</string>
        <string>run</string>
        <string>$ROOT/src/server/jobs/cryptoDaily.ts</string>
    </array>
    <key>WorkingDirectory</key><string>$ROOT</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin</string>
    </dict>
    <key>StandardOutPath</key><string>$ROOT/data/logs/crypto-cron.log</string>
    <key>StandardErrorPath</key><string>$ROOT/data/logs/crypto-cron.log</string>
</dict>
</plist>
EOF

cat > "$LA/com.mtv.sec.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.mtv.sec</string>
    <!-- 由 scripts/gen-cron.sh 生成,勿手改。AI 链基本面(SEC + TWSE 分源):天天 × SEC_HOURS 触发(无 Weekday)。
         数据是季频但时效要日频 —— 财报交上来次日就想拿到,每周一次会白等最多 6 天。
         job 自己先比 submissions 的 filed,没新申报就 no-op,不拉几 MB 的 companyfacts。
         需要 .env 里的 SEC_USER_AGENT(Bun 按 WorkingDirectory 自动加载 .env)。 -->
    <key>StartCalendarInterval</key>
    <array>
$(for h in "${SEC_HOURS[@]}"; do printf '        <dict><key>Hour</key><integer>%s</integer><key>Minute</key><integer>0</integer></dict>\n' "$h"; done)
    </array>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/bun</string>
        <string>run</string>
        <string>$ROOT/src/server/jobs/aiChainFundamentals.ts</string>
    </array>
    <key>WorkingDirectory</key><string>$ROOT</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin</string>
    </dict>
    <key>StandardOutPath</key><string>$ROOT/data/logs/sec-cron.log</string>
    <key>StandardErrorPath</key><string>$ROOT/data/logs/sec-cron.log</string>
</dict>
</plist>
EOF

for label in com.mtv.daily com.mtv.crypto com.mtv.sec; do
  plutil -lint "$LA/$label.plist"
  launchctl bootout "gui/$U/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$U" "$LA/$label.plist"
done
echo "已生成并重载 com.mtv.daily / com.mtv.crypto / com.mtv.sec,触发小时 = ${HOURS[*]}(股票星期 ${EQUITY_WEEKDAYS[*]};SEC 天天 ${SEC_HOURS[*]} 点)"
