# 图表编辑器 MVP — 设计

> 范围、边界以 my-trading-view-60 的交接说明为准，这里只定三件事：JSON 状态结构、目录与文件划分、MVP 序列注册表。
> 分支 `feat/chart-editor`。

## 1. JSON 状态（`ChartDoc`）

全部编辑状态就是一个可序列化对象。图层只存序列 id，不存数据；渲染层只吃「`ChartDoc` + 取到的数据」。

```ts
type ChartDoc = {
  v: 1;
  panes: Pane[];            // 数组顺序 = 从上到下；下标 = lightweight-charts 的 paneIndex
};

type Pane = {
  id: string;               // 稳定 id（p1、p2…），不随位置变；界面上显示的「第 N 格」按下标算
  stretch: number;          // 高度比例（lw-charts setStretchFactor）。新建时主图 2、副图 1
  scales: Scale[];          // 这一格拥有的纵轴
  layers: Layer[];
};

type Scale = {
  id: string;               // 'right' | 'left' 是保留 id（lw-charts 内置轴）；独立轴用生成的 id（s1、s2…）
  side: 'right' | 'left' | 'overlay';
  // 以后加：mode（对数）、invert（倒轴）、margins…
};

type Layer = {
  id: string;               // l1、l2…
  series: string;           // 注册表 id（如 'SPY'、'dgs10'）
  scale: string;            // 引用同一格 scales 里的某个 id
  color: string;
  // 以后加：transform（MA / 同比 / 起点=100）、shift（时间平移）、style、visible…
};
```

示例：

```json
{"v":1,"panes":[
  {"id":"p1","stretch":2,
   "scales":[{"id":"right","side":"right"},{"id":"s1","side":"overlay"}],
   "layers":[{"id":"l1","series":"SPY","scale":"right","color":"#3987e5"},
             {"id":"l2","series":"vix","scale":"s1","color":"#e66767"}]},
  {"id":"p2","stretch":1,
   "scales":[{"id":"right","side":"right"}],
   "layers":[{"id":"l3","series":"dgs10","scale":"right","color":"#199e70"}]}
]}
```

不变式（每次编辑后由 `normalize()` 保证）：

- 没有图层的格自动删掉，编号随下标收拢；没有图层引用的纵轴自动删掉。整张图没有图层时 `panes: []`，显示空状态。
- `layer.scale` 一定指向**同一格**里的某根轴。图层移到别的格时：右轴 / 左轴照搬，独立轴在目标格新建一根。
- 「新开一格」就是追加一个 `Pane`；加格、删格、移动图层都只增量调整现有图表，不重建整张图。

校验：项目里没有 zod，用手写类型守卫 `parseChartDoc(unknown): ChartDoc | null`，在 `normalize` 之前跑。本期不持久化；以后存 localStorage / URL 时载入走同一个守卫，靠 `v` 做迁移。

lightweight-charts 的映射：`right` / `left` 用内置轴，`overlay` 用自定义 `priceScaleId`（独立缩放、**不画刻度**，lw-charts 的叠加轴本来就是这样）。左轴的显隐是整张图统一的设置：只要有一个图层挂左轴就打开，所以没用左轴的格也会多出一条空的左轴（引擎限制，接受）。实现时试过逐格开关（`pane.priceScale('left').applyOptions({ visible })`），在 lw-charts 5.2 上轴宽会被算成 0、刻度画不出来，所以只用整图开关。左轴打开时，独立轴图层的最新值标签会在左右两侧各显示一份（lw-charts 自身的行为）。

## 2. 目录与文件

新代码全部放在 `src/web/panels/chartEditor/`：

| 文件 | 职责 |
|---|---|
| `chartDoc.ts` + `.test.ts` | 类型、`parseChartDoc` 守卫、`normalize`、纯函数编辑操作（addLayer / removeLayer / removeSeries / moveLayer（含插到某图层前、同格调顺序）/ setLayerScale / setLayerColor / setStretches / nextColor），id 生成 |
| `registry.ts` | 静态序列注册表 `id → { label, category, freq, unit, source }` |
| `useEditorSeriesData.ts` + `.test.ts` | 按注册表取数，统一成 `{ time, value }[]`，按 Header 的周期（interval）聚合；纯转换函数（`seriesPoints` / `weekdayOnly` / `commonRange`）单独导出供测试 |
| `useEditorChart.ts` | 渲染 hook：建一次图（`createChart` + 项目的 `CHART_OPTIONS`），之后按 layer id 增量对账：`addSeries(LineSeries, …, paneIndex)` / `moveToPane` / `applyOptions({ priceScaleId, color })` / `setSeriesOrder`（同格层次）/ `removeSeries` / `setStretchFactor` / `setData` |
| `useCrosshairLegend.ts` + `Legend.tsx` | 编辑器自己的悬停图例：每格左上角列出该格各图层的名称和当前值（`pane.getHTMLElement()` 取各格顶边，开左轴时用左轴宽度让开刻度） |
| `ChartEditorPage.tsx` | 只负责组装：图 + 右侧面板 + 可折叠的只读「查看 JSON」 |
| `useChartDoc.ts` | 编辑状态（一份 `ChartDoc`）+ 各编辑动作，全部走 `chartDoc.ts` 的纯函数 |
| `SeriesPicker.tsx` | 右侧顶部：搜索框 + 多选下拉（按分类分组）。勾选 = 加到第 1 格右轴、自动配色；取消勾选 = 从图上拿掉该序列 |
| `LayerList.tsx` | 右侧下半部分：一格一个区块，区块里是图层卡片。卡片整张可拖：拖到另一张卡片上 = 插到它前面（同格即调顺序）；拖到区块空白处 = 追加到该格末尾；拖到「新开一格」虚线框 = 新开一格。卡片上可选纵轴（右 / 左 / 本格已有独立轴 / 新独立轴）、改颜色、删除。同格卡片顺序 = 图例顺序，最上面那张画在最上层（同 TradingView） |
| `EmptyState.tsx` | 空白起步时的引导 |

