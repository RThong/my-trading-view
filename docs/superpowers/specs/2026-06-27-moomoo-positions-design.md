# moomoo 模拟持仓只读端点 设计

日期:2026-06-27
状态:待实现

## 背景与目标

dashboard 已用 moomoo OpenD 抓期权行情(Quote 半边)。本次加一个**只读持仓**能力:
通过 OpenD 的 Trade 半边拿**模拟账户**当前持仓,暴露一个 `/api/positions` 端点。

范围刻意收窄(YAGNI):
- **只模拟账户**(`trdEnv = SIMULATE`),免交易密码解锁;真实账户/解锁/下单都不做。
- **只读 API**,实时读一次返回 JSON;不落库、不做前端面板。
- 前后端共享类型先就位,方便以后加面板。

## 方案

### 1. fetcher:`src/server/fetchers/moomooPositions.ts`

复用 `moomooClient` 的 `withConnection(envConfig(), fn)`(与 `moomooOptions` 同一 OpenD 连接,
连不上即抛错,finally 断开)。链路:

1. `TrdGetAccList` → 账户列表,筛 `trdEnv = SIMULATE(0)`,取第一个模拟账户的 `accID`。
   无模拟账户 → 抛错(让路由转 503/明确报错)。
2. `TrdGetPositionList({ header: { trdEnv: SIMULATE, accID, trdMarket: US } })` → 原始持仓。
3. `mapPositions(raw)` 把 proto 字段映射成干净结构。

**可测点**:`mapPositions(raw): Position[]` 抽成纯函数,单测喂假 proto payload 断言映射正确;
连接部分不单测(跟现有 moomoo fetcher 一致,联网的不测)。

字段映射(proto → Position):
- `code` 代码、`name` 名称、`qty` 持仓量、`costPrice` 成本价、`price` 现价、
  `marketVal` 市值、`plVal` 浮动盈亏、`plRatio` 盈亏比例。

### 2. 路由:`src/server/routes/positions.ts`

`GET /` → 调 fetcher,返回 `{ accId, asOf, positions }`(`asOf` = 当前 ISO 时间戳)。
OpenD 未起 / 登录失败(connect 抛错)→ 返回 **HTTP 503 + 错误信息**,不让 app 崩。
在 `index.ts` 挂 `.route('/positions', positionsRoute)`。

### 3. 共享类型:`src/shared/types.ts`

```ts
export type Position = {
  code: string; name: string; qty: number;
  costPrice: number | null; price: number | null;
  marketVal: number | null; plVal: number | null; plRatio: number | null;
};
export type PositionsResponse = { accId: number; asOf: string; positions: Position[] };
```

## 实现时现场核对(查 moomoo-api `proto.js` 确认)

- `TrdGetAccList` / `TrdGetPositionList` 的确切 c2s 字段名与 header 结构。
- `trdEnv` 枚举:SIMULATE=0、REAL=1。
- `trdMarket` 美股枚举值(预期 US=2)。
- position 各字段的真实命名(qty/costPrice/price/val/plVal/plRatio 等)与单位。

## 不做(YAGNI)

- 不落库持仓历史(无建表、无 job)。
- 不做前端面板(类型先就位,后续再加)。
- 不碰真实账户、`TrdUnlockTrade`、交易密码、下单/改单。

## 测试

- `moomooPositions.test.ts`:`mapPositions(fakeRaw)` → 断言映射出的 `Position[]` 字段/数值正确,
  含空字段(某些 position 缺 plVal 等)走 null 的边界。

## 影响面

| 文件 | 改动 |
|---|---|
| `src/server/fetchers/moomooPositions.ts` | 新建:取模拟账户持仓 + `mapPositions` 纯函数 |
| `src/server/routes/positions.ts` | 新建:`GET /` + OpenD 不可用 503 |
| `src/server/index.ts` | 挂 `/positions` 路由 |
| `src/shared/types.ts` | 加 `Position` / `PositionsResponse` |
| `src/server/fetchers/moomooPositions.test.ts` | 新建:`mapPositions` 单测 |
