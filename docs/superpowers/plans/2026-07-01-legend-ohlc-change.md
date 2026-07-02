# 图例加 OHLC + Δ + Δ% Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** AssetChart 悬停图例从「单值」扩成:蜡烛显示 O/H/L/C + Δ + Δ%,线显示 值 + Δ + Δ%(Δ 对比前一根/点,涨绿跌红)。

**Architecture:** 纯函数 `changeStats(cur, prev)` 算 Δ/Δ%(可离线单测);`useCrosshairLegend` 用 `param.logical` + `series.dataByIndex(logical-1)` 取前值,把返回从 `vals: Record<string,number>` 换成 `cells: Record<string,LegendCell>`;AssetChart 悬停图例按 kind 渲染。显示时机不变(仍只悬停)。

**Tech Stack:** React 19 + lightweight-charts v5 + TypeScript on Bun;`bun test`(仅纯函数);前端其余走 `tsc --noEmit` + 手动。

## Global Constraints

- 全 TypeScript on Bun;无新依赖;中文注释。
- Δ = 当前 − 前值(蜡烛用 close);Δ% = `Δ / |前值| * 100`(绝对值分母,符号跟随 Δ);前值无 → 不显示 Δ/Δ%;前值 0 → 有 Δ 无 %。
- 上色:Δ>0 绿 `#22c55e`、Δ<0 红 `#ef4444`、Δ=0/无 → 不特殊上色;数值 `.toFixed(2)`,Δ 带 +/−,Δ% 带 +/− 与 %。
- 显示时机不变:只悬停显示;不改右轴 tag、不加常驻图例。
- 前端无测试框架,不新建;只有纯函数 `changeStats` 用 bun:test。

---

### Task 1: 纯函数 `changeStats` + 单测

**Files:**
- Modify: `src/web/lib/chart.ts`(加导出函数)
- Test: `src/web/lib/chart.test.ts`(新建)

**Interfaces:**
- Produces: `changeStats(cur: number, prev: number | undefined): { delta: number; pct: number | null } | null` —— `prev===undefined`→`null`;`delta=cur-prev`;`pct = prev===0 ? null : delta/Math.abs(prev)*100`。

- [ ] **Step 1: 写失败测试**

新建 `src/web/lib/chart.test.ts`:
```ts
import { describe, test, expect } from 'bun:test';
import { changeStats } from './chart';

describe('changeStats', () => {
  test('正常涨幅', () => {
    const r = changeStats(6.32, 5.86)!;
    expect(r.delta).toBeCloseTo(0.46, 2);
    expect(r.pct!).toBeCloseTo(7.85, 1);
  });

  test('负基数:值涨则 % 为正(分母用 |prev|)', () => {
    expect(changeStats(-1, -2)).toEqual({ delta: 1, pct: 50 });
  });

  test('前值为 0:有 Δ,无 %(除零)', () => {
    expect(changeStats(3, 0)).toEqual({ delta: 3, pct: null });
  });

  test('无前值(第一根):返回 null', () => {
    expect(changeStats(3, undefined)).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/web/lib/chart.test.ts`
Expected: FAIL —— `changeStats` 未导出。

- [ ] **Step 3: 实现 changeStats**

在 `src/web/lib/chart.ts`,`Bar` 类型定义之后(约第 5 行后)加:
```ts
/** 竖线处相对前一根/点的变化。prev 无(第一根)→ null;prev=0 → 有 delta 无 pct(除零)。
 *  pct 用 |prev| 做分母,保证符号跟随 delta(本盘有会穿零的序列:skew / VRP / V1−V3)。 */
export function changeStats(cur: number, prev: number | undefined): { delta: number; pct: number | null } | null {
  if (prev === undefined) return null;
  const delta = cur - prev;
  return { delta, pct: prev === 0 ? null : (delta / Math.abs(prev)) * 100 };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test src/web/lib/chart.test.ts`
Expected: 4 pass。

- [ ] **Step 5: 提交**

