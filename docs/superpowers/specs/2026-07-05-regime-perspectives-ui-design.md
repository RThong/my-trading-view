# 宏观 regime 前端视角(信用 / 流动性 / 情绪)设计

日期:2026-07-05

## 背景 / 目标

后端 `/api/regime` 已能现拉 8 条 regime 序列(见 regime-data-pipeline spec)。本次在前端把它们接进
上一轮做好的**视角竖轴**(PERSPECTIVES),让宏观指标像期权视角一样以多 pane 堆叠图呈现。

**竖轴新增 3 个视角**(维度即镜头,归竖轴):

| 竖视角 id | label | pane(一序列一 pane) | 分层 |
|-----------|-------|----------------------|------|
| `credit` | 信用 | HY 信用利差(`hyOas`) | ② 背景 |
| `liquidity` | 流动性 | 净流动性 · 逆回购 · 回购用量 · 回购压力(`netLiquidity`/`reverseRepo`/`repoUsage`/`repoStress`) | ① 背景 |
| `sentiment` | 情绪 | Fear&Greed · COR1M · VIXEQ(`fng`/`cor1m`/`vixeq`) | ③④ 时点 |

竖轴顺序:**期权 / 信用 / 流动性 / 情绪**。一序列一 pane(各序列量级差太大,无法共享纵轴)。

## 复用:图表引擎白嫖,只写 regime 专属数据层

[assetChart.hooks.ts](../../../src/web/panels/assetChart.hooks.ts) 里三块是**通用**的,直接复用:
`usePaneChart`(引擎)、`usePaneLayout`(pane 上下换位 + 折叠)、`useCrosshairLegend`(竖线图例),
外加 `Spec`/`PaneDef`/`LinePoint` 类型与 [lib/chart.ts](../../../src/web/lib/chart.ts) 的 `CHART_OPTIONS`/`aggregate`。
期权专属的(`paneConfig`/`useAssetData`/`buildSpecs`/`COLORS`)不碰。

### 抽出共享展示组件 `PaneChartView`

`AssetChart` 的 JSX(pane 工具条 ↑↓▾ + 竖线图例 + 容器 + loading/error)约 55 行,除数据源外**全是通用**的
(只吃 `paneDefs`/`order`/`collapsed`/`cells`/`hovering`/`tops`/`seriesName`/`colors`)。抽成
`src/web/panels/PaneChartView.tsx`,`AssetChart` 与新的 `RegimeChart` 都变成薄壳:
`取数 hook → build specs → 三个通用 hook → <PaneChartView .../>`。

避免复制 55 行易漂移的图例定位/涨跌上色 JSX。**代价**:动到能跑的 `AssetChart`——机械抽取,
实现后跑一次 app 确认期权视角行为不变(见验证)。

## 新增文件

- 🆕 `src/web/panels/regimeChart.hooks.ts`
  - `useRegimeData()`:SWR 取 `/api/regime`(同 `SWR_OPTS`,EOD 不重验),返回 `{ series, unavailable }`。
    三个 regime 视角都调它 → SWR 按 URL 去重,只发一次请求。
  - `REGIME_DIMS`:`Record<'credit'|'liquidity'|'sentiment', { paneDefs, seriesName, colors }>`——各维度的
    pane 列表(一序列一 pane)、中文短名、配色。
  - `buildRegimeSpecs(series, dim, interval)`:把 `series[key]` 映射成 `LineSpec[]`,`aggregate` 按 interval 聚合。
    `repoStress` 给 `baseline: 0`(会穿零)。缺的序列(在 `unavailable` 里)不建 spec。
- 🆕 `src/web/panels/RegimeChart.tsx`:`props { dim, interval }`,薄壳,复用三个通用 hook + `<PaneChartView>`。
- 🆕 `src/web/panels/PaneChartView.tsx`:从 `AssetChart` 抽出的通用展示壳。

## 改动文件

- ✏️ `src/web/panels/AssetChart.tsx`:JSX 抽进 `PaneChartView` 后改用之(逻辑不变)。
- ✏️ `src/web/App.tsx`:`PERSPECTIVES` 追加 credit/liquidity/sentiment 三条,`render` 返回 `<RegimeChart dim=.. interval=..>`。
  每条 `tabs` 单元素(单视图)。
- ✏️ `src/web/components/TabBar.tsx`:横排 TabBar 在 `tabs.length <= 1` 时**不渲染**(单视图视角不显示孤零零一个横 tab;
  期权 7 个资产照常显示)。竖排不受影响。

## 数据流

竖 rail 选 `sentiment` → App `render('sentiment', interval)` → `<RegimeChart dim="sentiment" interval>` →
`useRegimeData()` 拿 `{series, unavailable}` → `buildRegimeSpecs(series, 'sentiment', interval)` →
`usePaneChart`/`usePaneLayout`/`useCrosshairLegend` → `<PaneChartView>`。keep-alive 由 App 既有机制处理
(每个 `${视角}:${tab}` 实例不卸载)。

## 错误 / 边界

- `unavailable` 内的序列:其 pane 无数据,pane 顶部显示"— 暂不可用",不崩、不影响同视角其它 pane。
- 整个 `/api/regime` 请求失败:`RegimeChart` 显示 error(复用 `PaneChartView` 的 error 展示)。
- pane 数固定(按维度静态),与期权视角 `paneCount` 固定的假设一致,不因 `unavailable` 动态增减 pane。

## 测试

- 纯展示 + 数据映射,核心逻辑(`aggregate`/三个 hook)已有覆盖或在期权侧验证。
- `regimeChart.hooks.test.ts`:喂固定 `{series, unavailable}`,断言 `buildRegimeSpecs` 对各维度产出正确的
  pane 下标 / series key / 缺失序列被跳过。
- 联网不测(沿用惯例)。

## 验证(实现后手动)

1. `bun run dev` → 竖轴出现 期权/信用/流动性/情绪;点各宏观视角,pane 堆叠、折叠/换位、竖线图例都正常。
2. **回归**:期权视角(SPY 等 7 个资产)行为与抽取 `PaneChartView` 前一致(蜡烛、IV/skew/VRP、期限结构 pane)。
3. Network 面板确认 `/api/regime` 只发一次(SWR 去重)。

## 明确不做(YAGNI)

- 不做 regime 序列的参考线(F&G 的 25/75、相关性阈值等)——先纯线;要再加。
- 不把 VIX/VXN 加进情绪视角(它们在期权 VIX tab 已有;要合并另说,且需新路由)。
- 不做维度内的横 tab 细分——单视图 + 折叠够用。
