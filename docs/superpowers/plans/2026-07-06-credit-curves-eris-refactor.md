# 信用利差曲线 + Eris 取数简化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** (A) 新增两条信用利差曲线(评级 AAA→CCC、IG 期限结构),作为曲线视图的新 source,FRED 读时现拉零存储;(B) Eris 取数简化——回填改用全历史单文件、每日改用 Latest 稳定别名。

**Architecture:** A 复用已泛化的 `/api/yield-curve?source=` 曲线视图,把现有 treasury 的 FRED 抓取抽成通用 `buildFredCurve(pairs)`,credit_rating / credit_term 复用它;前端加「信用曲线」竖 tab(2 横 tab)。B 给 Eris fetcher 加宽表全历史解析 + 稳定别名,回填/每日各切一处。

**Tech Stack:** Bun + Hono + React + SWR + SQLite;`bun test`。

## Global Constraints

- 全 TypeScript on Bun,不用 Python;中文注释只解释「为什么」;声明式优先。
- 信用/收益曲线一律 **FRED 读时现拉、零存储**(和 treasury 同,优雅降级:单序列失败进 unavailable)。FRED OAS/DGS 值**已是百分点,不转单位**。
- FRED 信用序列(ICE BofA OAS):
  - 评级:AAA `BAMLC0A1CAAA` · AA `BAMLC0A2CAA` · A `BAMLC0A3CA` · BBB `BAMLC0A4CBBB` · BB `BAMLH0A1HYBB` · B `BAMLH0A2HYB` · CCC `BAMLH0A3HYC`
  - IG 期限:1-3Y `BAMLC1A0C13Y` · 3-5Y `BAMLC2A0C35Y` · 5-7Y `BAMLC3A0C57Y` · 7-10Y `BAMLC4A0C710Y` · 10-15Y `BAMLC7A0C1015Y` · 15Y+ `BAMLC8A0C15PY`
- Eris 端点:全历史单文件 `https://files.erisfutures.com/ftp/Eris_Historical_ParCouponCurve_SOFR.csv`(宽表:表头 `Evaluation Date,SOFR1W,SOFR1M,...,SOFR50Y`,一行一天);Latest 别名 `https://files.erisfutures.com/ftp/Eris_Latest_EOD_ParCouponCurve_SOFR.csv`。
- 复用:`createFredFetcher`(fred.ts)、`fetchWithTimeout`、`getMarketSeries`/`insertMarketSeries`、`YieldCurvePanel`(按服务端 tenors 渲染)、`ffLabel`/`impliedFedRate`/`ERIS_OIS_TENORS` 保留。

## File Structure

- `src/server/fetchers/eris.ts`(改)—— 加 `parseErisHistorical`(宽表)+ `fetchErisHistory`;`fetchLatestEris` 改用 Latest 别名。
- `src/server/fetchers/eris.test.ts`(改)—— 加宽表解析测试。
- `src/server/jobs/erisBackfill.ts`(改)—— 用 `fetchErisHistory` 一次拉全,存全部行。
- `src/server/jobs/erisBackfill.test.ts`(改)—— 改成注入 `fetchErisHistory`。
- `src/server/analytics/rateCurves.ts`(改)—— 加 `CREDIT_RATING` / `CREDIT_TERM`。
- `src/server/analytics/rateCurves.test.ts`(改)—— 加断言。
- `src/server/routes/yieldCurve.ts`(改)—— treasury 抽成 `buildFredCurve(pairs)`;加 credit_rating / credit_term 分支。
- `src/web/App.tsx`(改)—— 加「信用曲线」竖 tab(评级 / 期限 两横 tab)。

前端 `YieldCurvePanel` / `useYieldCurve` 不改(已按 source 泛化)。

---

## Task 1: Eris fetcher —— 全历史宽表解析 + Latest 别名

**Files:** Modify `src/server/fetchers/eris.ts`, `src/server/fetchers/eris.test.ts`

**Interfaces:**
- Produces:`function parseErisHistorical(csv: string): ErisCurve[]`(宽表→每行一个 ErisCurve,tenor=列头去 `SOFR` 前缀);`function fetchErisHistory(doFetch?): Promise<ErisCurve[]>`。
- 改:`fetchLatestEris` 直接拉 `Eris_Latest_EOD_ParCouponCurve_SOFR.csv`(不再列目录)。`parseErisParCoupon`/`fetchErisForDate` 保留不动。

- [ ] **Step 1: 写失败测试**（追加到 eris.test.ts）