```bash
git add src/web/lib/chart.ts src/web/lib/chart.test.ts
git commit -m "feat(web): 加 changeStats 纯函数(图例 Δ/Δ%,|prev| 分母)"
```

---

### Task 2: 图例捕获并渲染 OHLC + Δ + Δ%

**Files:**
- Modify: `src/web/panels/assetChart.hooks.ts`(加 `LegendCell` 类型;`useCrosshairLegend` 的 `vals`→`cells`)
- Modify: `src/web/panels/AssetChart.tsx`(悬停图例渲染)
- Test: 无单测(crosshair/渲染;`tsc --noEmit` + 手动)

**Interfaces:**
- Consumes: `changeStats`(Task 1)。
- Produces: `useCrosshairLegend(...)` 返回 `{ cells: Record<string, LegendCell>, hovering, tops }`(把 `vals` 换成 `cells`);
  `LegendCell = { kind:'candle'; open;high;low;close; delta:number|null; pct:number|null } | { kind:'line'; value; delta:number|null; pct:number|null }`。

- [ ] **Step 1: 加 LegendCell 类型 + import changeStats**

`src/web/panels/assetChart.hooks.ts`:
- 顶部 import(第 8 行 `import { CHART_OPTIONS, aggregate, aggregateBars, type LinePoint, type Bar } from '../lib/chart';`)改为加入 `changeStats`:
```ts
import { CHART_OPTIONS, aggregate, aggregateBars, changeStats, type LinePoint, type Bar } from '../lib/chart';
```
- 在类型区(`export type LineSpec = ...` 附近)加:
```ts
export type LegendCell =
  | { kind: 'candle'; open: number; high: number; low: number; close: number; delta: number | null; pct: number | null }
  | { kind: 'line'; value: number; delta: number | null; pct: number | null };
```

- [ ] **Step 2: 改 useCrosshairLegend —— vals→cells,捕获 OHLC+Δ+Δ%**

`src/web/panels/assetChart.hooks.ts` 的 `useCrosshairLegend`:把 `vals` state 与 crosshair handler 整段替换为:
```ts
  const [cells, setCells] = useState<Record<string, LegendCell>>({}); // 竖线处各 series 的图例格
  const [tops, setTops] = useState<number[]>([]);                     // 各 pane 顶部像素偏移

  // 竖线滑动:读各 series 当前点(蜡烛 OHLC / 线 value)+ 用 logical-1 取前值算 Δ/Δ%。不悬停 → 空。
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const handler = (param: { seriesData: Map<unknown, unknown>; logical?: number }) => {
      const next: Record<string, LegendCell> = {};
      const prevIdx = param.logical == null ? undefined : param.logical - 1;
      for (const [key, s] of seriesRef.current) {
        const d = param.seriesData.get(s) as
          { value?: number; open?: number; high?: number; low?: number; close?: number } | undefined;
        if (!d) continue;
        const prev = prevIdx == null ? undefined
          : (s.dataByIndex(prevIdx) as { value?: number; close?: number } | null);
        if (typeof d.open === 'number' && typeof d.close === 'number') {
          const st = changeStats(d.close, typeof prev?.close === 'number' ? prev.close : undefined);
          next[key] = { kind: 'candle', open: d.open, high: d.high!, low: d.low!, close: d.close, delta: st?.delta ?? null, pct: st?.pct ?? null };
        } else if (typeof d.value === 'number') {
          const st = changeStats(d.value, typeof prev?.value === 'number' ? prev.value : undefined);
          next[key] = { kind: 'line', value: d.value, delta: st?.delta ?? null, pct: st?.pct ?? null };
        }
      }
      setCells(next);
    };
    chart.subscribeCrosshairMove(handler);
    return () => chart.unsubscribeCrosshairMove(handler);
  }, [chartRef, seriesRef]);
```
(下面的 tops 那个 useEffect 不动。)

- [ ] **Step 3: 改 useCrosshairLegend 的返回**

同文件,该 hook 末尾 `const hovering = Object.keys(vals).length > 0;` 与 `return { vals, hovering, tops };` 改为:
```ts
  const hovering = Object.keys(cells).length > 0; // 鼠标在图内、crosshair 有值
  return { cells, hovering, tops };
```

