# 收益曲线视角 (US Treasury Yield Curve) — 设计

日期:2026-07-05

## 目标

新增「收益曲线」视角:画美债不同期限的收益率曲线,支持叠加多个历史时间点对比。参考 TradingView 的 Yield Curves 组件(多条曲线 + 下方数据表 + hover 读值)。仅美债。

## 数据源

FRED 每日国债不变期限收益率(Daily Treasury Constant Maturity),11 条序列全部免费日频:

| 期限 | FRED series |
|---|---|
| 1M  | DGS1MO |
| 3M  | DGS3MO |
| 6M  | DGS6MO |
| 1Y  | DGS1 |
| 2Y  | DGS2 |
| 3Y  | DGS3 |
| 5Y  | DGS5 |
| 7Y  | DGS7 |
| 10Y | DGS10 |
| 20Y | DGS20 |
| 30Y | DGS30 |

不引入新数据源,复用现有 `createFredFetcher`。

## 后端

新路由 `src/server/routes/yieldCurve.ts`,照搬 `routes/regime.ts` 的模式:

- **零存储、读时现拉**:不落库,和 regime 一致(EOD 日频数据盘中不变)。
- **并行 + 优雅降级**:`Promise.allSettled` 拉 11 条;单条失败归入 `unavailable`,其余照常返回,不整体 500。
- **不做服务端缓存**:只靠前端 SWR 缓存(`revalidateIfStale:false` 已防重拉);regime 有 6h TTL 是因为它聚合多个外部源,这里 11 条 FRED 约 1s,个人 dashboard 无需再加一层。
- **历史窗口**:从 `HISTORY_START_DATE` 起拉全历史,前端才能任意选历史日期叠加。

返回体:

```ts
type YieldCurveBody = {
  tenors: string[];                    // ['1M','3M',...,'30Y'] 固定顺序
  series: Record<string, Point[]>;     // 期限 → 日频收益率时间序列 { date, value }
  unavailable: string[];               // 拉取失败的期限
};
```

`Point` 复用 `analytics/regime` 里已有的类型。

## 日期解析(核心非平凡逻辑)

FRED 收益率在周末/假日/发布滞后当天没有观测值。所有目标日期一律**就近往前贴**(snap):给定目标日期 `d`,取所有 `obsDate ≤ d` 中最大的那天的值。这样任何日期都不会画出空曲线。

- **预置基于「数据里最新那天」`maxDate`**(不是墙上时钟),避免今天是周末/假日时踩空:
  - **Current** = `maxDate`
  - **Yesterday** = `maxDate − 1d` 再 snap
  - **1 week ago** = `maxDate − 7d` 再 snap
  - **1 month ago** = `maxDate − 1mo` 再 snap
  - **1 year ago** = `maxDate − 1y` 再 snap
- 用户另可手动添加任意日期(同样 snap)、删除某条曲线。

「取某日期对应的一条曲线」= 对每个期限,在其序列里 snap 到 `≤ d` 的最近值,组装成 `{ tenor → value }`。缺某期限的点则该期限留空(曲线在该点断开)。

## 前端

新增「收益曲线」tab,接进 `App.tsx`。

- **图表:手搓 SVG 折线图**,不用 lightweight-charts(后者是时间轴,而收益曲线 x 轴是期限序数)。
  - X 轴 = 11 个期限**均匀排开**(带标签)。注:非线性久期压缩(TradingView 那样)刻意不做,均匀更简单更好读。
  - 多条彩色曲线 = 多个选定日期;每条一个颜色 + 图例(日期 + 某高亮期限的值)。
  - hover:竖线定位到某期限,tooltip 显示各曲线在该期限的收益率。
- **数据表**(图下方):行=日期、列=期限,复刻截图。纯 HTML table。
- **日期选择器**:预置 5 项(Current / Yesterday / 1 week / 1 month / 1 year ago)+ 手动加任意日期 + 删除。

## 组件拆分

| 单元 | 职责 | 依赖 |
|---|---|---|
| `routes/yieldCurve.ts` | 拉 11 条 FRED、降级、返回 `YieldCurveBody` | `createFredFetcher`, `HISTORY_START_DATE` |
| `useYieldCurve` (hook) | 拉后端数据、持有全部期限时间序列、暴露 `curveForDate(d)` 与预置日期 | fetch |
| `YieldCurveChart.tsx` | 纯展示:输入若干 `{date, points}` 曲线,画 SVG + hover | 无副作用 |
| `YieldCurvePanel.tsx` | 组装:日期选择器 + 图 + 表 | `useYieldCurve`, `YieldCurveChart` |

## 测试

唯一非平凡逻辑是**日期 snap + 预置日期计算**,一个单测覆盖:

- 给定序列 map + 目标日期(落在假日/周末),`curveForDate` 返回最近 `≤` 的值。
- 给定 `maxDate`,预置日期(yesterday / week / month / year)计算正确并 snap 到存在的观测日。

沿用项目现有 `*.test.ts` + `bun test` 约定,不引入新框架。

## 明确不做(YAGNI)

- 不做其他国家(仅美债)。
- 不落库(读时现拉足够,和 regime 一致)。
- 不做非线性久期 x 轴压缩。
- 不做曲线动画、导出、分享。
