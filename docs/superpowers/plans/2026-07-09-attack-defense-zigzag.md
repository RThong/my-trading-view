# 攻防 regime 改用 ZigZag 摆动检测 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「攻防」regime 判定从均线迟滞换成 ZigZag 摆动检测（吸附极值），使攻防区边界精确落在比值真实波峰/波谷上；pending 待定腿用淡色。

**Architecture:** 重写 `regimeZones` 为 ZigZag（跟踪波峰/波谷,反转 pct 确认并吸附到极值点,逐点按腿方向上色,末腿 pending）。面板 `bgColor` 加 pending 淡色。`ratioSeries`、图表结构不动。

**Tech Stack:** TypeScript on Bun, React 19, lightweight-charts ^5, bun test。无新依赖（手写 ZigZag，主流 TA 库无可用实现）。

## Global Constraints

- 不引新依赖，手写 ZigZag。
- `SWING_PCT = 0.08` 替换 `MA_LEN`/`BAND`。
- `regimeZones(ratio, pct): { date, regime, pending }[]`；`Regime = 'defense'|'offense'|'neutral'`。
- 腿方向:结束于**峰**的腿=defense(上行)、结束于**谷**的腿=offense(下行);**首拐点前**段同理上色(非 neutral)。
- 拐点 idx **吸附到极值点**(非确认点)。末腿 `pending:true`。无拐点 → 全 neutral。
- pending 段背景更淡(确认段 alpha 0.35 / pending 0.15)。
- `ratioSeries`、QQQ 蜡烛、比值线、useMemo、两 pane 结构不动。Q2(useMemo 收进 hook)本次不做。
- 注释中文解释「为什么」。提交中文 `refactor:`/`test:` 前缀 + `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。

---

## File Structure

- **Modify** `src/web/panels/attackDefense.hooks.ts` — 删 `MA_LEN`/`BAND` 加 `SWING_PCT`；重写 `regimeZones`（`Regime` 类型加 `pending` 字段到返回值；`ratioSeries` 不动）。
- **Modify** `src/web/panels/attackDefense.hooks.test.ts` — `regimeZones` 测试改 ZigZag 行为（`ratioSeries` 测试保留）。
- **Modify** `src/web/panels/AttackDefensePanel.tsx` — `bgColor(regime, pending)` 加淡色；histogram data 传 `z.pending`。

---

## Task 1: regimeZones 改 ZigZag（可单测）

**Files:**
- Modify: `src/web/panels/attackDefense.hooks.ts`
- Test: `src/web/panels/attackDefense.hooks.test.ts`

**Interfaces:**
- Produces:
  - `SWING_PCT = 0.08`（替换 `MA_LEN`/`BAND`）。
  - `regimeZones(ratio: {date,value}[], pct: number): { date: string; regime: Regime; pending: boolean }[]`。
  - `Regime` 不变（`'defense'|'offense'|'neutral'`）。`ratioSeries` 不变。

- [ ] **Step 1: 改测试（删旧 regimeZones 测试块,写新 ZigZag 测试）**

在 `src/web/panels/attackDefense.hooks.test.ts` 中，**保留** `ratioSeries` 的 describe 块不动，把 `regimeZones` 的 describe 块整块替换为：

```ts
describe('regimeZones: ZigZag 摆动(吸附极值)', () => {
  const mk = (vals: number[]) => vals.map((v, i) => ({ date: `d${i}`, value: v }));

  it('结束于峰=defense、结束于谷=offense;拐点吸附极值;首拐点前也上色;末腿 pending', () => {
    // 升到峰(idx2=1.20)→回落确认峰→跌到谷(idx4=1.00)→反弹确认谷→再升(末腿待定)
    const r = regimeZones(mk([1.00, 1.05, 1.20, 1.05, 1.00, 1.15, 1.25]), 0.10);
    expect(r.map((p) => p.regime)).toEqual(
      ['defense', 'defense', 'defense', 'offense', 'offense', 'defense', 'defense']);
    expect(r.map((p) => p.pending)).toEqual([false, false, false, false, false, true, true]);
  });

  it('不够 pct 的小回撤不产生拐点 → 全 neutral', () => {
    const r = regimeZones(mk([1.00, 1.03, 0.98, 1.02]), 0.10);
    expect(r.every((p) => p.regime === 'neutral')).toBe(true);
  });

  it('空输入 → []', () => expect(regimeZones([], 0.10)).toEqual([]));
});
```

同时把顶部 import 里若引用了已删的 `MA_LEN`/`BAND` 去掉（该测试文件原本 import `ratioSeries, regimeZones`，未 import 常量则无需改）。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/web/panels/attackDefense.hooks.test.ts`
Expected: FAIL（新断言与旧均线实现不符 / 返回值无 `pending` 字段）。

