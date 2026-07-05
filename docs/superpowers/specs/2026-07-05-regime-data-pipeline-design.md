# 宏观 / regime 数据管线(后端)设计

日期:2026-07-05

## 背景 / 目标

现有 dashboard 数据全是期权视角。要把之前在 TradingView 上盯的一批**宏观 / regime 指标**
接进后端,让前端能查——为后续「宏观视角」UI(下一个 spec)备好数据。

**本次范围 = 纯后端 route(现拉,零存储)**:fetcher + 派生对齐 + 一个 `/api/regime` 路由现拉外部源。
**不含**任何前端 UI(宏观视角面板另开 spec)。

## 为什么不入库(关键决策)

期权数据入库是因为它**易失**(moomoo 只给当下期权链快照,今天不存明天就没了)。
但本次这批 regime 指标**全是历史序列**:FRED(信用/流动性/回购)、CBOE(COR1M/VIXEQ)随时能重拉全历史。
对不会丢的数据,入库的唯一好处是"快 + 一致性"——那是**没测就先建一层**,YAGNI。

故 **v1 先不入库,route 现拉,量真实延迟**。升级阶梯(慢了/需要了再往上爬,不提前建):
1. **v1:现拉,零存储** ← 本次
2. 若慢 → route 加**内存 TTL 缓存**(日频 EOD 数据,缓存 6–12h;几行 `Map`,仍不碰 DB)
3. 若要 F&G 长历史 / 状态灯监控 → 才上 DB + daily job

**已认的代价**:F&G 现拉只能拿 CNN 的滚动窗口(约几年),攒不了更长历史;要长历史再爬到第 3 级。

## 迁移的指标(清单已敲定)

| 维度 | 指标 | 源符号 | 来源 |
|------|------|--------|------|
| ② 信用 | HY 信用利差 | `BAMLH0A0HYM2` | FRED |
| ① 流动性 | 净流动性分量 | `WALCL` / `WTREGEN` / `RRPONTSYD` | FRED |
| ① 流动性 | 回购压力分量 | `RPONTSYD` / `SOFR` / `IORB` | FRED |
| ④ 相关性 | 隐含相关性 | `COR1M` | CBOE |
| ④ 相关性 | 成分股波动率 | `VIXEQ` | CBOE |
| ④ 情绪 | Fear & Greed | (CNN endpoint) | CNN |

**派生序列(读时现算)**:
- 净流动性 = `WALCL − WTREGEN − RRPONTSYD`
- 回购利差压力 = `IORB − SOFR`

VIX/VXN(已在 `market_series`)、BTC(已在 `price_eod`)本次不动——它们已有数据,宏观视角 UI 那一步直接读现成的。
明确不迁移:VKOSPI、Put/Call、S5FI、RXM/SPX。

## Fetchers

- **FRED**(7 序列):复用 [fred.ts](../../../src/server/fetchers/fred.ts) 的
  `createFredFetcher({apiKey}).fetchSeries(id, since)`,key 取 `.env` 的 `FRED_API_KEY`,
  `since = HISTORY_START_DATE`。WALCL 周频、其余日频——频率差异在派生对齐里处理。
- **CBOE**(COR1M / VIXEQ):复用 [cboeIndex.ts](../../../src/server/fetchers/cboeIndex.ts) 的
  `fetchCboeIndexAsQuotes({ cboeSymbol, storedSymbol })`(VXN/GVZ/OVX 同款),取 close。
- **CNN Fear & Greed**:新增 `src/server/fetchers/cnnFearGreed.ts`。GET
  `https://production.dataviz.cnn.io/index/fearandgreed/graphdata`,带完整浏览器 header
  (实测缺 Referer/Origin/UA 会 418)。解析 `fear_and_greed_historical.data`(`[{ x: ms, y: score }]`)
  → `{ date: x 转 YYYY-MM-DD, value: y }`。

## 派生对齐:`src/server/analytics/regime.ts`

一个**前向填充对齐**的按日相减 helper(仿 `analytics/vrp.ts` 的纯函数风格):
把参与相减的序列在日期并集上,各自用「最近一次已知值」前向填充,再逐日相减。
必要性:WALCL 周频、IORB 阶梯变动,直接日频减周频会大量缺口。派生序列从"各分量都已有值"的最早日起算。

## Route:`/api/regime`(现拉 + 优雅降级)

新增 `src/server/routes/regime.ts`(Hono,同 [vrp.ts](../../../src/server/routes/vrp.ts) 风格),
挂到 [index.ts](../../../src/server/index.ts):`.route('/regime', regimeRoute)`。

`GET /api/regime` **并行**拉全部源 → 算派生 → 返回:

```jsonc
{
  "series": {
    "hyOas": [{"date","value"}], "cor1m": [...], "vixeq": [...], "fng": [...],
    "reverseRepo": [...],   // RRPONTSYD 原值
    "repoUsage": [...],     // RPONTSYD 原值
    "netLiquidity": [...],  // 派生:WALCL − WTREGEN − RRPONTSYD
    "repoStress": [...]     // 派生:IORB − SOFR
  },
  "unavailable": ["fng"]    // 本次拉取失败的条目(降级用),全成功则为空数组
}
```

**优雅降级**:各源用 `Promise.allSettled` 并行;失败的源不进 `series`、记入 `unavailable`,
route 仍 200 返回其余数据(不因单个 CNN 418 整体 500)。派生序列所需分量若缺,则该派生序列也进 `unavailable`。

FRED 需 key,在 server 端读 env,不下发前端。

## 错误处理 / 边界

- 单源失败(key 缺失 / CBOE 符号 404 / CNN 反爬)→ `unavailable`,其余照常。
- COR1M / VIXEQ 若 `fetchCboeIndexAsQuotes` 拿不到 → 记 `unavailable`,不崩;届时排查符号。
- 前向填充:某分量早期无数据时,派生序列从"分量齐全"的最早日起算。

## 测试

- `cnnFearGreed.test.ts`:喂固定 JSON fixture,断言解析出的 `{date,value}` 正确。
- `analytics/regime.test.ts`:喂日频 + 周频混合序列,断言前向填充对齐后的净流动性/回购利差逐日值正确
  (含"周频值前向填充到日频"关键 case)。
- FRED fetcher 已有 [fred.test.ts](../../../src/server/fetchers/fred.test.ts),不重复。
- route 现拉外部源,不写联网单测(沿用惯例),靠手动跑验证。

## 验证(实现后手动)

- `curl localhost:3000/api/regime` → 各序列有数据;`netLiquidity`/`repoStress` 派生值合理;
  `hyOas` 最新值 ≈ 2.75(与 FRED 官网一致,之前已实测);记录一次响应耗时,作为"要不要加缓存"的依据。

## 影响文件

- 🆕 `src/server/fetchers/cnnFearGreed.ts`(+ `.test.ts`)
- 🆕 `src/server/analytics/regime.ts`(+ `.test.ts`)
- 🆕 `src/server/routes/regime.ts`
- ✏️ `src/server/index.ts`(挂 `/regime` 路由)
- (复用不改)`fred.ts` / `cboeIndex.ts`
- 不动:`schema.sql` / `repository.ts` / `daily.ts`(零存储,故不涉及)
