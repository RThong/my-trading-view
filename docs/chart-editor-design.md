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

新代码全部放在 `src/web/pages/editor/`：

| 文件 | 职责 |
|---|---|
| `chartDoc.ts` + `.test.ts` | 类型、`parseChartDoc` 守卫、`normalize`、纯函数编辑操作（addLayer / removeLayer / removeSeries / moveLayer（含插到某图层前、同格调顺序）/ setLayerScale / setLayerColor / setStretches / nextColor），id 生成 |
| `registry.ts` | 静态序列注册表 `id → { label, category, freq, unit, source }` |
| `useEditorSeriesData.ts` + `.test.ts` | 按注册表取数，统一成 `{ time, value }[]`，按 Header 的周期（interval）聚合；纯转换函数（`seriesPoints` / `weekdayOnly` / `commonRange`）单独导出供测试 |
| `useDocChart.ts`（现在 `views/chartDoc/`，固定面板与编辑器共用） | 渲染 hook：建一次图（`createChart` + 项目的 `CHART_OPTIONS`），之后按 layer id 增量对账：`addSeries(LineSeries, …, paneIndex)` / `moveToPane` / `applyOptions({ priceScaleId, color })` / `setSeriesOrder`（同格层次）/ `removeSeries` / `setStretchFactor` / `setData` |
| `useCrosshairLegend.ts` + `Legend.tsx`（现在 `views/chartDoc/`，固定面板与编辑器共用） | 悬停图例：每格左上角列出该格各图层的名称、当前值（蜡烛给开高低收）、相对前一点的涨跌、分位排名（`pane.getHTMLElement()` 取各格顶边，开左轴时用左轴宽度让开刻度） |
| `ChartEditorPage.tsx` | 只负责组装：图 + 右侧面板 + 可折叠的只读「查看 JSON」 |
| `useChartDoc.ts` | 编辑状态（一份 `ChartDoc`）+ 各编辑动作，全部走 `chartDoc.ts` 的纯函数 |
| `SeriesPicker.tsx` | 右侧顶部：搜索框 + 多选下拉（按分类分组）。勾选 = 加到第 1 格右轴、自动配色；取消勾选 = 从图上拿掉该序列 |
| `LayerList.tsx` | 右侧下半部分：一格一个区块，区块里是图层卡片。卡片整张可拖：拖到另一张卡片上 = 插到它前面（同格即调顺序）；拖到区块空白处 = 追加到该格末尾；拖到「新开一格」虚线框 = 新开一格。卡片上可选纵轴（右 / 左 / 本格已有独立轴 / 新独立轴）、改颜色、删除。同格卡片顺序 = 图例顺序，最上面那张画在最上层（同 TradingView） |
| `EmptyState.tsx` | 空白起步时的引导 |

**复用（只 import、不修改）**：`chart/core`（`CHART_OPTIONS`、`aggregate`、`fmtDate`、`LinePoint`）、`chart/palette`（`SERIES_COLORS`）、`regimeChart.hooks` 里的 `useRegimeData`（只用这个数据 hook）、`hooks/interval`。
**不 import**：`chart/` 下的多 pane 图表栈（`paneChart.*`、`PaneChartView` 等）。
**唯一会改的共用文件**：`perspectives.tsx`，加一个「图表编辑」竖 tab，用 `React.lazy` + `Suspense` 懒加载。

> 关于「独立路由」：这个应用目前**没有 URL 路由**，所有页面都是竖 tab + 横 tab（`usePerspectiveNavigation`）。为一个页面引入路由库属于范围外的改动，所以入口做成一个懒加载的竖 tab，和其它页面一致。（我的决定，有异议请提）

拖分隔条用 lw-charts 原生功能（`layout.panes.enableResize`）。拖完在 pointerup 时（监听 `window`：lw-charts 允许拖出图外再松手）读回各格的 `getStretchFactor()` 写回 JSON，保证 JSON 始终是唯一真源；后续结构变化再按 JSON 重新设置比例。单根纵轴的缩放、全格共用时间轴，都直接用 lw-charts 原生行为。

