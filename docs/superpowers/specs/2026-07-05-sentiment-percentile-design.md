# 情绪视角自身历史分位(分位带 + 极端度读数)设计

日期:2026-07-05

## 背景 / 目标

情绪视角(F&G / COR1M / VIXEQ)缺"当前值有多极端"的参照。加**自身历史分位**:
每个指标画其历史 P5/P95 参考带,并常显最新值的百分位,一眼看出极端程度。

选自身分位而非"对比 SP500 顶底":这些是逆向情绪计,其自身极值构造上已对应市场顶/底,
自身分位即"到了历史上标记顶/底的水平";而标 SP500 顶底会引入事后偏差 + 小样本问题(已论证)。

**范围**:只情绪视角 3 个 pane。机制做通用,将来给信用/流动性加只改配置。

## 组件

### ① 纯函数 `src/web/lib/stats.ts`(+ 单测)

- `percentile(values: number[], p: number): number` —— 排序后线性插值取第 p 百分位(p ∈ [0,100])。
- `percentileRank(values: number[], x: number): number` —— x 在 values 中的百分位排名(0–100,四舍五入到整数)。
- 空数组:`percentile` 返回 `NaN`,`percentileRank` 返回 `NaN`(上层判 NaN 则不画/不显示)。

### ② 引擎:`LineSpec.refLines`(改 `assetChart.hooks.ts`)

- `LineSpec` 加 `refLines?: { price: number; title: string }[]`。
- `usePaneChart` 建 line series 后,为每条 refLine 调 `createPriceLine`(灰虚线,`lineStyle:2`,`axisLabelVisible:true`)——
  即现有单条 `baseline` priceLine 逻辑的泛化。`baseline`(0 线,repoStress 用)保留不动,与 `refLines` 并存。
- 期权侧不传 `refLines`,行为完全不变。

### ③ 情绪维度接线(改 `regimeChart.hooks.ts`)

- `buildRegimeSpecs`:对 sentiment 维度,每序列用**原始日频值**(聚合前)算 `percentile(vals,5)` / `percentile(vals,95)`,
  作为该 spec 的 `refLines`(标题 `P5`/`P95`)。分位对原始日频算,与显示 interval 无关。
- 新增 `regimePercentiles(data, dim)`:返回 `Record<seriesKey, number>` = 各序列最新值的 `percentileRank`,
  供徽标显示。缺失/空序列不产出。
- P5/P95 阈值为模块常量(`PCTL_LO=5` / `PCTL_HI=95`),改一处即可。

### ④ 极端期背景带(改 `assetChart.hooks.ts` + `regimeChart.hooks.ts`)

参照 A 股仪表盘:极端期在时间轴上着色,而非只有横线。lightweight-charts 无原生背景带,
用**叠加满高直方图**实现:`HistoSpec` 加 `priceScaleId`(挂独立 overlay 轴,自身 0–1 自缩放,
`scaleMargins` 归零 → 柱子满 pane 高)。`buildRegimeSpecs` 对 percentiles 维度每序列多产一条背景
histogram(先于线建 → 画在下层):某点 `<P5` 或 `>P95` → value 1 + 半透明色,否则 value 0(不画)。

**语义红绿**:各序列配 `riskTail: 'low'|'high'` 指明哪端是"风险",风险端红、机会端绿。
`fng:high`(贪婪=风险)、`cor1m:low`(自满=风险)、`vixeq:high`(离散度/自满=风险)。

### ⑤ 展示:每 pane 常显百分位徽标(改 `PaneChartView.tsx`)

- 新增 prop `badges?: Record<string, string>`(paneKey → 文本,如 `'P8'`)。
- 在每个未折叠 pane 的**右上角**常显该徽标(复用已算好的 `tops[i]` 定位;不同于悬停才显示的图例)。
- `RegimeChart` 传入 `badges`(由 `regimePercentiles` 生成,如 `{ fng: 'P8', cor1m: 'P3', vixeq: 'P72' }`);
  `AssetChart` 不传 → 无徽标,行为不变。

## 数据流

`RegimeChart(sentiment)` → `useRegimeData()` 拿 series → `buildRegimeSpecs`(含 refLines)+ `regimePercentiles`(徽标)
→ `usePaneChartStack` → `<PaneChartView badges=.. />`。分位全在前端算,无路由/后端改动。

## 边界 / 错误

- 序列在 `unavailable` 里 → 无 spec、无 refLines、无徽标(维持现有留空 + "暂不可用"提示)。
- 序列点数过少(如 <2)或全等值:`percentile` 仍返回数值(退化为该值),refLines 可能重合——可接受,不特判。
- 徽标 NaN(空序列)→ 不显示该 pane 徽标。

## 测试

- `src/web/lib/stats.test.ts`:`percentile`(含 0/50/100 分位、插值中间值)、`percentileRank`(最小/最大/中间值)、空数组返 NaN。
- 展示与接线沿用手动验证(见下)。

## 验证(实现后手动)

1. `bun run dev` → 情绪视角 3 个 pane 各有 P5/P95 两条灰虚线 + 右上角 `Pxx` 徽标。
2. 徽标数值合理:COR1M 现值 5.26 应落在很低分位(极端自满);对照右轴最新值与 P5/P95 位置一致。
3. **回归**:期权视角无 refLines / 无徽标,行为与改前一致。
4. `bunx tsc --noEmit` + `bun test src/web/lib/stats.test.ts` 通过。

## 明确不做(YAGNI)

- 滚动窗口分位(用全历史固定线)。
- F&G 用传统 25/75(统一自身分位)。
- 给信用/流动性视角加(机制通用,后续改配置即可)。
- 后端预存分位(前端读时现算,与 VRP 一致)。