```ts
import { parseErisHistorical } from './eris';

const WIDE = `Evaluation Date,SOFR1W,SOFR3M,SOFR10Y
2026-07-02,3.638,3.719,4.065
2026-07-01,3.634,3.739,4.067`;

describe('parseErisHistorical(宽表全历史)', () => {
  const rows = parseErisHistorical(WIDE);
  it('每行一个 curve', () => expect(rows.length).toBe(2));
  it('date 直接取(已是 YYYY-MM-DD)', () => expect(rows[0].date).toBe('2026-07-02'));
  it('列头去 SOFR 前缀成 tenor + 取值', () => {
    expect(rows[0].points.find((p) => p.tenor === '3M')!.rate).toBeCloseTo(3.719, 3);
    expect(rows[1].points.find((p) => p.tenor === '10Y')!.rate).toBeCloseTo(4.067, 3);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/server/fetchers/eris.test.ts` → FAIL(`parseErisHistorical` 未定义)。

- [ ] **Step 3: 写实现**（eris.ts）

加常量与函数,并改 `fetchLatestEris`:

```ts
const HISTORY_URL = `${ROOT}/Eris_Historical_ParCouponCurve_SOFR.csv`;
const LATEST_URL = `${ROOT}/Eris_Latest_EOD_ParCouponCurve_SOFR.csv`;

// 宽表:表头 Evaluation Date,SOFR1W,...,SOFR50Y;一行一天。列头去 SOFR 前缀成 tenor。
export function parseErisHistorical(csv: string): ErisCurve[] {
  const lines = csv.trim().split(/\r?\n/);
  const header = lines[0].split(',');
  const tenors = header.slice(1).map((h) => h.trim().replace(/^SOFR/, ''));
  return lines.slice(1).flatMap((line) => {
    const c = line.split(',');
    const date = c[0]?.trim();
    if (!date) return [];
    const points = tenors.flatMap((tenor, i) => {
      const rate = Number(c[i + 1]);
      return Number.isFinite(rate) ? [{ tenor, rate }] : [];
    });
    return points.length ? [{ date, points }] : [];
  });
}

export async function fetchErisHistory(doFetch = doFetch0): Promise<ErisCurve[]> {
  const res = await doFetch(HISTORY_URL);
  if (!res.ok) throw new Error(`Eris 全历史下载失败:${res.status}`);
  return parseErisHistorical(await res.text());
}
```

`fetchLatestEris` 改为(替换原列目录实现):

```ts
// 直接拉稳定的 Latest 别名,不必列目录找最大日期。
export async function fetchLatestEris(doFetch = doFetch0): Promise<ErisCurve> {
  const res = await doFetch(LATEST_URL);
  if (!res.ok) throw new Error(`Eris 最新文件下载失败:${res.status}`);
  return parseErisParCoupon(await res.text());
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test src/server/fetchers/eris.test.ts` → PASS(原有 + 宽表 3 条)。

- [ ] **Step 5: 提交**

```bash
git add src/server/fetchers/eris.ts src/server/fetchers/eris.test.ts
git commit -m "feat(fetchers): Eris 全历史宽表解析 + fetchLatestEris 改用 Latest 别名"
```

---

## Task 2: 回填改用全历史单文件

**Files:** Modify `src/server/jobs/erisBackfill.ts`, `src/server/jobs/erisBackfill.test.ts`

**Interfaces:**
- 改 `backfillEris`:签名 `(db, fetchHistory?: () => Promise<ErisCurve[]>) => Promise<{ days: number; total: number }>`(不再逐日;一次拿全历史,存全部行,幂等)。删掉 sinceDate/today/逐日循环。

- [ ] **Step 1: 改测试(先失败)**（重写 erisBackfill.test.ts 的用例)

```ts
import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate } from '../storage/db';
import { getMarketSeries } from '../storage/repository';
import { backfillEris } from './erisBackfill';

describe('backfillEris(全历史单文件)', () => {
  it('把全历史每行按 ERIS_OIS_{tenor} 存入,幂等', async () => {
    const db = new Database(':memory:');
    migrate(db);
    const hist = async () => [
      { date: '2026-07-01', points: [{ tenor: '3M', rate: 3.73 }] },
      { date: '2026-07-02', points: [{ tenor: '3M', rate: 3.72 }] },
    ];
    const { days } = await backfillEris(db, hist);
    expect(days).toBe(2);
    await backfillEris(db, hist); // 重跑幂等
    expect(getMarketSeries(db, 'ERIS_OIS_3M').map((r) => r.date)).toEqual(['2026-07-01', '2026-07-02']);
    db.close();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/server/jobs/erisBackfill.test.ts` → FAIL(签名变了)。

- [ ] **Step 3: 写实现**（erisBackfill.ts 全替换 backfillEris 主体）

