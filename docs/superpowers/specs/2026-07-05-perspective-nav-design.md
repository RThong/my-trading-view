# 视角导航(两级 tab)设计

日期:2026-07-05

## 背景 / 目标

当前 dashboard 只有一个"视角":期权分资产。[App.tsx](../../../src/web/App.tsx) 里一个扁平的
`TABS` 数组(每资产一个横 tab),全部渲染同一个 `AssetChart`。

要在最外层加一个**视角竖轴**:左侧竖 rail 选"视角"(期权 / 流动性 / 拥挤度 / 信用 …,按数据维度分),
每个视角内部再有**自己的**横 tab(期权视角横 tab = 资产;其它视角横 tab 含义各自不同)。
两级 tab:竖(视角)× 横(视角内子页)。

## 非目标(明确砍掉)

- **不建空视角壳**:本次只把"期权"视角搬进新框架并跑通。流动性/拥挤度等视角等对应数据
  (FRED/regime 那套)抓下来后,再按同样 config 形状加一条,避免点进去一片空白。
- **不做 URL hash 深链**(刷新/收藏记住位置):现状纯 `useState`,保持;以后要再加。
- **不做通用视图插件注册 / 懒加载模块系统**:个人 dashboard,config 驱动即可。

## 架构

### 核心数据结构:嵌套 config

把扁平 `TABS` 收进 `PERSPECTIVES`,每个视角自带横 tab 列表和渲染方式(各视角内容异构):

```ts
type Perspective = {
  id: string;
  label: string;
  tabs: { id: string; label: string }[];
  render: (tabId: string, interval: Interval) => ReactNode;
};

const PERSPECTIVES: Perspective[] = [
  {
    id: 'options',
    label: '期权',
    tabs: ASSET_TABS,                       // 现有 7 个资产原样搬入
    render: (tabId, interval) => {
      const a = ASSET_TABS.find((t) => t.id === tabId)!;
      return <AssetChart interval={interval} underlying={a.underlying} vrpUnderlying={a.vrpUnderlying} />;
    },
  },
  // 流动性 / 拥挤度 / 信用 … 数据到位后,按同样形状 push
];
```

现有的 7 条资产定义(`underlying`/`vrpUnderlying`)保留为 `ASSET_TABS`,供期权视角的 `render` 用。

### 组件复用:TabBar 加竖排变体

[TabBar.tsx](../../../src/web/components/TabBar.tsx) 加一个 `vertical?: boolean` prop。
横排 = 现状(`flex ... border-b`);竖排 = `flex-col ... border-r`。不新写组件。

### App 状态

- `activePerspective: string` —— 当前视角 id。
- `tabByPerspective: Record<string, string>` —— 每个视角**记住自己上次停在的横 tab**,
  切视角切回来不跳回第一个。首次进入某视角默认其 `tabs[0].id`。
- keep-alive:现有"访问过的 tab 不卸载"保留,`seen` 的 key 从 `tabId` 改为 `${perspId}:${tabId}`。
  切视角、切资产都保留各自的显隐/缩放等内存状态。

### 布局

```
┌────┬──────────────────────────────────────┐
│期权│  [SPY][QQQ][VIX][TLT][GLD][USO][BTC]   │ ← 横 tab(当前视角的)
│流动│  ┌──────────────────────────────────┐ │
│拥挤│  │        视角内容(render 输出)      │ │
│ …  │  └──────────────────────────────────┘ │
└────┴──────────────────────────────────────┘
 ↑竖 rail(视角)
```

Header(interval 选择器)保持全局。interval 对期权视角有意义;将来某些视角若与 interval 无关,
其 `render` 自行忽略该参数即可,不为此加分支。

## 数据流

竖 rail 点击 → 设 `activePerspective` → 顶部横 TabBar 换成该视角的 `tabs` →
读 `tabByPerspective[persp]`(无则 `tabs[0]`)决定活跃横 tab →
`main` 区遍历 `seen` 里属于当前视角的 `${persp}:${tab}`,活跃的显示、其余 `hidden`,各自调 `perspective.render`。

## 测试 / 验证

- 无新增业务逻辑,纯结构 + config 重排。现有 [chart.test.ts](../../../src/web/lib/chart.test.ts) 应继续通过。
- 手动验证:切视角横 tab 跟随切换;各横 tab 独立保留缩放状态;期权视角 7 个资产与改造前行为一致。

## 影响文件

- `src/web/App.tsx` —— 扁平 TABS → `PERSPECTIVES` + `ASSET_TABS`;两级 tab 渲染;keep-alive key 改造。
- `src/web/components/TabBar.tsx` —— 加 `vertical` 变体。
- (可能)`src/web/styles.css` —— 若需布局微调。