## 3. 序列注册表（28 条内置 + 任意 Yahoo 代码，都不依赖 OpenD）

数据来源：SPY / GLD / IBIT / TLT / USO 走 `/api/price/:symbol`（`price_eod`，与期权页现货同源）；美债 2Y/10Y/30Y、实际利率 5/10/30Y、BEI 5/10Y 走 `/api/yield-curve?source=…&history=full`（编辑器专用长历史版：名义 1990 起、实际 / BEI 2003 起，与旧页面默认的 2018 起版本分开缓存）；其余走 `/api/regime`（`useRegimeData`，各面板共用 SWR 缓存）。另可搜任意 Yahoo 代码（图层 id = `yh:<代码>`，走 `/api/yahoo/search` + `/api/yahoo/history/:symbol`，读时现拉、不落库）。

| 分类 | id | 名称 | 频率 | 来源 |
|---|---|---|---|---|
| 资产 | `SPY` | SPY 收盘 | 日 | `/api/price/SPY` → `close` |
| 资产 | `qqq` | QQQ 收盘 | 日 | regime `series.qqq` |
| 资产 | `GLD` | GLD 黄金 | 日 | `/api/price/GLD` → `close` |
| 资产 | `IBIT` | IBIT 比特币 ETF | 日（2024-01 上市） | `/api/price/IBIT` → `close` |
| 资产 | `TLT` | TLT 长期美债 | 日 | `/api/price/TLT` → `close` |
| 资产 | `USO` | USO 原油 | 日 | `/api/price/USO` → `close` |
| 资产 | `btc` | BTC 收盘 | 日（含周末） | regime `ohlc.btc` → `close` |
| 资产 | `usd` | 美元指数 DXY | 日 | regime `series.usd` |
| 资产 | `usdjpy` | USD/JPY | 日 | regime `series.usdjpy` |
| 波动率 | `vix` | VIX | 日 | regime |
| 波动率 | `vxn` | VXN | 日 | regime |
| 波动率 | `move` | MOVE | 日 | regime |
| 波动率 | `skew` | SKEW | 日 | regime |
| 波动率 | `cor1m` | COR1M 隐含相关性 | 日 | regime |
| 利率 | `dgs10` | 美债 10Y | 日（1990 起） | `/api/yield-curve` treasury 10Y（id 沿用旧名） |
| 利率 | `jgb10y` | 日债 10Y | 日 | regime |
| 利率 | `tp10Kw` | 10Y 期限溢价（KW） | 日 | regime |
| 信用·流动性 | `hyOas` | HY OAS | 日（FRED 只给近 3 年） | regime |
| 信用·流动性 | `netLiquidity` | 净流动性 | 周 | regime |
| 通胀·宏观 | `coreCpiYoy` | 核心 CPI 同比 | 月（日期 = 数据所属月） | regime |
| 通胀·宏观 | `ismMfg` | ISM 制造业 PMI | 月 | regime |

**周末处理（二选一的结论：放进来，按项目现有做法清洗）**：BTC 照 `tenorHistory.hooks` 的 `weekdayOnly` 处理，只留周一到周五（那个函数没导出，在编辑器里复制一份）。代价是 BTC 周末行情不单独成柱；换来的是和股票、利率混放时时间轴不会多出约 900 根周末空位。只对注册表里标了 `weekends: true` 的序列做这个过滤：月频序列的日期是每月 1 日，可能落在周末，不能一刀切滤掉。

周 / 月频序列与日频序列放在一起时，原样作为稀疏点画出（lw-charts 把线连起来），不做前向填充。