- [ ] **Step 3: 重写实现**

在 `src/web/panels/attackDefense.hooks.ts`：把
```ts
export const MA_LEN = 100;   // (旧值,可能已是 150)
export const BAND = 0.05;    // (旧值,可能已是 0.12)
```
替换为：
```ts
export const SWING_PCT = 0.08;  // ZigZag 反转阈值:摆动 ≥8% 才算一次大级别攻防切换
```
把整个 `regimeZones` 函数替换为：
```ts
/** ZigZag 摆动检测(吸附极值):跟踪自上个拐点的波峰/波谷,反转 pct 确认拐点并回贴到极值点。
 *  腿方向 = 走向该腿终点:结束于峰=上行(defense)、结束于谷=下行(offense);首拐点前同理。
 *  末腿(最后拐点之后)未确认 → pending。无拐点 → 全 neutral。 */
export function regimeZones(
  ratio: { date: string; value: number }[], pct: number,
): { date: string; regime: Regime; pending: boolean }[] {
  const n = ratio.length;
  if (n === 0) return [];

  type Pivot = { idx: number; kind: 'peak' | 'trough' };
  const pivots: Pivot[] = [];
  let dir: 0 | 1 | -1 = 0; // 0 未定, 1 上行腿, -1 下行腿
  let hiIdx = 0, hiVal = ratio[0].value;
  let loIdx = 0, loVal = ratio[0].value;

  for (let i = 1; i < n; i++) {
    const v = ratio[i].value;
    if (v > hiVal) { hiVal = v; hiIdx = i; }
    if (v < loVal) { loVal = v; loIdx = i; }

    if (dir >= 0 && v <= hiVal * (1 - pct)) {
      // 从波峰回落 pct → 确认峰(吸附到 hiIdx),转下行,重置波谷跟踪
      pivots.push({ idx: hiIdx, kind: 'peak' });
      dir = -1; loVal = v; loIdx = i;
    } else if (dir <= 0 && v >= loVal * (1 + pct)) {
      // 从波谷反弹 pct → 确认谷(吸附到 loIdx),转上行,重置波峰跟踪
      pivots.push({ idx: loIdx, kind: 'trough' });
      dir = 1; hiVal = v; hiIdx = i;
    }
  }

  const out = ratio.map((p) => ({ date: p.date, regime: 'neutral' as Regime, pending: false }));
  if (pivots.length === 0) return out; // 整段无 pct 反转

  // 结束于峰的腿=defense(上行),结束于谷的腿=offense(下行);首拐点前那段同理。
  let start = 0;
  for (const pv of pivots) {
    const reg: Regime = pv.kind === 'peak' ? 'defense' : 'offense';
    for (let i = start; i <= pv.idx; i++) out[i] = { date: ratio[i].date, regime: reg, pending: false };
    start = pv.idx + 1;
  }
  // 末腿(最后拐点之后)未确认 → pending;峰后下行=offense,谷后上行=defense。
  const last = pivots[pivots.length - 1];
  const tail: Regime = last.kind === 'peak' ? 'offense' : 'defense';
  for (let i = start; i < n; i++) out[i] = { date: ratio[i].date, regime: tail, pending: true };

  return out;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test src/web/panels/attackDefense.hooks.test.ts`
Expected: PASS（ratioSeries 原有断言 + 新 ZigZag 断言全绿）。

- [ ] **Step 5: 提交**