- [ ] **Step 4: AssetChart.tsx 消费 cells + 渲染**

`src/web/panels/AssetChart.tsx`:
- 第 34 行 `const { vals, hovering, tops } = useCrosshairLegend(...)` 改为:
```ts
  const { cells, hovering, tops } = useCrosshairLegend(chartRef, seriesRef, containerRef, order, collapsed);
```
- 悬停图例里 `def.series.map(...)` 整段(现在渲染 `{seriesName[sk]} {v==null?'—':v.toFixed(2)}`)替换为:
```tsx
              {def.series.map((sk) => {
                const c = cells[sk];
                const color = COLORS[sk as keyof typeof COLORS];
                if (!c) return <div key={sk} style={{ color }}>{seriesName[sk]} —</div>;
                const body = c.kind === 'candle'
                  ? `O ${c.open.toFixed(2)} H ${c.high.toFixed(2)} L ${c.low.toFixed(2)} C ${c.close.toFixed(2)}`
                  : c.value.toFixed(2);
                const dColor = c.delta == null ? undefined : c.delta > 0 ? '#22c55e' : c.delta < 0 ? '#ef4444' : undefined;
                const dTxt = c.delta == null ? null
                  : `${c.delta >= 0 ? '+' : ''}${c.delta.toFixed(2)}${c.pct == null ? '' : ` (${c.pct >= 0 ? '+' : ''}${c.pct.toFixed(2)}%)`}`;
                return (
                  <div key={sk} style={{ color }}>
                    {seriesName[sk]} {body}
                    {dTxt && <span style={{ color: dColor }}> {dTxt}</span>}
                  </div>
                );
              })}
```

- [ ] **Step 5: 类型检查 + 构建 + 手动验证**

Run: `bunx tsc --noEmit && bun run build:web 2>&1 | tail -2`
Expected: tsc 无错误;vite build 成功。
手动(`bun run dev`,打开任意 tab):
- 悬停现货蜡烛 pane → 显示 `现货 O.. H.. L.. C..  +Δ (+Δ%)`,Δ 涨绿跌红;
- 悬停线 pane(IV/skew/VRP/V1−V3)→ 显示 `名 值  Δ (Δ%)`;
- 竖线移到最左第一根 → 只显示 OHLC/值、无 Δ 段;
- 不悬停 → 图例不显示(不挡线),行为同旧。

- [ ] **Step 6: 提交**

```bash
git add src/web/panels/assetChart.hooks.ts src/web/panels/AssetChart.tsx
git commit -m "feat(web): 悬停图例显示 OHLC/值 + Δ + Δ%(涨绿跌红)"
```

---

## Self-Review

**Spec coverage:**
- changeStats(负基数 |prev|、前值0、无前值)+ 单测 → Task 1 ✓
- useCrosshairLegend 用 param.logical + dataByIndex 取前值、vals→cells(candle/line 两形)→ Task 2 Step 1-3 ✓
- 渲染 OHLC/值 + Δ + Δ%、涨绿跌红、无前值不显示 Δ、无 cell 显示 — → Task 2 Step 4 ✓
- 显示时机不变(hovering 仍按 cells 是否非空)→ Task 2 Step 3 ✓
- Δ% = Δ/|prev|、前值0 无 % → Task 1(changeStats)✓
- 测试:changeStats 单测 + tsc/build/手动 → Task 1 / Task 2 Step 5 ✓

**Placeholder scan:** 无 TBD/TODO;每 code step 给全代码;命令带预期。

**Type consistency:** `changeStats(cur, prev) → {delta;pct}|null`(Task1)在 Task2 hook 里 `st?.delta ?? null` / `st?.pct ?? null` 消费一致;`LegendCell` 的 candle/line 两形与渲染的 `c.kind==='candle'` 分支字段(open/high/low/close/value/delta/pct)逐一对应;hook 返回 `cells` 与 AssetChart 解构 `cells` 一致;`hovering` 判据从 vals 改 cells 同步。