**历史长度不截**：各序列有多长就给多长（SPY 1993 起、BTC 2012 起，regime 大多 2018 起）。有新线拿到数据时，横轴对准「所有线都有数据的那一段」（起点取最晚的起点），往左拖仍能看到长历史的那几条；切换页头周期时同样重新对准（与旧图表「换周期即重铺」一致）；删线、改色、数据刷新不动视图。为让 2018 起约 2200 根日线在常见屏宽下放得下，编辑器把 `minBarSpacing` 调到 0.1（默认 0.5）。没有把其它源往 2018 年以前补：那牵动后端与全部旧页面，另议。

## 4. 第二轮（分析与交互）

- **纵轴属性**：`Scale.invert`（倒轴）、`Scale.log`（对数；轴上有 ≤0 值时渲染退回普通坐标）。只在值真变化时写 lw-charts 选项 —— 重复写 `mode` 会冲掉用户手动缩放的范围。
- **平移**：`SeriesLayer.shift`（交易日，±3650），先平移再聚合；图例在日线下标原始日期。
- **滚动相关性（已删，2026-11 第三轮）**：曾是派生图层 `{kind:'corr'}`，独占一格、轴固定 −1~1。删的理由：相关性是定量工具，定量这一步已在「叠加对比」的选段里做完（能叠上 = 过了门槛），图表本身是给定性看的，剩下交给眼睛。要找回看 `6f3d686`。
- **叠加对比**（原名「叠到 A 上」，`bestOverlay`）：选好两条线直接点，在**当前视口**里三步走：① 用 A / B 未平移的日线找 B 的最佳偏移（约 20 交易日变化率，范围 ≤ 视口 1/4 且 ≤750；提升 <0.05 不挪）——先找偏移，否则有领先关系的一对在不平移时就被选段刷掉；② 按平移后的 B 用 `findBaseSegment` 选基准段；③ 在基准段里最小二乘求 a ≈ α + β·b。B 挪进 A 的格、**挂自己的轴**（优先 A 对面的内置轴，有刻度；两侧都占了才开独立轴），按原值画；β<0 就把这根轴设成倒轴（倒轴按钮亮）。`useFitSync` 每帧读 A 轴当前范围、按比例反解成 B 轴范围写回，缩放时间、拖 A 的轴都一直对得上；`useBaseBand` 把基准段在图上标成暖黄色带。叠加期间两头的倒轴 / 对数锁住，B 不能拖、不能换轴，A 是对数轴时不让叠。
- **选段标准** `OVERLAY_RULES`（`analysis.ts`）：段长 ≥ 视口 1/3；涨跌相关 ≥ max(0.3, 2/√月数)（段越短要求越强）；切 4 份至少 3 份同号且 |r|≥0.2（挡「时有时无」）；按水平 |r|≥0.5 且与涨跌同号。选法 = 先看吻合度（水平 |r|）最高能到多少，再在不比它差 0.05 的段里挑最长的（直接挑最长会一路伸进失效段、压线才停）。都不达标就不叠、说明整段是哪条没过。门槛是回测定的：`calibrateOverlay.ts`（9 对已知组合判对 9/9；随机走势 200 对误报：全时段 0、视口 1 年 1.5%、2 年 5.5%），**改门槛前后各跑一次**。注意这只测了选段：按钮还会先找偏移（上百次比较里挑最像的），整个流程在短视口的误报更高（随机 100 对：1 年约 16%、2 年约 32%）。负责人拍板不为此收紧——只看一两年就该自己掂量结果。已知局限：只看 2022 一年认不出股债同跌（r 0.42 < 一年门槛 0.6，放宽到 1.5/√月数短视口误报升到 13–20%）；段尾会往断点后多伸几个月。
- **为什么这样合并**（2026-11 第三轮）：原先「领先滞后扫描曲线 + 参照期日期框 + 劈叉幅度格」三件拆开，用户看不懂；三件本是同一件事「让 B 贴着 A」。劈叉靠肉眼定性即可，不再单开一格。两根轴而非「B 换算成 A 的单位共用一根轴」：参考的研报图（知识库 sources/微博）叠两条线一律各挂各的轴、反向就倒轴，刻度可读；静态图没有缩放问题，交互图靠每帧同步补上。基准段由工具在视口里自动选、并写明选了哪段（图上标色），合不合理由人看图把关；只想看某几年就先缩放到那几年。
- **选线拖动**：点线选中（加粗），格内任意处上下拖只挪它的轴；左 / 右轴交给原生拖（临时切 `defaultVisiblePriceScaleId`，mouseup 处理完再切回），独立轴自己挪；双击复位自动缩放。
- **lw-charts 5.2 的坑**：`priceScale.setVisibleRange` 在对数轴上不换算（会算出 Infinity）；数据变化时派发「可视时间范围」事件可能抛 `Value is null`（改订阅逻辑范围）。

