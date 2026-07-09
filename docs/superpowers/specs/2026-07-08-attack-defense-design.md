# 特色指标 › 攻防（NOBL/QQQ 防御-进攻 regime）设计

日期：2026-07-08

## 背景

想要一张"市场处在进攻还是防守"的长周期图：**NOBL（股息贵族 ETF，防御）/ QQQ（纳指 100，进攻）比值**随时间，并用**绿/红背景区**标出防守/进攻 regime。判定用**均线 + 迟滞**（滤掉小颠簸，只在走出足够幅度才翻 regime）。

## 目标

新竖 tab（视角）**「特色指标」**，下第一个横 tab **「攻防」**，两个 pane 上下堆叠：

```
上 pane：QQQ 蜡烛(OHLC)
下 pane：NOBL/QQQ 比值线 + 绿(防守)/红(进攻)背景区
```

「特色指标」是个容器视角，将来同类自定义指标各加一个横 tab。

## 架构（不碰 /api/regime）

比值与 regime 都是**展示层派生**，只需让 NOBL 日线可取，其余全在前端：

- **数据**：加抓 NOBL 日线（沿用现成 moomoo→yahoo 价格管线，存 `price_eod`），并放开 `/api/price/NOBL`。QQQ 的 `/api/price/QQQ` 已可用。
- **前端**：拉 `/api/price/QQQ`（OHLC，画蜡烛）+ `/api/price/NOBL`（取 close），前端算比值和 regime。
- **渲染**：复用现有 pane-chart 机制（`usePaneChart` + `PaneChartView`，情绪/资产图同款），两个 pane：pane0 candle、pane1 line + histogram 背景区（`priceScaleId` 全高、半透明 `BG_RED`/`BG_GREEN`，与情绪 tab 百分位背景同一套渲染）。

## 数据层改动

- `src/server/jobs/vrpInputs.ts`：价格抓取列表 `['SPY','QQQ','GLD','USO','TLT']` 加 `'NOBL'` → 每日 job 抓 NOBL 日 bar 存 `price_eod`。
- `src/server/config.ts`：把 `NOBL` 加进 `/api/price` 的允许名单（`ALL_OPTION_UNDERLYINGS` 或价格路由的 allowlist），使 `/api/price/NOBL` 返回而非 400。NOBL 不是期权标的，仅作价格序列。
- 不改 `/api/regime`、不改 `market_series`。
- **注意**：NOBL 只加进 vrpInputs 的**价格腿(RV/price leg)列表**，不能加进任何 VRP 标的配置（NOBL 无波动率指数腿，误加会让 vrp_inputs 组去找不存在的隐含腿而报错/partial）。实现时确认那行确实是纯价格抓取循环。

## 前端纯函数（单测目标）

在 `src/web/panels/attackDefense.hooks.ts`：

- `ratioSeries(nobl, qqq): {date,value}[]` — 按日期对齐相除（NOBL.close / QQQ.close）；某日两边不齐则跳过；任一缺失 → `[]`。（可复用 rateSpread 的 valueAt 对齐思路。）
- `regimeZones(ratio, maLen, band): { date, regime }[]`，`regime ∈ 'defense'|'offense'|'neutral'`：
  - trailing SMA(maLen)；前 `maLen-1` 个点无均线 → `neutral`。
  - 信号 `s_i = ratio_i / ma_i - 1`（相对偏离）。
  - 状态机：初始 `neutral`；`s > +band` → `defense`；`s < -band` → `offense`；带内**维持上一状态**（迟滞）。
  - 因果（trailing），历史不 repaint。

## 渲染 / 面板

`src/web/panels/AttackDefensePanel.tsx`：
- 拉两条价（SWR，复用现有 `/api/price/:u` 取数 hook 或 SWR）。
- 组 specs：pane0 = QQQ candle；pane1 = ratio line + regime 背景 histo（regime→颜色：defense=绿、offense=红、neutral=透明；value=1 全高，neutral value=0）。
- 用 `usePaneChart(containerRef, specs, paneCount=2)` + `<PaneChartView>` 渲染（容器常驻、三态沿用）。

## 默认参数（旋钮）

`maLen = 100`（日）、`band = 0.05`（±5%）。作为**起始值**，上线后目视调（用户"先看看"）。以模块常量放 `attackDefense.hooks.ts`，便于改。

## 时间轴 / interval

本视角是**日频长周期 regime**，MA=100 是按"日"定义的。故**忽略全局 interval 切换、恒按日频渲染**（1W/1M 对这张图无意义，避免在聚合 bar 上重算 MA 改变语义）。这是有意简化。

## App.tsx

新增视角：
```ts
{ id: 'featured', label: '特色指标',
  tabs: [{ id: 'attack_defense', label: '攻防' }],
  render: () => <AttackDefensePanel /> }
```
放在利率/信用曲线之后。

## 测试

- `ratioSeries`：对齐相除、缺口跳过、缺失 → `[]`。
- `regimeZones`：前 maLen-1 为 neutral；带内小波动**不翻**（维持）；上穿 +band 翻 defense、下穿 −band 翻 offense；连续走势保持。
渲染靠 controller 浏览器目视（QQQ 蜡烛在上、比值+绿红背景在下、regime 合理、参数可后调）。

## YAGNI / 取舍

- 不做动量子图、不做尾部淡化（trailing+迟滞已因果稳定）。
- 上 pane 只画 QQQ 蜡烛，不叠 NOBL。
- 参数暂为常量，不做 UI 调节控件（先看效果，需要再加）。
- 不引入 /api/regime 或新后端序列，纯复用价格管线。