**复用（只 import、不修改）**：`lib/chart`（`CHART_OPTIONS`、`aggregate`、`fmtDate`、`LinePoint`）、`lib/palette`（`SERIES_COLORS`）、`regimeChart.hooks` 里的 `useRegimeData`（只用这个数据 hook）、`hooks/interval`。
**不 import**：`panels/chart/` 下的任何东西。
**唯一会改的共用文件**：`perspectives.tsx`，加一个「图表编辑」竖 tab，用 `React.lazy` + `Suspense` 懒加载。

> 关于「独立路由」：这个应用目前**没有 URL 路由**，所有页面都是竖 tab + 横 tab（`usePerspectiveNavigation`）。为一个页面引入路由库属于范围外的改动，所以入口做成一个懒加载的竖 tab，和其它页面一致。（我的决定，有异议请提）

拖分隔条用 lw-charts 原生功能（`layout.panes.enableResize`）。拖完在 pointerup 时（监听 `window`：lw-charts 允许拖出图外再松手）读回各格的 `getStretchFactor()` 写回 JSON，保证 JSON 始终是唯一真源；后续结构变化再按 JSON 重新设置比例。单根纵轴的缩放、全格共用时间轴，都直接用 lw-charts 原生行为。

## 3. MVP 序列注册表（17 条，都不依赖 OpenD）

除 SPY 外都来自 `/api/regime`（一次请求，`useRegimeData`，各面板共用 SWR 缓存，所以不会多发请求）。SPY 来自 `/api/price/SPY`（`price_eod`，与期权页的现货同源）。

| 分类 | id | 名称 | 频率 | 来源 |
|---|---|---|---|---|
| 资产 | `SPY` | SPY 收盘 | 日 | `/api/price/SPY` → `close` |
| 资产 | `qqq` | QQQ 收盘 | 日 | regime `series.qqq` |
| 资产 | `btc` | BTC 收盘 | 日（含周末） | regime `ohlc.btc` → `close` |
| 资产 | `usd` | 美元指数 DXY | 日 | regime `series.usd` |
| 资产 | `usdjpy` | USD/JPY | 日 | regime `series.usdjpy` |
| 波动率 | `vix` | VIX | 日 | regime |
| 波动率 | `vxn` | VXN | 日 | regime |
| 波动率 | `move` | MOVE | 日 | regime |
| 波动率 | `skew` | SKEW | 日 | regime |
| 波动率 | `cor1m` | COR1M 隐含相关性 | 日 | regime |
| 利率 | `dgs10` | 美债 10Y | 日 | regime |
| 利率 | `jgb10y` | 日债 10Y | 日 | regime |
| 利率 | `tp10Kw` | 10Y 期限溢价（KW） | 日 | regime |
| 信用·流动性 | `hyOas` | HY OAS | 日（FRED 只给近 3 年） | regime |
| 信用·流动性 | `netLiquidity` | 净流动性 | 周 | regime |
| 通胀·宏观 | `coreCpiYoy` | 核心 CPI 同比 | 月（日期 = 数据所属月） | regime |
| 通胀·宏观 | `ismMfg` | ISM 制造业 PMI | 月 | regime |

**周末处理（二选一的结论：放进来，按项目现有做法清洗）**：BTC 照 `tenorHistory.hooks` 的 `weekdayOnly` 处理，只留周一到周五（那个函数没导出，在编辑器里复制一份）。代价是 BTC 周末行情不单独成柱；换来的是和股票、利率混放时时间轴不会多出约 900 根周末空位。只对注册表里标了 `weekends: true` 的序列做这个过滤：月频序列的日期是每月 1 日，可能落在周末，不能一刀切滤掉。

周 / 月频序列与日频序列放在一起时，原样作为稀疏点画出（lw-charts 把线连起来），不做前向填充。

**历史长度不截**：各序列有多长就给多长（SPY 1993 起、BTC 2012 起，regime 大多 2018 起）。有新线拿到数据时，横轴对准「所有线都有数据的那一段」（起点取最晚的起点），往左拖仍能看到长历史的那几条；切换页头周期时同样重新对准（与旧图表「换周期即重铺」一致）；删线、改色、数据刷新不动视图。为让 2018 起约 2200 根日线在常见屏宽下放得下，编辑器把 `minBarSpacing` 调到 0.1（默认 0.5）。没有把其它源往 2018 年以前补：那牵动后端与全部旧页面，另议。

## 本期不做（再列一次，防止范围膨胀）

时间平移、各类变换、四则运算、对数 / 倒轴开关、水平线 / 竖线、保存载入、URL 状态、旧图迁移、多图布局。
