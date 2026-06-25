# 加密(BTC)期权抓取从美股周历解耦 设计

日期:2026-06-25
状态:待实现

## 背景与问题

BTC 24/7 交易,但当前它和美股期权挤在同一个 daily job 里,共用美股的打戳口径:
- BTC(Deribit)未实现 `getTradingDate()` → 回退 `lastClosedTradingDate()`,该函数**只跳周末、不认假期**,把周末快照都按到上一个周五。
- 加上任务在 08:00 JST(= 前一天 19:00 ET / 23:00 UTC)跑 + 「当天成功即止」守卫 + Tue–Sat 调度,BTC 周末永远拿不到独立的点(实测 06-20/06-21 无 BTC 行)。

根因:**用美股周历给一个 24/7 资产打戳 + 用美股调度跑它**。光改打戳不够,必须把加密组从美股那套节奏里解耦。

## 方案:加密组独立 job + 独立 7 天调度 + UTC 日打戳

### 1. Deribit client 实现 `getTradingDate()`

`src/server/fetchers/deribitOptions.ts` 的 client 增加 `getTradingDate()`,返回**当前 UTC 日**(`new Date().toISOString().slice(0, 10)`),不跳周末、不认假期。

`runOptionsSnapshot` 已有钩子 `(await client.getTradingDate?.()) ?? lastClosedTradingDate()`,所以实现后 BTC 自动按 UTC 日打戳,无需改 optionsSnapshot。

口径:在 JST 早上跑时,UTC 日 = 前一日,标的是该 Deribit「当日(UTC)live chain」,标 UTC 日正确;连续每天跑 → 连续 UTC 日期,**含周末,无缺口**。

### 2. 加密组从主 daily job 移出

- `src/server/jobs/daily.ts` 的 **CLI 入口**不再传 `cryptoOptionsUnderlyings/cryptoOptionsClient`;主 job 退回 3 组(options / vrp_inputs / vx_term_structure)。
- `REQUIRED_JOBS` 去掉 `'options_crypto'` → `['options', 'vrp_inputs', 'vx_term_structure']`。
- `runDailyJob` 函数**本身不动**(仍支持注入式 crypto 参数,只是股票 CLI 不再传);加密 job 复用它。

### 3. 新建独立加密 job 入口

`src/server/jobs/cryptoDaily.ts`:
- CLI 入口复用 `runDailyJob({ db, cryptoOptionsUnderlyings: DERIBIT_UNDERLYINGS, cryptoOptionsClient: defaultDeribitOptionsClient() })` —— 只跑 `options_crypto` 这一组。
- 自带「当天成功即止」守卫:`getTodaySucceededJobs(db)` 含 `'options_crypto'` 则跳过本次。守卫只看这一组,**与股票组完全独立**——周末跑时不会因股票组无数据而误判失败。
- Deribit 公开 REST、**无 OpenD 依赖**,直接 `bun run`,不走 `daily-with-opend.sh`。
- `import.meta.main`:openDb → migrate → 守卫 → runDailyJob → close。

### 4. 新建独立 launchd 调度 `com.mtv.crypto`

- `~/Library/LaunchAgents/com.mtv.crypto.plist`:`StartCalendarInterval` 数组 5 条,**只有 Hour(08/11/14/17/20)、无 Weekday** → **每天**触发(7 天)。
- `ProgramArguments`: `/opt/homebrew/bin/bun run /Users/hong/projects/my-trading-view/src/server/jobs/cryptoDaily.ts`(无 wrapper)。
- `WorkingDirectory`、`EnvironmentVariables.PATH` 同 com.mtv.daily。
- 日志:`data/logs/crypto-cron.log`(与股票 job 分开)。
- 行为:多触发 + 守卫 = 当天 BTC 抓成一次即止;某次没网 → 后续触发补;睡眠唤醒补跑最近一次。

## 不做(YAGNI)

- **不回填历史周末 BTC**:Deribit 期权链是快照型、无历史,过去丢的周末点补不回来,只修将来。
- **不动 cron.sh**(它管 com.mtv.daily);加密 plist 暂时手动管理或后续再扩 cron.sh 接受 label。
- 不改 VIX 现货(moomoo 实测取不到指数,保持 CBOE,见另一讨论)。

## 测试

- `deribitOptions` 的 `getTradingDate()`:返回值匹配 `^\d{4}-\d{2}-\d{2}$` 且等于当前 UTC 日(`new Date().toISOString().slice(0,10)`)。
- 打戳贯通:给 `runOptionsSnapshot` 注入一个 `getTradingDate` 返回固定 UTC 日的 fake crypto client,断言落库的 `snapshot_date` = 该 UTC 日(而非 `lastClosedTradingDate`)。
- 主 job:`daily.test.ts` 确认 CLI 不再跑 crypto 组(或 REQUIRED_JOBS 不含 options_crypto)——通过既有注入式测试覆盖,守卫逻辑已测。
- `getTodaySucceededJobs` 守卫已有单测(repository.test.ts),crypto 复用同一函数。

## 影响面小结

| 文件 | 改动 |
|---|---|
| `src/server/fetchers/deribitOptions.ts` | 加 `getTradingDate()` → UTC 日 |
| `src/server/jobs/daily.ts` | CLI 去掉 crypto 组;REQUIRED_JOBS 去掉 options_crypto |
| `src/server/jobs/cryptoDaily.ts` | 新建:独立加密入口 + 守卫 |
| `~/Library/LaunchAgents/com.mtv.crypto.plist` | 新建:7 天 × 5 触发(不在 git) |
| 测试 | deribitOptions / 打戳贯通 |