- **序列搜索框**(第三轮末):换成 shadcn Combobox 的标签式多选 —— 输入区一条序列一个标签(图上颜色、× 删一条)、右侧清空全部 / 展开;
  空输入退格删最后一个;↑↓ 回车可选。搜索、分组、Yahoo 联网结果仍由 `SeriesPicker` 自己算(组件的 `filter={null}`)。

## 5. 画线（2026-11-08，第一批：趋势线 / 水平线 / 竖线）

照 TradingView 默认（NotShared）：**画线属于这张图**，存进 ChartDoc；不按序列共享、不进固定面板（固定面板不给工具栏，负责人定）。

- **挂在图层上**（同 TradingView 每条画线的 `ownerSource`）：`Layer.drawings: Drawing[]`。纵坐标是那条序列的单位；图层挪格，线跟着走；图层删了，线一起删。
  画的时候挂到哪条：这一格里**已选中的那条线**（先点选再画），没选中就挂这一格第一条看得见的线。
- **竖线也挂图层**，带「延伸到所有格」开关（同 TradingView 竖线的 Extend），默认延伸；`paneOnly: true` = 只画自己那一格。新加的格也会画上延伸的竖线（画的时候才往各格铺）。
- **锚点 = 日期 + 数值**，不存第几根 K 线（老 `chart/trendlines` 存 logical，换周线就跑位）。日期 → 横坐标：按图上所有序列的时间点并集（= lw-charts 的逻辑下标）插值，两根之间按日历天数比例、数据两端之外按中位间隔外推，再按第 0、1 根的横坐标线性换算成像素（**别改回 `logicalToCoordinate`**：它只认整数下标，带小数直接返回 0）；所以周 / 月线、最右边空白区都画得出。反过来鼠标 → 日期取整到天。
- **渲染**：每个 lw 格挂一个格级图元（`pane.attachPrimitive`），绘制时现读最新状态、按所属图层的 series 换算纵坐标（对数 / 倒轴由 series 自己算）。所属图层隐藏时它的画线不画。
- **交互**（只在编辑器）：左侧竖向工具栏 = 光标 / 趋势线 / 水平线 / 竖线 / 全部隐藏 / 全部删除。趋势线点两下（或按住拖）；水平 / 竖线点一下；画完回到光标并选中新线。光标模式下点中画线 = 选中（端点出手柄），拖端点改一端、拖线身整条挪；Delete 删除、Esc 取消。拖动中只改本地草稿，松手才写回文档（每帧写文档会触发整页重渲染 + 落盘）。
  绘图 / 拖画线时在容器的捕获阶段截下按键，lw-charts 的平移和「选线拖轴」（`useLineDrag`）都收不到。