```ts
import type { Database } from 'bun:sqlite';
import { openDb, migrate } from '../storage/db';
import { insertMarketSeries } from '../storage/repository';
import { fetchErisHistory, type ErisCurve } from '../fetchers/eris';

// 一次下载全历史宽表文件(~5.7 年),按 ERIS_OIS_{tenor} 全量 upsert(幂等,可重跑续填)。
// 比逐日抓省 ~1500 次请求。
export async function backfillEris(
  db: Database,
  fetchHistory: () => Promise<ErisCurve[]> = fetchErisHistory,
): Promise<{ days: number; total: number }> {
  const curves = await fetchHistory();
  let total = 0;
  for (const curve of curves) {
    insertMarketSeries(db, curve.points.map((p) => ({ seriesId: `ERIS_OIS_${p.tenor}`, obsDate: curve.date, value: p.rate })));
    total += curve.points.length;
  }
  return { days: curves.length, total };
}

if (import.meta.main) {
  const db = openDb();
  migrate(db);
  const { days, total } = await backfillEris(db);
  db.close();
  console.log(`Eris backfill(全历史单文件): ${days} trading days, ${total} rows.`);
}
```

- [ ] **Step 4: 跑测试 + 全量 + typecheck**

Run: `bun test src/server/jobs/erisBackfill.test.ts` → PASS;`bun test` 全绿;`bunx tsc --noEmit` EXIT 0。

- [ ] **Step 5: 提交**

```bash
git add src/server/jobs/erisBackfill.ts src/server/jobs/erisBackfill.test.ts
git commit -m "refactor(jobs): Eris 回填改用全历史单文件(一次下载替代逐日 1500 请求)"
```

---

## Task 3: 后端 —— 信用曲线两 source（FRED 读时现拉）

**Files:** Modify `src/server/analytics/rateCurves.ts`, `src/server/analytics/rateCurves.test.ts`, `src/server/routes/yieldCurve.ts`

**Interfaces:**
- `rateCurves.ts` 加 `CREDIT_RATING: {tenor,series}[]`、`CREDIT_TERM: {tenor,series}[]`。
- `yieldCurve.ts`:把现有 treasury 的 FRED 抓取抽成 `buildFredCurve(pairs: {tenor: string; series: string}[]): Promise<CurveBody>`;treasury/credit_rating/credit_term 都用它。加 `?source=credit_rating|credit_term` 分支。

- [ ] **Step 1: 改测试(先失败)**（rateCurves.test.ts 追加)

```ts
import { CREDIT_RATING, CREDIT_TERM } from './rateCurves';
it('信用评级梯队 AAA→CCC 映射到 ICE BofA series', () => {
  expect(CREDIT_RATING.map((c) => c.tenor)).toEqual(['AAA', 'AA', 'A', 'BBB', 'BB', 'B', 'CCC']);
  expect(CREDIT_RATING.find((c) => c.tenor === 'CCC')!.series).toBe('BAMLH0A3HYC');
});
it('IG 信用期限结构映射', () => {
  expect(CREDIT_TERM[0]).toEqual({ tenor: '1-3Y', series: 'BAMLC1A0C13Y' });
  expect(CREDIT_TERM.at(-1)!.tenor).toBe('15Y+');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/server/analytics/rateCurves.test.ts` → FAIL。

- [ ] **Step 3: 写 rateCurves.ts 常量**

```ts
// 信用利差曲线(FRED ICE BofA OAS,读时现拉,值已是百分点)。
export const CREDIT_RATING: { tenor: string; series: string }[] = [
  { tenor: 'AAA', series: 'BAMLC0A1CAAA' }, { tenor: 'AA', series: 'BAMLC0A2CAA' },
  { tenor: 'A', series: 'BAMLC0A3CA' }, { tenor: 'BBB', series: 'BAMLC0A4CBBB' },
  { tenor: 'BB', series: 'BAMLH0A1HYBB' }, { tenor: 'B', series: 'BAMLH0A2HYB' },
  { tenor: 'CCC', series: 'BAMLH0A3HYC' },
];
export const CREDIT_TERM: { tenor: string; series: string }[] = [
  { tenor: '1-3Y', series: 'BAMLC1A0C13Y' }, { tenor: '3-5Y', series: 'BAMLC2A0C35Y' },
  { tenor: '5-7Y', series: 'BAMLC3A0C57Y' }, { tenor: '7-10Y', series: 'BAMLC4A0C710Y' },
  { tenor: '10-15Y', series: 'BAMLC7A0C1015Y' }, { tenor: '15Y+', series: 'BAMLC8A0C15PY' },
];
```

