# 图例加 OHLC + Δ + Δ% 设计

日期:2026-07-01
状态:待实现

## 背景与目标

AssetChart 悬停图例现在每个 series 只显示一个绝对值(`名 16.63`)。参照 TradingView,想让图例更信息化:
- **蜡烛**(现货 pane):`O … H … L … C …  Δ (Δ%)`
- **线**(Call/Put IV、Skew、隐含/RV、VRP、V1−V3):`值  Δ (Δ%)`

Δ = 竖线处那根/那点 相对**前一根/前一点**的变化(蜡烛用 close);Δ% 是涨跌幅。

**不改显示时机**:仍只在鼠标悬停时显示(不悬停不挡线,最新值看右轴 tag);只把悬停内容从「单值」扩成「OHLC/值 + Δ + Δ%」。

## 口径

- **Δ** = 当前值 − 前值(蜡烛:close − 前一根 close;线:value − 前一点 value)。
- **Δ%** = `Δ / |前值| * 100`。**用绝对值做分母**:本盘有会变负/穿零的序列(Skew、VRP、V1−V3),TradingView 那种 `Δ/前值` 在负基数上符号会错乱;`Δ/|前值|` 保证 Δ% 符号始终跟随 Δ(值涨→正、值跌→负)。
- **前值取法**:crosshair 事件的 `param.logical`(逻辑下标)→ `series.dataByIndex(logical - 1)` 取前一根/点。
- **边界**:前值不存在(竖线在第一根)→ 只显示 OHLC/值,不显示 Δ/Δ%;前值为 0 → 显示 Δ 但不显示 Δ%(除零)。
- **上色**:Δ>0 绿(`#22c55e`)、Δ<0 红(`#ef4444`)、Δ=0 中性(继承 series 颜色或灰)。数值 `.toFixed(2)`,Δ 带 +/− 号,Δ% 带 +/− 与 `%`。

## 方案

### 1. 纯函数 `changeStats`(可测)

抽到 `src/web/lib/chart.ts`(图表公共逻辑所在):
```
changeStats(cur: number, prev: number | undefined):
  { delta: number; pct: number | null } | null
```
- `prev === undefined` → 返回 `null`(无前值,不显示变化)。
- `delta = cur - prev`;`pct = prev === 0 ? null : delta / Math.abs(prev) * 100`。
- 纯算术,离线可单测(负基数、前值 0、无前值三种边界)。

### 2. `useCrosshairLegend` 捕获更丰富的格

现在:`vals: Record<string, number>`。改为 `cells: Record<string, LegendCell>`,其中
```
type LegendCell =
  | { kind: 'candle'; open: number; high: number; low: number; close: number; delta: number | null; pct: number | null }
  | { kind: 'line'; value: number; delta: number | null; pct: number | null }
```
crosshair handler:对每个 series,
- 当前点 `d = param.seriesData.get(s)`;判 kind:`d.close != null` → candle,`d.value != null` → line。
- 前值:`prev = s.dataByIndex((param.logical ?? NaN) - 1)`;candle 取 `prev?.close`、line 取 `prev?.value`。
- `const st = changeStats(curClose/curValue, prevClose/prevValue)`;`delta = st?.delta ?? null`、`pct = st?.pct ?? null`。
- `hovering` 判据不变(有 cell 即悬停):`Object.keys(cells).length > 0`。

返回 `{ cells, hovering, tops }`(把 `vals` 换成 `cells`)。

### 3. 渲染(AssetChart.tsx 悬停图例)

按 series key 取 `cells[sk]`,分 kind 渲染:
- **candle**:`{名} O {o} H {h} L {l} C {c}` + 一段 `{+Δ} ({+Δ%})`(Δ 段按符号上色)。
- **line**:`{名} {value}` + `{+Δ} ({+Δ%})`。
- 无 `cell`(该 series 此刻无数据)→ `名 —`(同现状)。
- 前值缺失(delta=null)→ 只显示 OHLC/值,不显示 Δ 段。
- 一个小格式化 helper(在组件内或 chart.ts):`fmtDelta(delta, pct)` → 形如 `+0.46 (+7.85%)` / `−242.90 (−0.79%)` / delta-only。

## 测试

- `changeStats` 单测(新建 `src/web/lib/chart.test.ts` 或加进现有):
  - 正常:`changeStats(6.32, 5.86)` → `{delta≈0.46, pct≈7.85}`。
  - 负基数:`changeStats(-1, -2)` → `{delta:1, pct:50}`(值涨,% 为正)。
  - 前值 0:`changeStats(3, 0)` → `{delta:3, pct:null}`。
  - 无前值:`changeStats(3, undefined)` → `null`。
- crosshair 接线 + 渲染:`bunx tsc --noEmit` + 手动 `bun run dev` 看图(悬停蜡烛看 OHLC+Δ+Δ%、悬停线看 值+Δ+Δ%、第一根无 Δ、涨绿跌红)。前端无测试框架,不新建(YAGNI)。

## 不做(YAGNI)

- 不改显示时机(仍只悬停)、不加常驻图例、不动右轴最新值 tag。
- 不为负基数序列的 Δ% 特判成「不显示」——统一 `Δ/|前值|`,语义一致即可。
- 不引入新依赖。

## 影响面

| 文件 | 改动 |
|---|---|
| `src/web/lib/chart.ts` | 加纯函数 `changeStats`(+ 可选 `fmtDelta`) |
| `src/web/lib/chart.test.ts` | 新建:`changeStats` 边界单测 |
| `src/web/panels/assetChart.hooks.ts` | `useCrosshairLegend`:`vals`→`cells`,捕获 OHLC + Δ + Δ%(param.logical + dataByIndex) |
| `src/web/panels/AssetChart.tsx` | 悬停图例渲染:按 kind 显示 OHLC/值 + Δ + Δ%,涨绿跌红 |