- 负责人定的细节：两点离得太近（< 4px，按鼠标原始位置算）不画趋势线、第一点留着；画线这边用掉的 Esc 不再清掉选中的序列线；双击落在画线上或处于绘图工具时不触发「双击纵轴复位」。
- **已知限制**（负责人定，第一批接受）：「先点选再画」只认 `useLineDrag` 能点选的普通折线 —— 叠加对比里的 B 腿、蜡烛、指标、柱子都选不中，画在那一格的线挂到这一格第一条可挂的线上（叠加那一格就是 A，用 A 的单位）。以后要挂 B：浮条里加「挂在」下拉改挂，改挂时按屏幕位置换算成新线的单位。
- 第一批不做：颜色 / 线型、射线、矩形、文字、测量、磁吸、按周期显示（后续范围见 5.2）。
- 评审遗留（第 5 轮通过时记下，没修，都是少见、不丢数据的边角）：① 绘图工具下点在挂不上线的格（只有竖线 / 色带、或线全隐藏、或首条线还没数据）不截按键，按住拖会平移；② 没选中线时取「第一条看得见的线」不看它有没有数据，还在加载 / 暂无数据时这一格画不上；③ 趋势线点完第一下后侧栏删 / 挪了上方某格，第二点按旧格下标算纵坐标；④ `useDrawings` 里不带依赖的同步 effect 兼管「文档换了就作废手势」，可拆成独立 effect。

- **射线 / 水平射线**（2026-11-09）：射线存两点（`kind: 'ray'`，同趋势线），从 a 出发、穿过 b、沿 a→b 方向无限延伸（b 在左边就往左，渲染时画到 10 万像素远、超出画布的部分自己裁掉）；画法、拖端点、吸附后两点重合判断都和趋势线共用（`isTwoPoint`）。水平射线存一个起点（`kind: 'hray'`），从起点往右；点一下画成，拖起点或线身都是整条挪（过插件）。方向规则没能在 TradingView 上实测（匿名访问弹注册框挡住画线），按通行定义做。

- **平行通道**（2026-11-09）：存三点（`kind: 'channel'`，a、b 底边 + c 宽度），平行线穿过 c、在屏幕上与底边平行（对数 / 倒轴下也是两条平行直线），另画虚线中线、两线间填淡色。画法同 TradingView：点两下（或按住拖）定底边，再点一下定宽度；画手势多一个 `stage`（b = 定第二点，c = 定宽度）。手柄：底边两端 a / b + 平行线中点的宽度手柄 c（拖它只改宽度）；点在两条边附近或通道里面都算点中。底边两点同一天按「画不出方向」处理（见 `noDirection`）。

### 5.1 工具栏分组（2026-11-09，交互已做，子菜单内容逐步加）

照 TradingView 左栏：单按钮 + 工具组。**工具组**的按钮显示这组上次用过的工具（点它直接用）；悬停整格时右缘滑入小三角，**点**小三角（不是悬停）在右侧弹出子菜单，子菜单按小节列工具；选中后切工具、关弹层、组按钮换成该工具图标；打开期间小三角保持高亮并翻转。各组上次用的工具存 localStorage（`mtv:drawingToolbar:last`）。实现在 `pages/editor/components/DrawingToolbar.tsx` 的 `GROUPS`：加工具 = 往某组的小节里加 id，加组 = 往 `GROUPS` 加一项。

计划的布局（括号里是「可选」级，做到才出现）：

```
[↖]   光标（单按钮）
[╱▸]  线条组   线：趋势线 · 射线 · 水平线 · 水平射线 · 竖线（· 信息线）
               通道：平行通道（· 回归通道）
[T▸]  标注组   文字 · 标注气泡 · 路标（· 便签）（· 矩形）
[⟷]   测量：日期 + 价格区间（单按钮，组里只有一样不做下拉）
──────
[🧲]  磁吸（开关）  [🔒] 锁定（开关，可选）  [👁] 隐藏全部  [🗑] 删除全部
```

取舍：通道并进线条组（同 TradingView，单独成组只有一两样）；路标是「带文字的竖线」，用时想的是写注释，归标注组；矩形只有一样、用途是「框出来说明」，也归标注组。

### 5.2 要做的工具（负责人 2026-11-09 定）

