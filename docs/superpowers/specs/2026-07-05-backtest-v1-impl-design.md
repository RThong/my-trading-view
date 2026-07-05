# 回测器 v1 实现设计(轮动腿 + 现金基准,CLI)

日期:2026-07-05  ·  策略见 [backtest-strategy-vixterm.md](../../backtest-strategy-vixterm.md)

## 范围

v1:QQQ 基准 + **TQQQ 轮动腿**(恐慌入场 A/B/C 消融)+ **现金减仓保险基准**。CLI 输出。
**不做**:合成 QQQ put(v2)、web 展示、把 TQQQ 落库。

铁律(策略文档 §0/§1.1/§3):**复权价、无未来函数、close-to-close 次日执行**——每条都有单测锁死。

## 数据(内存,不落库)

- **QQQ / TQQQ 复权日收盘**:Yahoo `adjclose`(拆股+分红调整)。回测进程内存持有,**不写 `price_eod`**(那是 dashboard 未复权蜡烛)。
  - 改 `fetchers/yahoo.ts`:`YahooQuote` 加 `adjclose`,`fetchDailyBars` 返回里带 `adjClose`(向后兼容,现有调用忽略即可)。
- **VX1 / VX3**:`getMarketSeries` 读 → `computeSpread` 算 spread(复用 analytics/termStructure)。
- 三序列按**共同交易日 inner join**;窗口 = 交集(受 VX1/VX3 限,约 2018+)。

## percentile 迁移

`src/web/lib/stats.ts` → **`src/shared/stats.ts`**(server 不能 import web/lib)。连 `stats.test.ts` 一起搬;
`web/panels/regimeChart.hooks.ts` 的 import 路径改为 `../../shared/stats`。web/backtest 共用同一份。

## 结构:`src/server/backtest/`(信号 / 撮合 / 指标分离,纯函数为主)

### `signal.ts`(纯)
输入:`spread: {date,value}[]`(升序)、config(阈值 + 入场变体)。
输出:`{ date, panic, greed }[]`(每日状态)。
- 前 `warmup` 天状态全 false(预热)。
- 第 t 天:`rank_t = percentileRank(spread[0..t].value, spread_t)`(扩张窗口,含当天)。
- 恐慌进入变体:`A` = `spread_t>0`;`B` = `rank_t≥85`;`C` = A||B。退出 `rank_t≤50`。滞后:状态在进/出阈值间保持。
- 贪婪进入 `rank_t≤10`、退出 `rank_t≥30`。恐慌与贪婪互斥(同一天不可能都触发)。

### `engine.ts`(纯)
输入:每日状态、对齐的 `{date, qqqAdj, tqqqAdj}[]`、config(sleeve S、现金减仓比例、成本 bps、开哪些腿)。
输出:`{ equity: {date,value}[], trades: [...] }`。
- 第 t 天状态 → 目标权重(恐慌:70%QQQ+30%TQQQ;贪婪现金腿:减仓 H 到现金;无:100%QQQ)。
- 权重**在 t+1 生效**:用 `t→t+1` 的复权 close-to-close 收益推进净值(不许同 bar)。
- 换手按权重变动收 `cost_bps` 单边。
- 变体开关:`{rotation:bool, cashInsurance:bool}` → 基准/仅轮动/仅现金/两腿。

### `metrics.ts`(纯)
净值 → `{ cagr, mdd, sharpe, sortino, calmar }`;状态序列 → `{ panicDays, panicEpisodes, greedDays, greedEpisodes, timeInTqqq }`。
(episode = 状态从 false→true 的次数。)

### `run.ts`(CLI,`import.meta.main`)
抓 QQQ/TQQQ 复权 + 读 spread → 对齐 → 对 {基准, 仅轮动, 仅现金, 两腿} × {A,B,C} 跑 → 打印对比表(每行一个组合,列为各指标)+ 顶部打印窗口/天数/episode 数。

## 无未来函数(核心,必测)
- `signal.ts` 的 rank 只用 `spread[0..t]`。
- **单测**:构造序列 S,记录第 t 天 `rank_t`;在 S 末尾追加任意未来点得 S',断言 S' 下第 t 天 `rank_t` 完全不变。
- 执行错位单测:engine 用第 t 天状态 + t+1 收益,断言"信号日当天不产生收益贡献"。

## 测试
- `shared/stats.test.ts`(搬迁,原样通过)。
- `signal.test.ts`:as-of rank 无未来(上条)、A/B/C 入场差异、滞后状态机(进 85 出 50 不抽搐)。
- `engine.test.ts`:玩具 2~3 天序列上 close-to-close 净值与手算一致;换手成本正确;t+1 执行错位正确。
- `metrics.test.ts`:已知净值序列的 CAGR/MDD 手算核对。
- 抓数(Yahoo)不写联网单测,`run.ts` 手动跑验证。

## 验证(实现后手动)
`bun run src/server/backtest/run.ts` → 打印对比表;`spread>0` 约 380 天、panic~34/greed~35 episode 与本地 sanity 对得上;纯 QQQ 基准 CAGR/MDD 与 §7 的 ~20.25% / −35.12% 量级一致。

## 影响文件
- 🆕 `src/server/backtest/{signal,engine,metrics,run}.ts` + `{signal,engine,metrics}.test.ts`
- 🆕 `src/shared/stats.ts` + `stats.test.ts`(从 web/lib 迁入)
- ✏️ `src/web/lib/stats.ts` 删除;`web/panels/regimeChart.hooks.ts` 改 import
- ✏️ `src/server/fetchers/yahoo.ts` 加 `adjclose`
- 复用不改:`analytics/termStructure.ts`(computeSpread)、`storage/repository.ts`(getMarketSeries)

## 参数默认(见策略 §8)
warmup 252 · 恐慌进 85/backward、出 50 · 贪婪进 10、出 30 · TQQQ sleeve 30% · 现金减仓 20% · 成本 5bps。