```bash
git add src/web/panels/attackDefense.hooks.ts src/web/panels/attackDefense.hooks.test.ts
git commit -m "refactor(featured): 攻防 regime 改 ZigZag 摆动检测(吸附极值,替代均线迟滞)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: 面板 bgColor 支持 pending 淡色

UI 微调，无独立单测（渲染靠运行 App 目视）。

**Files:**
- Modify: `src/web/panels/AttackDefensePanel.tsx`

**Interfaces:**
- Consumes: Task 1 的 `regimeZones` 返回 `{ date, regime, pending }[]`、`SWING_PCT`、`Regime`。

- [ ] **Step 1: 改 import 常量名**

`src/web/panels/AttackDefensePanel.tsx` 顶部把
```ts
import { ratioSeries, regimeZones, MA_LEN, BAND, type Regime } from './attackDefense.hooks';
```
改为：
```ts
import { ratioSeries, regimeZones, SWING_PCT, type Regime } from './attackDefense.hooks';
```

- [ ] **Step 2: 加 pending 淡色常量 + bgColor 支持 pending**

把背景色常量块
```ts
const BG_GREEN = 'rgba(34,197,94,0.35)';
const BG_RED = 'rgba(239,68,68,0.35)';
const BG_NONE = 'rgba(0,0,0,0)';
```
替换为：
```ts
const BG_GREEN = 'rgba(34,197,94,0.35)';
const BG_RED = 'rgba(239,68,68,0.35)';
const BG_GREEN_DIM = 'rgba(34,197,94,0.15)'; // pending 待定腿:更淡
const BG_RED_DIM = 'rgba(239,68,68,0.15)';
const BG_NONE = 'rgba(0,0,0,0)';
```

- [ ] **Step 3: useMemo 里改 regimeZones 调用 + bgColor + histogram data**

在 `specs` 的 useMemo 内：把
```ts
    const zones = regimeZones(ratio, MA_LEN, BAND);
    const bgColor = (regime: Regime) => (regime === 'defense' ? BG_GREEN : regime === 'offense' ? BG_RED : BG_NONE);
```
改为：
```ts
    const zones = regimeZones(ratio, SWING_PCT);
    const bgColor = (regime: Regime, pending: boolean) =>
      regime === 'defense' ? (pending ? BG_GREEN_DIM : BG_GREEN)
      : regime === 'offense' ? (pending ? BG_RED_DIM : BG_RED)
      : BG_NONE;
```
把 histogram 背景 spec 的 data 里
```ts
        data: zones.map((z) => ({ time: z.date, value: z.regime === 'neutral' ? 0 : 1, color: bgColor(z.regime) })) },
```
改为：
```ts
        data: zones.map((z) => ({ time: z.date, value: z.regime === 'neutral' ? 0 : 1, color: bgColor(z.regime, z.pending) })) },
```
（useMemo 依赖 `[qq.data, nb.data]` 不变。）

- [ ] **Step 4: 类型检查 + 全量测试**

Run: `bunx tsc --noEmit && bun test`
Expected: tsc 无错误（确认无残留 `MA_LEN`/`BAND` 引用）；测试全绿。

- [ ] **Step 5: 目视验证（controller 做；implementer 无浏览器则 DONE_WITH_CONCERNS 注明）**

浏览器进「特色指标 → 攻防」：攻防区边界**贴着比值真实峰谷**（2022 底→2023 初的防御绿区收紧、不再拖到年中）；最右**未确认腿颜色更淡**；小于 8% 的回撤不产生新块。参数是否再调由 controller 反馈。

- [ ] **Step 6: 提交**

```bash
git add src/web/panels/AttackDefensePanel.tsx
git commit -m "refactor(featured): 攻防背景改 ZigZag regime,pending 待定腿用淡色

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- ZigZag 检测 + 吸附极值 + 8% 阈值 → Task 1 `regimeZones` + `SWING_PCT`。
- 腿方向(峰=defense/谷=offense)+ 首拐点前上色 + 末腿 pending + 无拐点全 neutral → Task 1 上色逻辑 + 测试。
- pending 淡色渲染 → Task 2 `bgColor` + DIM 常量。
- ratioSeries/蜡烛/线/useMemo/pane 不动 → 计划未触及。
- Q2 不做 → 计划未含。

**Placeholder scan:** 无 TBD/TODO；所有代码步骤含完整代码。

**Type consistency:** `regimeZones(ratio, pct): {date,regime,pending}[]`、`SWING_PCT`、`Regime`、`bgColor(regime, pending)` 在 Task 1/2 一致;移除的 `MA_LEN`/`BAND` 在 Task 2 import 与调用处同步删除（tsc 兜底）。