| 级别 | 工具 | 用途 |
|---|---|---|
| 重要 | 样式：颜色 / 线宽 / 线型（所有画线共用） | 线多了靠颜色区分；通道、参考线常用虚线 |
| 重要 | 文字（可加框） | 图上放一段说明 |
| 重要 | 平行通道 | 趋势线 + 一条平行线围成通道 |
| 重要 | 日期 + 价格区间（含临时测量尺） | 拉一个框看这段涨跌幅、用了几天 |
| 重要 | 射线 | 从一点穿过第二点往右无限延伸：支撑 / 阻力延伸到未来 |
| 重要 | 水平射线 | 从某天起往右的水平线 |
| 重要 | 标注气泡（Callout） | 带尖角指向某一点的文字 |
| 重要 | 路标（Signpost） | 立在某天上方、带文字的牌子 = 带文字的事件竖线 |
| 重要 | 磁吸 | 端点吸到附近收盘价，日线上画得准 |
| 可选 | 信息线 | 趋势线自带涨跌 / 天数信息框（区间测量已能量出） |
| 可选 | 回归通道 | 自动算回归中线 ± 标准差带 |
| 可选 | 矩形 | 框一段时期 + 价格区间（背景色带图层已能标时期） |
| 可选 | 便签（Note） | 悬停才弹出的长说明 |
| 可选 | 锁定 | 防误拖（有撤销后风险更低） |

做的顺序（负责人 2026-11-09 定；✅ = 已做）：磁吸 ✅ → 射线 + 水平射线 ✅ → 平行通道 ✅ → 文字 → 路标 / 标注气泡 → 日期 + 价格区间 → 样式（颜色 / 线宽 / 线型）。磁吸最先：它是横切所有工具的增强，先做好，之后每个新工具开 / 关磁吸各测一次即可；样式放最后，新工具先用默认黄色实线。撤销 / 重做随时可插入。

### 5.3 扩展点（横向增强做成插件，无侵入接入）

横向增强（影响所有画线工具的功能）做成插件：核心为每一**类**增强留一个扩展点，只改一次；之后加 / 删 / 开关同类插件不再碰核心，画线工具与 `useDrawings` 不认识具体插件。一个扩展点只接得住一类；新的一类第一次出现时再建对应扩展点（别预建，接口多半猜错）。

| 扩展点 | 管什么 | 状态 | 插件接口 | 已有插件 |
|---|---|---|---|---|
| 锚点变换 | 鼠标落点 → 锚点存成什么 | ✅ 2026-11-09 | `PointPlugin.apply(锚点, PointCtx, 模式) → 锚点`，纯函数，不碰文档、不画东西 | 磁吸（弱 / 强） |
| 绘制 | 插件自己额外画东西 | 未建（落点预览不走这里，见下） | — | — |
| 完成 | 画完一条之后做什么（如连续绘图） | 未建 | — | — |
| 拦截 | 能不能选 / 拖（如锁定画线） | 未建 | — | — |

锚点变换的实现：
- 插件在 `pages/editor/drawingPlugins/`：一个插件一个文件（自带名称、图标、模式列表、`apply`），`index.ts` 的 `POINT_PLUGINS` 是唯一登记处，**数组顺序即执行顺序**（先吸附再锁角度 ≠ 反过来，新插件放第几位要想清楚）；`runPlugins` 依次过开着的插件，全关 = 原样返回。纯计算放 `chart/`（磁吸是 `chart/magnet.ts`）。
- 核心只有两处认插件：`useDrawings` 收一个 `transformPoint`（不认识具体插件），工具栏按 `POINT_PLUGINS` 渲染开关按钮（点按钮开 / 关，小三角里选模式）。开关与模式按插件 id 存 localStorage（`mtv:drawingPlugins`）。
- **约定：画线工具「鼠标落在哪」一律经 `useDrawings` 的 `toPoint` 取锚点，不自己换算**，插件才管得到。唯一例外是拖趋势线整条（线身平移）走不过插件的 `rawPoint`：两端各吸各的会把线拧歪。
- `PointCtx` 一次带全（光标像素、光标所在那一根的值、数值 → 纵坐标、另一端点、Shift、「只用日期」「正在拖」标记），锁角度、吸整数价位这类以后的锚点插件不用再改核心。
- **落点预览**（2026-11-09）：绘图工具下光标处画一个空心圈，位置 = 按「点下去会怎么取锚点」现算的 `toPoint` 结果（同一格、同一条挂靠线、同样过插件），看得出吸没吸上、强弱磁吸差在哪。它对所有工具都有用、和开没开插件无关，所以是画线核心的功能，不建「绘制」扩展点。拖已有的线、光标工具、出了绘图区时不画。
- 磁吸口径：吸到光标所在那一根的值（线 = 收盘一个值，蜡烛 = 开高低收），吸上时日期也对齐到那一根；弱磁吸半径 12px（TradingView 未公开，取手感值），强磁吸画线时总是吸；**拖已有的线（端点、整条水平线）时强磁吸按弱磁吸算**（`dragging`）：强吸只停在这一根的开高低收上、不跟手，手一抖光标换到隔壁那根还会往反方向跳（负责人 2026-11-09 定）。竖线只用日期（`onlyTime`）：开着磁吸就把日期对齐到那一根，不看高度（拖跨格竖线时点中的格和所属格纵坐标对不上，看高度会随机）。趋势线吸附后两点重合（放大 + 强磁吸点在同一根里）按「太近」处理，不画零长度线。