- [ ] **Step 4: 改 yieldCurve.ts**

把现有 `buildTreasury` 泛化(TENORS 现为 `[label,id][]`,改成喂 `{tenor,series}`):

```ts
// 通用:一组 (tenor→FRED series) 读时现拉全历史,并行 + 优雅降级。值已是百分点,原样。
async function buildFredCurve(pairs: { tenor: string; series: string }[]): Promise<CurveBody> {
  const fred = createFredFetcher({ apiKey: process.env.FRED_API_KEY ?? '' });
  const settled = await Promise.allSettled(pairs.map((p) => fred.fetchSeries(p.series, HISTORY_START_DATE)));
  const series: Record<string, Point[]> = {};
  const unavailable: string[] = [];
  settled.forEach((s, i) => {
    const { tenor } = pairs[i];
    if (s.status === 'fulfilled' && s.value.length) series[tenor] = s.value.map((r) => ({ date: r.obsDate, value: r.value }));
    else unavailable.push(tenor);
  });
  return { tenors: pairs.map((p) => p.tenor), series, unavailable };
}

const buildTreasury = (): Promise<CurveBody> =>
  buildFredCurve(TENORS.map(([tenor, series]) => ({ tenor, series })));
```

路由分派加两支:

```ts
  if (source === 'credit_rating') return c.json(await buildFredCurve(CREDIT_RATING));
  if (source === 'credit_term') return c.json(await buildFredCurve(CREDIT_TERM));
```

(import 顶部加 `CREDIT_RATING, CREDIT_TERM`。sofr_ois/fed_path 分支不动。)

- [ ] **Step 5: 跑测试 + 手测 + typecheck**

```bash
bun test src/server/analytics/rateCurves.test.ts   # 全绿
bunx tsc --noEmit                                    # EXIT 0
curl -s "http://localhost:3000/api/yield-curve?source=credit_rating" | head -c 200
curl -s "http://localhost:3000/api/yield-curve?source=credit_term" | head -c 200
```
Expected:credit_rating 回 `tenors:["AAA",...,"CCC"]`;credit_term 回 `["1-3Y",...,"15Y+"]`,值为 OAS 百分点。

- [ ] **Step 6: 提交**

```bash
git add src/server/analytics/rateCurves.ts src/server/analytics/rateCurves.test.ts src/server/routes/yieldCurve.ts
git commit -m "feat(server): 信用利差曲线两 source(评级/期限,FRED OAS 读时现拉)"
```

---

## Task 4: 前端「信用曲线」竖 tab

**Files:** Modify `src/web/App.tsx`

**Interfaces:** 复用 `YieldCurvePanel source={...}`。新增一个竖视角,两横 tab。

- [ ] **Step 1: 加视角**

在 `PERSPECTIVES` 里(利率视角之后)加:

```tsx
  {
    id: 'creditCurve', label: '信用曲线',
    tabs: [
      { id: 'credit_rating', label: '评级利差' },
      { id: 'credit_term', label: '期限结构' },
    ],
    render: (tabId) => <YieldCurvePanel source={tabId} />,
  },
```

(`tabId` 即 source:`credit_rating` / `credit_term`,与后端对齐。`YieldCurvePanel` 已 import。)

- [ ] **Step 2: 构建 + 类型 + 现有测试**

```bash
bunx tsc --noEmit          # EXIT 0
bunx vite build            # 成功
bun test src/web/panels/yieldCurve.hooks.test.ts   # 现有仍过
```

- [ ] **Step 3: 手测**

dev server 下切「信用曲线 › 评级利差 / 期限结构」——评级利差应见 AAA→CCC 递增的利差曲线(CCC 最高),多时点叠加可用。

- [ ] **Step 4: 提交**

```bash
git add src/web/App.tsx
git commit -m "feat(web): 新增「信用曲线」视角(评级利差 / 期限结构),复用曲线视图"
```

---

## Self-Review

- **Spec 覆盖**:A(评级 T3+T4、期限 T3+T4)、B(全历史单文件 T2、Latest 别名 T1)——全覆盖。都做=评级+期限两条。✅
- **占位符**:无。每步含实际代码/命令。
- **类型一致**:`ErisCurve[]`(T1)→ T2 用;`CREDIT_RATING`/`CREDIT_TERM`(T3)→ 路由 + 前端 tabId 对齐(credit_rating/credit_term);`buildFredCurve(pairs)` 签名一处定义多处用;前端 source 值与后端分支字符串一致。
- **注意**:全历史宽表无 `1D`(SOFR1W 起),1D 只由每日 job 从今天起累积——可接受(隔夜点历史最不重要)。
