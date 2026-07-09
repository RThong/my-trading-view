# 特色指标 › 攻防（NOBL/QQQ regime）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新视角「特色指标 › 攻防」：上 QQQ 蜡烛、下 NOBL/QQQ 比值线 + 绿(防守)/红(进攻)背景区（均线+迟滞判定）。

**Architecture:** 纯展示层派生。加抓 NOBL 日线并放开 `/api/price/NOBL`；前端拉 QQQ+NOBL 两条价，纯函数算比值与 regime，复用现有 `usePaneChartStack`+`PaneChartView`（含 histogram 全高背景）渲染两个 pane。不碰 `/api/regime`。

**Tech Stack:** TypeScript on Bun, React 19, SWR, lightweight-charts ^5, bun test。

## Global Constraints

- 全 TypeScript on Bun，不引新依赖，不改 `/api/regime`、不改 `market_series`。
- NOBL 只进 vrpInputs 的**价格腿循环**（纯 price_eod 抓取），**不**加进任何 VRP 标的配置。
- regime 判定：trailing SMA(maLen) + 迟滞带 band；`ratio/ma-1 > band`→defense，`< -band`→offense，带内维持上一状态；前 maLen-1 点 neutral。因果、历史不 repaint。
- 默认 `MA_LEN=100`、`BAND=0.05`（起始值，常量，便于目视后调）。
- 比值 = NOBL.close / QQQ.close。绿=defense、红=offense。
- 本视角恒日频，忽略全局 interval。
- 复用现成组件：`usePaneChartStack`/`PaneChartView`/`Spec` 类型（`src/web/panels/assetChart.hooks.ts`）。
- 注释中文解释「为什么」。提交中文 `feat:` 前缀 + `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。

---

## File Structure

- **Modify** `src/server/jobs/vrpInputs.ts` — 价格腿循环加 `'NOBL'`。
- **Modify** `src/server/config.ts` — 加 `PRICE_ONLY_UNDERLYINGS`。
- **Modify** `src/server/routes/price.ts` — 允许名单并入 `PRICE_ONLY_UNDERLYINGS`。
- **Create** `src/web/panels/attackDefense.hooks.ts` — `ratioSeries` + `regimeZones` + 常量。
- **Create** `src/web/panels/attackDefense.hooks.test.ts` — 纯函数测试。
- **Create** `src/web/panels/AttackDefensePanel.tsx` — 两 pane 面板。
- **Modify** `src/web/App.tsx` — 新增「特色指标」视角。

---

## Task 1: 放开 NOBL 日线数据

**Files:**
- Modify: `src/server/jobs/vrpInputs.ts:98`
- Modify: `src/server/config.ts:18`
- Modify: `src/server/routes/price.ts`

**Interfaces:**
- Produces: `/api/price/NOBL` 返回 NOBL 日 OHLC（数据抓取后）；`PRICE_ONLY_UNDERLYINGS: string[]`。

- [ ] **Step 1: vrpInputs 价格腿加 NOBL**

`src/server/jobs/vrpInputs.ts` 第 98 行：
```ts
    for (const u of ['SPY', 'QQQ', 'GLD', 'USO', 'TLT'] as const) {
```
改为：
```ts
    for (const u of ['SPY', 'QQQ', 'GLD', 'USO', 'TLT', 'NOBL'] as const) {
```
（这是纯价格腿循环，只写 price_eod；NOBL 不涉及任何 VRP 隐含腿。）

- [ ] **Step 2: config 加价格专用名单**

`src/server/config.ts`，在 `ALL_OPTION_UNDERLYINGS`（第 18 行）后加：
```ts
// 仅作价格序列(非期权标的),给 /api/price 白名单用。NOBL=股息贵族 ETF(攻防指标的防御腿)。
export const PRICE_ONLY_UNDERLYINGS = ['NOBL'];
```

- [ ] **Step 3: price 路由并入名单**

`src/server/routes/price.ts`：把 import
```ts
import { ALL_OPTION_UNDERLYINGS } from '../config';
```
改为：
```ts
import { ALL_OPTION_UNDERLYINGS, PRICE_ONLY_UNDERLYINGS } from '../config';
```
把允许判断
```ts
    if (!ALL_OPTION_UNDERLYINGS.includes(u)) {
```
改为：
```ts
    if (![...ALL_OPTION_UNDERLYINGS, ...PRICE_ONLY_UNDERLYINGS].includes(u)) {
```

- [ ] **Step 4: 类型检查**

Run: `bunx tsc --noEmit`
Expected: 无错误。

- [ ] **Step 5: 提交**

```bash
git add src/server/jobs/vrpInputs.ts src/server/config.ts src/server/routes/price.ts
git commit -m "feat(server): 加抓 NOBL 日线并放开 /api/price/NOBL(攻防指标数据)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

> 注：NOBL 历史数据由 controller 在验证时跑价格抓取（Yahoo 降级即可，无需 OpenD）填充；implementer 不需联网抓数。

---

## Task 2: 纯函数 ratioSeries + regimeZones（可单测）

**Files:**
- Create: `src/web/panels/attackDefense.hooks.ts`
- Test: `src/web/panels/attackDefense.hooks.test.ts`

**Interfaces:**
- Consumes: `PriceBar` type from `./assetChart.hooks`（`{date,open,high,low,close}`，close 非空）。
- Produces:
  - `MA_LEN = 100`、`BAND = 0.05`。
  - `ratioSeries(nobl: PriceBar[], qqq: PriceBar[]): { date: string; value: number }[]` — 按日期内联相除 nobl/qqq（close）；qqq 缺该日或 close=0 → 跳过；任一缺失 → `[]`。
  - `Regime = 'defense' | 'offense' | 'neutral'`；`regimeZones(ratio, maLen, band): { date: string; regime: Regime }[]`。

- [ ] **Step 1: 写失败测试**

```ts
// src/web/panels/attackDefense.hooks.test.ts
import { describe, expect, it } from 'bun:test';
import { ratioSeries, regimeZones } from './attackDefense.hooks';

const bar = (date: string, close: number) => ({ date, open: close, high: close, low: close, close });

describe('ratioSeries', () => {
  it('按日期内联相除,qqq 缺的日期跳过', () => {
    const nobl = [bar('d1', 50), bar('d2', 52), bar('d3', 51)];
    const qqq = [bar('d1', 400), bar('d2', 410)]; // 缺 d3
    const r = ratioSeries(nobl, qqq);
    expect(r.map((p) => p.date)).toEqual(['d1', 'd2']);
    expect(r[0].value).toBeCloseTo(0.125);   // 50/400
    expect(r[1].value).toBeCloseTo(0.126829); // 52/410
  });
  it('任一缺失 → []', () => {
    expect(ratioSeries([], [bar('d1', 1)])).toEqual([]);
    expect(ratioSeries([bar('d1', 1)], [])).toEqual([]);
  });
});

describe('regimeZones: 均线+迟滞', () => {
  it('前 maLen-1 neutral;上穿+band→defense;带内维持;下穿-band→offense', () => {
    const vals = [1, 1, 1, 1.1, 1.02, 0.85];
    const ratio = vals.map((v, i) => ({ date: `d${i}`, value: v }));
    const z = regimeZones(ratio, 3, 0.05).map((p) => p.regime);
    expect(z).toEqual(['neutral', 'neutral', 'neutral', 'defense', 'defense', 'offense']);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/web/panels/attackDefense.hooks.test.ts`
Expected: FAIL（`Cannot find module './attackDefense.hooks'`）

- [ ] **Step 3: 写实现**

```ts
// src/web/panels/attackDefense.hooks.ts
// 攻防指标数据层:NOBL/QQQ 比值 + 均线迟滞 regime。纯函数,便于单测。
import type { PriceBar } from './assetChart.hooks';

export const MA_LEN = 100;   // trailing 均线长度(日),中期
export const BAND = 0.05;    // 迟滞带 ±5%,滤小颠簸

export type Regime = 'defense' | 'offense' | 'neutral';

/** NOBL/QQQ 按日期内联相除(close)。qqq 缺该日或为 0 → 跳过;任一序列空 → []。 */
export function ratioSeries(nobl: PriceBar[], qqq: PriceBar[]): { date: string; value: number }[] {
  if (!nobl.length || !qqq.length) return [];
  const q = new Map(qqq.map((b) => [b.date, b.close]));
  return nobl.flatMap((b) => {
    const qc = q.get(b.date);
    return qc ? [{ date: b.date, value: b.close / qc }] : [];
  });
}

/** trailing SMA(maLen) + 迟滞:偏离 >band→defense,<-band→offense,带内维持上一状态。
 *  前 maLen-1 点无均线 → neutral。因果(不看未来),历史不 repaint。 */
export function regimeZones(
  ratio: { date: string; value: number }[], maLen: number, band: number,
): { date: string; regime: Regime }[] {
  const out: { date: string; regime: Regime }[] = [];
  let regime: Regime = 'neutral';
  let sum = 0;
  const win: number[] = [];

  for (const p of ratio) {
    win.push(p.value);
    sum += p.value;
    if (win.length > maLen) sum -= win.shift()!;

    if (win.length < maLen) {
      out.push({ date: p.date, regime: 'neutral' });
      continue;
    }
    const s = p.value / (sum / maLen) - 1; // 相对均线偏离
    if (s > band) regime = 'defense';
    else if (s < -band) regime = 'offense'; // 否则维持(迟滞)
    out.push({ date: p.date, regime });
  }
  return out;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test src/web/panels/attackDefense.hooks.test.ts`
Expected: PASS（4 断言全绿）

- [ ] **Step 5: 提交**

```bash
git add src/web/panels/attackDefense.hooks.ts src/web/panels/attackDefense.hooks.test.ts
git commit -m "feat(featured): 攻防数据层 ratioSeries + regimeZones(均线迟滞)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: AttackDefensePanel + App 新视角

UI 装配，无独立单测（渲染靠运行 App 目视）。

**Files:**
- Create: `src/web/panels/AttackDefensePanel.tsx`
- Modify: `src/web/App.tsx`

**Interfaces:**
- Consumes: Task 2 的 `ratioSeries`/`regimeZones`/`MA_LEN`/`BAND`/`Regime`；`usePaneChartStack`, `PriceBar`, `Spec`, `PaneDef` from `./assetChart.hooks`；`PaneChartView` from `./PaneChartView`。

- [ ] **Step 1: 写 AttackDefensePanel**

```tsx
// src/web/panels/AttackDefensePanel.tsx
import { useRef } from 'react';
import useSWR from 'swr';
import { usePaneChartStack, type Spec, type PaneDef, type PriceBar } from './assetChart.hooks';
import { PaneChartView } from './PaneChartView';
import { ratioSeries, regimeZones, MA_LEN, BAND } from './attackDefense.hooks';

// 攻防:上 QQQ 蜡烛、下 NOBL/QQQ 比值 + 绿(防守)/红(进攻)背景区。恒日频,不吃全局 interval。
const BG_GREEN = 'rgba(34,197,94,0.35)';
const BG_RED = 'rgba(239,68,68,0.35)';
const BG_NONE = 'rgba(0,0,0,0)';
const RATIO_COLOR = '#d4d4d8'; // 中性亮线,压在红绿背景上清楚

const PANE_DEFS: PaneDef[] = [
  { key: 'qqq', label: 'QQQ', series: ['qqq'] },
  { key: 'ad', label: 'NOBL/QQQ', series: ['ad'] },
];
const SERIES_NAME = { qqq: 'QQQ', ad: 'NOBL/QQQ' };
const COLORS = { ad: RATIO_COLOR };

const getJson = (url: string) => fetch(url).then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); });
const SWR_OPTS = { revalidateOnFocus: false, revalidateIfStale: false, revalidateOnReconnect: false };

export function AttackDefensePanel() {
  const containerRef = useRef<HTMLDivElement>(null);
  const qq = useSWR<PriceBar[]>('/api/price/QQQ', getJson, SWR_OPTS);
  const nb = useSWR<PriceBar[]>('/api/price/NOBL', getJson, SWR_OPTS);

  const qqq = qq.data ?? [];
  const nobl = nb.data ?? [];
  const ratio = ratioSeries(nobl, qqq);
  const zones = regimeZones(ratio, MA_LEN, BAND);

  const bgColor = (regime: string) => (regime === 'defense' ? BG_GREEN : regime === 'offense' ? BG_RED : BG_NONE);

  const specs: Spec[] = [
    { key: 'qqq', pane: 0, kind: 'candle', title: 'QQQ',
      data: qqq.map((b) => ({ time: b.date, open: b.open ?? b.close, high: b.high ?? b.close, low: b.low ?? b.close, close: b.close })) },
    // 背景先画(z-order 在线下方);全高靠 priceScaleId。
    { key: 'ad-bg', pane: 1, kind: 'histogram', title: '', priceScaleId: 'bg-ad',
      data: zones.map((z) => ({ time: z.date, value: z.regime === 'neutral' ? 0 : 1, color: bgColor(z.regime) })) },
    { key: 'ad', pane: 1, kind: 'line', color: RATIO_COLOR, title: 'NOBL/QQQ',
      data: ratio.map((p) => ({ time: p.date, value: p.value })) },
  ];

  const { order, collapsed, move, toggle, cells, hovering, tops } = usePaneChartStack(containerRef, PANE_DEFS, PANE_DEFS.length, specs);

  const error = (qq.error ?? nb.error) as Error | undefined;
  const isLoading = qq.isLoading || nb.isLoading;

  return (
    <PaneChartView
      containerRef={containerRef} paneDefs={PANE_DEFS} paneCount={PANE_DEFS.length}
      order={order} collapsed={collapsed} move={move} toggle={toggle}
      cells={cells} hovering={hovering} tops={tops}
      seriesName={SERIES_NAME} colors={COLORS} isLoading={isLoading} error={error}
    />
  );
}
```

- [ ] **Step 2: App.tsx 加「特色指标」视角**

`src/web/App.tsx` 顶部 import 加：
```tsx
import { AttackDefensePanel } from './panels/AttackDefensePanel';
```
在 `PERSPECTIVES` 数组里、`creditCurve` 视角之后加一个视角：
```tsx
  {
    id: 'featured', label: '特色指标',
    tabs: [{ id: 'attack_defense', label: '攻防' }],
    render: () => <AttackDefensePanel />,
  },
```

- [ ] **Step 3: 类型检查 + 全量测试**

Run: `bunx tsc --noEmit && bun test`
Expected: tsc 无错误；测试全绿。

- [ ] **Step 4: 目视验证（controller 做；implementer 无浏览器/无 NOBL 数据则报 DONE_WITH_CONCERNS 注明待做）**

controller 先跑 NOBL 价格抓取填数（Yahoo 降级），再浏览器进「特色指标 → 攻防」：上 pane QQQ 蜡烛，下 pane NOBL/QQQ 比值线 + 绿/红背景区；regime 与比值走势一致（比值相对 100 日均线走强段为绿、走弱段为红）；参数是否要调由 controller 反馈。

- [ ] **Step 5: 提交**

```bash
git add src/web/panels/AttackDefensePanel.tsx src/web/App.tsx
git commit -m "feat(featured): 特色指标 › 攻防 面板(QQQ 蜡烛 + NOBL/QQQ regime 背景)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- NOBL 数据放开 → Task 1。
- 比值 + regime 纯函数 + 测试 → Task 2。
- 两 pane（QQQ 蜡烛 / 比值+绿红背景）→ Task 3 specs。
- 新视角「特色指标 › 攻防」→ Task 3 Step 2。
- 均线+迟滞、默认 100/±5%、因果 → Task 2 `regimeZones` + 常量。
- 复用 usePaneChartStack/PaneChartView/histogram 背景 → Task 3。
- 恒日频忽略 interval → 面板不吃 interval、不 aggregate。
- NOBL 只进价格腿 → Task 1 Step 1 注释。

**Placeholder scan:** 无 TBD/TODO;代码步骤含完整代码。

**Type consistency:** `ratioSeries(nobl,qqq): {date,value}[]`、`regimeZones(ratio,maLen,band): {date,regime}[]`、`Regime`、`Spec`(candle/line/histogram)、`PaneDef`、`PriceBar` 均与 assetChart.hooks 现有类型一致;histogram 用 `priceScaleId` 全高(与情绪背景同机制)。