### 5.4 TradingView 左栏实况（2026-11-09 打开 tradingview.com 图表页逐个展开读出，供以后对照）

| 组 | 子分类与工具 | 用途 | 我们 |
|---|---|---|---|
| Cursors | Cross / Dot / Arrow | 鼠标外观 | 有箭头，够用 |
| | Demonstration | 拖出渐隐轨迹，录屏讲图用 | 不做 |
| | Magic | 未查到说明 | — |
| | Eraser | 点哪条删哪条 | 不做（选中后 Delete） |
| | Values tooltip on long press | 长按弹数值，触屏用 | 不做 |
| Trend tools | LINES：Trendline ⌥T · Ray · Info line · Extended line · Trend angle · Horizontal line ⌥H · Horizontal ray ⌥J · Vertical line ⌥V · Crossline ⌥C | 单根线；Info line 自带涨跌信息框，Trend angle 显示角度，Crossline = 横竖十字 | 见 5.2 |
| | CHANNELS：Parallel channel · Regression trend · Flat top/bottom · Disjoint channel | 平行通道 / 回归通道 / 一边水平的三角 / 不平行的楔形 | 见 5.2 |
| | PITCHFORKS：Pitchfork 及 Schiff / Modified Schiff / Inside | 三点画 Andrews 中线加两边 | 不做 |
| Gann and Fibonacci | FIBONACCI 11 种（回撤 ⌥F、扩展、通道、时间区、扇、圆、螺旋、弧、楔、Pitchfan 等）· GANN 4 种（箱、方格、扇） | 按固定比例 / 角度切价格与时间，短线找反转位 | 不做 |
| Patterns | CHART PATTERNS 6 种（XABCD、Cypher、头肩、ABCD、三角、Three drives）· ELLIOTT WAVES 5 种 · CYCLES（周期线、时间周期、正弦线） | 给形态贴标签、波浪计数、假设固定周期 | 不做 |
| Forecasting and measurement | FORECASTING：Long / Short position · Position forecast · Bars pattern · Ghost feed · Sector | 模拟交易盈亏比 / 预测线 / 复制一段 K 线当投影 / 手画假想 K 线 / Sector 未查到说明 | 不做 |
| | VOLUME-BASED：Anchored VWAP · Fixed range / Anchored volume profile | 锚定成交量加权均价、区间成交量分布 | 不做（宏观序列无成交量） |
| | MEASURERS：Price range · Date range · Date and price range | 量价差 / 天数 / 两者 | 见 5.2 |
| Geometric shapes | BRUSHES：Brush · Highlighter · ARROWS：4 种 · SHAPES：Rectangle ⌥⇧R · 旋转矩形 · Path · Circle · Ellipse · Polyline · Triangle · Arc · Curve · Double curve | 自由手绘与几何图形 | 只考虑矩形（可选），其余交给图片二次编辑 |
| Annotation tools | TEXT AND NOTES：Text · Note · Price note · Pin · Table · Callout · Comment · Price label · Signpost · Flag mark | 文字 / 悬停便签 / 指向价位的便签 / 图钉 / 表格 / 气泡 / 对话框 / 价格标签 / 路标 / 小旗 | 见 5.2 |
| | CONTENT：Image · Post · Idea | 插图片；Post、Idea 是社区发帖 | 不做 |
| Icons | 表情、贴纸、图标 | 装饰 | 不做 |
| 底栏 | Measure | 临时测量尺，松手消失 | 并进区间测量 |
| | Zoom in | 框选放大 | 不做（滚轮能缩放） |
| | Magnets：Weak / Strong magnet · Snap to indicators | 端点吸到最近的开高低收（弱 / 强吸附距离）或指标线 | 见 5.2 |
| | Keep drawing | 画完不退回光标，连续画 | 不做 |
| | Lock：Lock drawings / indicators / all | 防误拖 | 可选 |
| | Hide：drawings / indicators / positions and orders / all | 分类隐藏 | 已有「隐藏全部画线」 |
| | Remove：N drawings / N indicators / both · Always remove locked drawings | 分类删除 | 已有「删除全部画线」 |

