#!/usr/bin/env bash
# launchd 任务的前置门:等网络真通了再 exec 实际命令。
#
# 为何需要:合盖睡眠时 macOS 每 ~1h 做一次 maintenance DarkWake(约 45 秒,关了 Power Nap 也有),
# launchd 会在这 45 秒里补跑错过的触发,但此时没网(getaddrinfo ENOTFOUND)——补跑名额被烧掉,
# 掀盖后不再重跑。实测 2026-09-28 起 com.mtv.sec 的 13/19 两点几乎天天这样失败。
#
# 睡眠时进程被冻结、唤醒后接着等,所以这里不设上限:等到真正唤醒联网那一刻再跑。
# ponytail: 不设超时,机器连续几天没网就一直挂着;launchd 不会对同一 label 起第二个实例,不会堆积。
set -euo pipefail

# captive.apple.com 是 macOS 自己判联网用的探针。认响应正文里的 Success,不认 curl 退出码:
# 门户登录页 / 重定向 / 4xx 也会让 curl 返回 0。
until [[ "$(/usr/bin/curl -s -m 10 http://captive.apple.com/hotspot-detect.html || true)" == *Success* ]]; do
  [[ -n "${announced:-}" ]] || { echo "$(date '+%F %T') 网络未就绪,等待中…"; announced=1; }
  sleep 60
done
[[ -z "${announced:-}" ]] || echo "$(date '+%F %T') 网络已就绪,开跑。"

exec "$@"
