# BTC 现货抓取从美股周历解耦 设计

日期:2026-06-29
状态:待实现

## 背景与问题

上次把 BTC **期权**抓取解耦进 7 天独立的 `cryptoDaily`(com.mtv.crypto),但 BTC **现货**(price_eod)漏了——它仍由 `vrpInputs` 写,而 `vrpInputs` 只在主 daily job(com.mtv.daily,**周二~六**)里跑。后果:周日/周一主 job 不跑 → 这两天没抓 BTC 现货,周末蜡烛缺口(实测 price_eod BTC 停在 06-26 周五,缺 06-27/28/29,要等周二 06-30 才补)。

这与上次期权的周末缺口是同一根因(被绑在美股周历),现货没一起解耦。本设计把 BTC 现货抓取也挪进 7 天 cryptoDaily,与期权同节奏。

(注:现货 bar 由 Deribit/Yahoo 自带真实日期、24/7,无「打戳」问题——纯粹是让它每天跑就解决。)

## 方案:BTC 现货抽成 updateBtcPrice,挪进 cryptoDaily

### 1. 新建 `src/server/jobs/btcPrice.ts`

抽出 `updateBtcPrice(db: Database): Promise<{ total: number }>`,等价于现在 vrpInputs 里的 `priceLeg('BTC', …)`:
- 增量起点:`getLatestPriceDate(db, 'BTC')` 已存最新日期;库空 → `HISTORY_START_DATE`。
- 主源 Deribit `fetchBtcDailyBars(since, now)`(source='deribit');抛错 → 降级 Yahoo `BTC-USD`(source='yahoo')。
- 写 `insertPriceEod(db, …, underlying='BTC')`,返回 `{ total: 写入行数 }`。
- 主源+降级都失败 → 抛错(由上层 job_run 块记 failed)。

### 2. `runDailyJob` 加注入式 `btcPriceUpdater` + btc_price job_run 块

`src/server/jobs/daily.ts`:
- `RunDailyJobOpts` 加可选 `btcPriceUpdater?: (db: Database) => Promise<{ total: number }>`。
- 在 runDailyJob 内加一个 `btc_price` 分组块,照抄 `vxUpdater` 块结构(startJobRun → try updater → success(recordsWritten=total)/catch failed)。
- `runDailyJob` 其余不动;主 daily CLI 不注入 btcPriceUpdater(只有 cryptoDaily 注入)。

### 3. `cryptoDaily.ts` 注入 btcPriceUpdater + 守卫改两组

- import `updateBtcPrice`;runDailyJob 调用加 `btcPriceUpdater: updateBtcPrice`。
- 守卫:`['options_crypto', 'btc_price'].every((j) => done.includes(j))` 时跳过本次;否则照跑。跳过提示文案相应更新。
- 两组都属加密、同 7 天节奏;与股票 job 互不影响。

### 4. `vrpInputs.ts` 删掉 BTC 现货

- 删除 `await priceLeg('BTC', (since) => fetchBtcDailyBars(...), 'deribit', 'BTC-USD');`(约 line 107)。
- 删除随之无用的 `import { fetchBtcDailyBars } from '../fetchers/deribitBtcPrice';`。
- ETF 的 priceLeg(SPY/QQQ/GLD/USO/TLT,moomoo 主源 + Yahoo 降级)、VIX/DVOL 等保留不动。
- vrpInputs 不再**写** BTC 现货;VRP 仍在 routes/vrp.ts 读时从 price_eod 读 BTC close 算 RV 腿(数据由 cryptoDaily 填),不受影响。

## 数据流(改后)

```
com.mtv.crypto(每天 08/11/14/17/20)→ cryptoDaily
  ├─ options_crypto: Deribit BTC 期权 → option_snapshot_25delta(UTC 日打戳)
  └─ btc_price:     Deribit/Yahoo BTC 日 bar → price_eod(自带日期)
守卫:两组当天都 success → 跳过当天后续;否则重试。
```

主 daily job(com.mtv.daily,Tue–Sat)仍管 options / vrp_inputs / vx_term_structure,不再碰 BTC。

## 测试

- `updateBtcPrice` 单测(新建 btcPrice.test.ts):
  - 注入假 Deribit fetcher(返回若干 bar)→ 断言写入 price_eod、source='deribit'、total 正确;
  - 注入抛错的 Deribit + 假 Yahoo → 断言降级、source='yahoo'。
  - (注入方式:updateBtcPrice 接受可选的 fetcher 参数以便测试离线注入,默认用真实现 fetchBtcDailyBars / createYahooFetcher。)
- 守卫 `getTodaySucceededJobs` 已在 repository.test.ts 覆盖;cryptoDaily 两组守卫是 `.every` 组合,逻辑直观。
- 既有 vrpInputs / daily 测试应继续通过(删 BTC 不影响注入式测试)。

## 不做(YAGNI)

- 不动现有 job 名(options / options_crypto / vrp_inputs / vx_term_structure 保持);只新增 btc_price。
- 不回填:下次 cryptoDaily 跑时 `since` 从 price_eod 已存最新 BTC 日期(06-26)续抓,自然补上 06-27/28/29。
- 不动 com.mtv.crypto plist(触发时间不变,只是这个 job 现在多干一组活)。

## 影响面

| 文件 | 改动 |
|---|---|
| `src/server/jobs/btcPrice.ts` | 新建:`updateBtcPrice`(可注入 fetcher) |
| `src/server/jobs/btcPrice.test.ts` | 新建:Deribit 写入 + 降级 Yahoo 单测 |
| `src/server/jobs/daily.ts` | RunDailyJobOpts 加 btcPriceUpdater + btc_price job_run 块 |
| `src/server/jobs/cryptoDaily.ts` | 注入 btcPriceUpdater + 守卫改两组 |
| `src/server/jobs/vrpInputs.ts` | 删 BTC priceLeg + 无用 import |