TradingView 分组按钮的样式细节（读它的 CSS 得到）：组宽 52px，小三角 11px 宽叠在主按钮右缘，平时 `opacity: 0`，悬停整组时滑入；打开后保持显示、加悬停底色、箭头转 180°。我们的按比例缩小（组 36px、小三角 10px）。

## 仍未做

各类变换（起点=100 / 同比）、四则运算、多张图命名保存、URL 状态、旧图迁移、多图布局、撤销 / 重做。

**撤销 / 重做（设计已定，2026-11-09，未做）**：⌘Z 撤销、⌘⇧Z / Ctrl+Y 重做，同 TradingView。
- **存快照、不做命令模式**：ChartDoc 只有几 KB 且不可变更新，没改的部分新旧版本共用引用，存 100 份也便宜；撤销 = 换回上一份，不用给每种编辑写反操作。（TradingView 是命令模式，因为它的状态大。）
- **不上 store**：项目没装 store 库，文档只有 `useChartDoc` 一处管、所有编辑都经 `setDoc(updater)`。把 `useState<ChartDoc>` 换成一个 `useState({ past, doc, future })`：编辑时把旧 doc 压进 `past`（上限 100）、清空 `future`；撤销 / 重做在两栈间挪。用 state 不用 ref —— 撤销按钮的可点状态要跟着重渲染。对外仍返回 `doc` 与原有编辑动作，另加 `undo / redo / canUndo / canRedo`。
- **什么算一步**：拖画线只在松手记一步（现在本来就是松手才写回文档）；输入框连续打字 500ms 内并成一步；「在编辑器中打开」整张换图也算一步（误换能撤回）。
- **不进历史**：平移 / 缩放、选中态、绘图工具 —— 都不在文档里，天然不进（同 TradingView：看图视角不算改图）。「全部隐藏画线」做之前先查它存不存在文档里。
- **历史不落盘**：刷新即清空，localStorage 照旧只存当前这份。

已做的保存：最后一次显示的图自动存 localStorage（`mtv:chartEditor:doc`，读时走 `parseChartDoc`，坏了 / 校验不过就当空图，并清掉原存档，不留备份——负责人定的）；「查看 JSON」可复制、可粘贴导入。

改文档格式时注意（localStorage 里存着上一版的图，校验不过会静默变空图、原存档被清掉）：`Fit` 在 2026-11 第三轮多了 `alpha / beta / r`（比例点按钮时算好存下），之前只存 `target / start / end` 的旧 JSON 现在会被 `parseChartDoc` 整份拒掉；届时决定兼容（只丢 fit、其余照常载入）还是重算。
