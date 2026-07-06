# Eris SOFR OIS 曲线 + Pensford 瘦身 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** SOFR OIS 曲线改用 Eris 免费官方 ParCouponCurve(逐 bp 准、24 档含短端、可回填 13 年历史),Pensford 瘦身为只抓 Fed Funds 期货(Fed 路径),删掉冗余的 Pensford 库数据。

**Architecture:** 新增 Eris fetcher(下载 EOD ParCouponCurve CSV,读 `FairCoupon (%)` 列直接得 par OIS)+ 每日 job(存最新)+ 一次性回填 job(遍历 archives)。`/api/yield-curve?source=sofr_ois` 改读 Eris 序列。Pensford job 缩到只存 `FF*`。前端零改动(视图按 source 读服务端返回的 tenors)。

**Tech Stack:** Bun + Hono + SQLite(`market_series`)、`bun test`。

## Global Constraints

- 全 TypeScript on Bun,不用 Python;中文注释只解释「为什么」;声明式优先。
- Eris 数据源(公开、无需登录,不封 IP):
  - 每日 EOD:`https://files.erisfutures.com/ftp/` 根目录下 `Eris_{YYYYMMDD}_EOD_ParCouponCurve_SOFR.csv`(存近几个月)。
  - 历史:`https://files.erisfutures.com/ftp/archives/{YYYY}/{MM-MonthName}/Eris_{YYYYMMDD}_EOD_ParCouponCurve_SOFR.csv`(回到 2013;MonthName 为英文全称,如 `02-February`)。
  - 某日两处都 404 = 非交易日,跳过。
- ParCoupon CSV 列:`Symbol,EvaluationDate,...,FairCoupon (%),...`;`Symbol` = `SOFR{tenor}`(SOFR1D/1W/1M/3M/6M/9M/12M/18M/2Y/3Y/4Y/5Y/6Y/7Y/8Y/9Y/10Y/12Y/15Y/20Y/25Y/30Y/40Y/50Y);`FairCoupon (%)` 已是百分点(3.719 = 3.719%),**读时不再 ×100**;`EvaluationDate` 为 `MM/DD/YYYY`。
- Eris 序列存 `market_series`,series_id = `ERIS_OIS_{tenor}`(如 `ERIS_OIS_3M`),value = FairCoupon(百分点),obs_date = EvaluationDate 归一后的 `YYYY-MM-DD`。幂等 upsert。
- **Pensford 只保留 Fed 路径**:job 改为只存 `FF*`(+ `FEDFUNDS` 作前端锚)。删库中冗余:`SOFRSWAP*` / `TREASURY*` / `SOFRTERM*` / `SOFR` / `SOFR_M1` / `SOFR_M3` / `SOFR_M6`。
- 复用:`insertMarketSeries` / `getMarketSeries`(`storage/repository.ts`)、daily job 注入式形状(`jobs/daily.ts`)、`fetchWithTimeout`(`fetchers/http.ts`)。
- 回填深度:默认 **3 年**(`erisBackfill.ts` 的 `sinceDate` 参数,可传更早)。

## File Structure

- `src/server/fetchers/eris.ts`(新)—— 下载 + 解析 ParCouponCurve(纯解析 `parseErisParCoupon` 可单测 + `fetchLatestEris` / `fetchErisForDate`)。
- `src/server/fetchers/eris.test.ts`(新)。
- `src/server/jobs/erisSnapshot.ts`(新)—— 存最新 EOD 进 market_series;`import.meta.main` 独跑。
- `src/server/jobs/erisBackfill.ts`(新)—— 遍历 archives 回填;`import.meta.main` 独跑(带 sinceDate)。
- `src/server/jobs/erisSnapshot.test.ts`(新)。
- `src/server/jobs/daily.ts`(改)—— 挂 `eris_snapshot`(注入式);Pensford 那段不动(job 内部瘦身在 pensfordSnapshot.ts)。
- `src/server/jobs/pensfordSnapshot.ts`(改)—— 只存 `FF*` + `FEDFUNDS`。
- `src/server/jobs/pensfordSnapshot.test.ts`(改)—— 断言只存 FF/FEDFUNDS。
- `src/server/analytics/rateCurves.ts`(改)—— OIS 期限表换成 Eris 24 档;删 `toPercent`(Eris 已是 %);`FF_CONTRACTS`/`ffLabel`/`impliedFedRate` 保留。
- `src/server/analytics/rateCurves.test.ts`(改)。
- `src/server/routes/yieldCurve.ts`(改)—— `sofr_ois` 读 Eris 序列(恒等 xform)。
- `src/server/storage/cleanupPensford.ts`(新,一次性)—— 删冗余 Pensford 序列;`import.meta.main` 独跑。

前端不改(`YieldCurvePanel` 按服务端返回的 tenors 渲染)。

---

## Task 1: Eris ParCouponCurve 抓取 + 解析

**Files:**
- Create: `src/server/fetchers/eris.ts`
- Test: `src/server/fetchers/eris.test.ts`

**Interfaces:**
- Produces:
  - `type ErisPoint = { tenor: string; rate: number }`
  - `type ErisCurve = { date: string; points: ErisPoint[] }`
  - `function parseErisParCoupon(csv: string): ErisCurve`(纯;`Symbol` 去 `SOFR` 前缀成 tenor;`FairCoupon (%)` → rate;`EvaluationDate` MM/DD/YYYY → YYYY-MM-DD)
  - `function fetchErisForDate(date: string, doFetch?): Promise<ErisCurve | null>`(date=YYYY-MM-DD;先试 archives 路径再试 root;都 404 返回 null)
  - `function fetchLatestEris(doFetch?): Promise<ErisCurve>`(列 root 目录取最新 ParCoupon 文件下载解析)

- [ ] **Step 1: 写失败测试**

`src/server/fetchers/eris.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import { parseErisParCoupon } from './eris';

const SAMPLE = `Symbol,EvaluationDate,FirstTradeDate,ErisPAIDate,EffectiveDate,CashFlowAlignmentDate,MaturityDate,NPV (A),FixedNPV,FloatingNPV,Coupon (%),FairCoupon (%),Nominal,Spread (Bps),Index
SOFR1D,07/02/2026,07/02/2026,07/02/2026,07/07/2026,07/08/2026,07/10/2026,0,0.01,-0.01,3.6357,3.6357215934,100,0,SOFRON Actual/360
SOFR3M,07/02/2026,07/02/2026,07/02/2026,07/07/2026,10/07/2026,10/09/2026,0,0.94,-0.94,3.7193,3.7193567517,100,0,SOFRON Actual/360
SOFR10Y,07/02/2026,07/02/2026,07/02/2026,07/07/2026,07/07/2036,07/09/2036,0,33.3,-33.3,4.0647,4.0647448168,100,0,SOFRON Actual/360`;

describe('parseErisParCoupon', () => {
  const c = parseErisParCoupon(SAMPLE);
  it('EvaluationDate 归一 YYYY-MM-DD', () => expect(c.date).toBe('2026-07-02'));
  it('Symbol 去 SOFR 前缀成 tenor', () => expect(c.points.map((p) => p.tenor)).toEqual(['1D', '3M', '10Y']));
  it('取 FairCoupon(%) 作 rate(已是百分点)', () => {
    expect(c.points.find((p) => p.tenor === '3M')!.rate).toBeCloseTo(3.7193568, 5);
    expect(c.points.find((p) => p.tenor === '10Y')!.rate).toBeCloseTo(4.0647448, 5);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/server/fetchers/eris.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 写实现**

`src/server/fetchers/eris.ts`:

```ts
import { fetchWithTimeout } from './http';

// Eris(并入 CME)公开的免费 SOFR 结算曲线:官方已 bootstrap 的 par OIS 曲线,24 档含短端。
// 每日 EOD 在 root,历史在 archives/{年}/{MM-月名}/。ParCoupon 的 FairCoupon(%) 即 par OIS 利率。
const ROOT = 'https://files.erisfutures.com/ftp';
const MONTHS = ['01-January', '02-February', '03-March', '04-April', '05-May', '06-June',
  '07-July', '08-August', '09-September', '10-October', '11-November', '12-December'];

export type ErisPoint = { tenor: string; rate: number };
export type ErisCurve = { date: string; points: ErisPoint[] };

const doFetch0 = fetchWithTimeout;

// ponytail: CSV 列固定,按表头定位 Symbol / EvaluationDate / FairCoupon (%) 三列,简单可靠。
export function parseErisParCoupon(csv: string): ErisCurve {
  const lines = csv.trim().split(/\r?\n/);
  const header = lines[0].split(',');
  const iSym = header.indexOf('Symbol');
  const iDate = header.indexOf('EvaluationDate');
  const iFair = header.indexOf('FairCoupon (%)');
  if (iSym < 0 || iDate < 0 || iFair < 0) throw new Error('Eris CSV: 缺列(Symbol/EvaluationDate/FairCoupon (%))');

  const points: ErisPoint[] = [];
  let date = '';
  for (const line of lines.slice(1)) {
    const c = line.split(',');
    const sym = c[iSym]?.trim();
    const rate = Number(c[iFair]);
    if (!sym?.startsWith('SOFR') || !Number.isFinite(rate)) continue;
    if (!date) { const [m, d, y] = c[iDate].trim().split('/'); date = `${y}-${m}-${d}`; }
    points.push({ tenor: sym.slice(4), rate }); // 去 'SOFR' 前缀
  }
  if (!date) throw new Error('Eris CSV: 无有效数据行');
  return { date, points };
}

function fileName(ymd: string): string { return `Eris_${ymd}_EOD_ParCouponCurve_SOFR.csv`; }

// date=YYYY-MM-DD。先试 archives(历史),再试 root(近月);都 404 → null(非交易日)。
export async function fetchErisForDate(date: string, doFetch = doFetch0): Promise<ErisCurve | null> {
  const [y, m, d] = date.split('-');
  const ymd = `${y}${m}${d}`;
  const urls = [`${ROOT}/archives/${y}/${MONTHS[Number(m) - 1]}/${fileName(ymd)}`, `${ROOT}/${fileName(ymd)}`];
  for (const url of urls) {
    const res = await doFetch(url);
    if (res.ok) return parseErisParCoupon(await res.text());
  }
  return null;
}

// 列 root 目录,取日期最大的一份 ParCoupon 文件。
export async function fetchLatestEris(doFetch = doFetch0): Promise<ErisCurve> {
  const res = await doFetch(`${ROOT}/`);
  if (!res.ok) throw new Error(`Eris 目录列举失败:${res.status}`);
  const html = await res.text();
  const dates = [...html.matchAll(/Eris_(\d{8})_EOD_ParCouponCurve_SOFR\.csv/g)].map((m) => m[1]);
  if (!dates.length) throw new Error('Eris root 无 ParCoupon 文件');
  const latest = dates.sort().at(-1)!;
  const r = await doFetch(`${ROOT}/${fileName(latest)}`);
  if (!r.ok) throw new Error(`Eris 最新文件下载失败:${r.status}`);
  return parseErisParCoupon(await r.text());
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test src/server/fetchers/eris.test.ts`
Expected: PASS(3 tests)。

- [ ] **Step 5: 提交**

```bash
git add src/server/fetchers/eris.ts src/server/fetchers/eris.test.ts
git commit -m "feat(fetchers): Eris SOFR ParCouponCurve 抓取+解析"
```

---

## Task 2: Eris 每日 job + 挂进 daily

**Files:**
- Create: `src/server/jobs/erisSnapshot.ts`
- Create: `src/server/jobs/erisSnapshot.test.ts`
- Modify: `src/server/jobs/daily.ts`

**Interfaces:**
- Consumes: `fetchLatestEris`(Task 1)、`insertMarketSeries`。
- Produces: `function updateErisSnapshot(db: Database, fetchCurve?: () => Promise<import('../fetchers/eris').ErisCurve>): Promise<{ total: number }>`。series_id = `ERIS_OIS_{tenor}`,value = rate(%),obs_date = curve.date。

- [ ] **Step 1: 写失败测试**

`src/server/jobs/erisSnapshot.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate } from '../storage/db';
import { getMarketSeries } from '../storage/repository';
import { updateErisSnapshot } from './erisSnapshot';

describe('updateErisSnapshot', () => {
  it('把 Eris 曲线按 ERIS_OIS_{tenor} 存进 market_series', async () => {
    const db = new Database(':memory:');
    migrate(db);
    const curve = { date: '2026-07-02', points: [{ tenor: '3M', rate: 3.7194 }, { tenor: '10Y', rate: 4.0647 }] };
    const { total } = await updateErisSnapshot(db, async () => curve);
    expect(total).toBe(2);
    const r = getMarketSeries(db, 'ERIS_OIS_3M');
    expect(r).toEqual([{ date: '2026-07-02', value: 3.7194 }]);
    db.close();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/server/jobs/erisSnapshot.test.ts`
Expected: FAIL。

- [ ] **Step 3: 写实现**

`src/server/jobs/erisSnapshot.ts`:

```ts
import type { Database } from 'bun:sqlite';
import { openDb, migrate } from '../storage/db';
import { insertMarketSeries } from '../storage/repository';
import { fetchLatestEris, type ErisCurve } from '../fetchers/eris';

/**
 * 抓 Eris 最新 EOD SOFR par 曲线(24 档含短端)→ market_series 的 ERIS_OIS_{tenor}。
 * FairCoupon 已是百分点,原样存;obs_date = 曲线的 EvaluationDate。幂等,同日重跑覆盖。
 * 直接运行:bun run src/server/jobs/erisSnapshot.ts
 */
export async function updateErisSnapshot(
  db: Database,
  fetchCurve: () => Promise<ErisCurve> = fetchLatestEris,
): Promise<{ total: number }> {
  const curve = await fetchCurve();
  insertMarketSeries(db, curve.points.map((p) => ({ seriesId: `ERIS_OIS_${p.tenor}`, obsDate: curve.date, value: p.rate })));
  return { total: curve.points.length };
}

if (import.meta.main) {
  const db = openDb();
  migrate(db);
  const { total } = await updateErisSnapshot(db);
  db.close();
  console.log(`Eris OIS snapshot stored: ${total} tenors.`);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test src/server/jobs/erisSnapshot.test.ts`
Expected: PASS。

- [ ] **Step 5: 挂进 daily.ts**

`src/server/jobs/daily.ts`:import 顶部加 `import { updateErisSnapshot } from './erisSnapshot';`;在 `RunDailyJobOpts` 仿 `pensfordUpdater?` 加:

```ts
  /** Eris SOFR OIS 曲线更新器(注入式;CLI 传 updateErisSnapshot,测试省略以免联网)。 */
  erisUpdater?: (db: Database) => Promise<{ total: number }>;
```

在 pensford 那段旁边加守卫式 job:

```ts
  if (opts.erisUpdater) {
    await withJobRun(opts.db, 'eris_snapshot', async () => {
      const { total } = await opts.erisUpdater!(opts.db);
      return threeState(total, total, []);
    });
  }
```

`if (import.meta.main)` 的 runDailyJob 调用里补 `erisUpdater: updateErisSnapshot,`。(不进 `REQUIRED_JOBS`,同 pensford/btc,理由已在该处注释。)

- [ ] **Step 6: 全量测试 + 提交**

Run: `bun test` → 全绿。

```bash
git add src/server/jobs/erisSnapshot.ts src/server/jobs/erisSnapshot.test.ts src/server/jobs/daily.ts
git commit -m "feat(jobs): Eris SOFR OIS 每日 job + 挂进 daily 编排"
```

---

## Task 3: Eris 历史回填 job

**Files:**
- Create: `src/server/jobs/erisBackfill.ts`

**Interfaces:**
- Consumes: `fetchErisForDate`(Task 1)、`insertMarketSeries`、`getLatestMarketDate`。
- Produces: `function backfillEris(db: Database, sinceDate: string, fetchForDate?): Promise<{ days: number; total: number }>`(遍历 sinceDate..今天的日历日,逐日抓;null=非交易日跳过;幂等 upsert)。

- [ ] **Step 1: 写失败测试**

`src/server/jobs/erisBackfill.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate } from '../storage/db';
import { getMarketSeries } from '../storage/repository';
import { backfillEris } from './erisBackfill';

describe('backfillEris', () => {
  it('遍历日期,存交易日、跳 null(非交易日)', async () => {
    const db = new Database(':memory:');
    migrate(db);
    // 07-04/07-05 周末返回 null;07-03、07-06 有数据
    const fake = async (date: string) =>
      date === '2026-07-03' || date === '2026-07-06'
        ? { date, points: [{ tenor: '3M', rate: 3.7 }] }
        : null;
    const { days } = await backfillEris(db, '2026-07-03', fake);
    expect(days).toBe(2); // 只有两天有数据
    expect(getMarketSeries(db, 'ERIS_OIS_3M').map((r) => r.date)).toEqual(['2026-07-03', '2026-07-06']);
    db.close();
  });
});
```

（测试里 `backfillEris` 的"今天"上界:实现用注入的 `fetchForDate` 覆盖到无更多日期即止;为可测,遍历到 `sinceDate` 起、以传入 fake 覆盖的范围为界。见实现说明。)

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/server/jobs/erisBackfill.test.ts`
Expected: FAIL。

- [ ] **Step 3: 写实现**

`src/server/jobs/erisBackfill.ts`:

```ts
import type { Database } from 'bun:sqlite';
import { openDb, migrate } from '../storage/db';
import { insertMarketSeries } from '../storage/repository';
import { fetchErisForDate, type ErisCurve } from '../fetchers/eris';

// 遍历 sinceDate..today 的每个日历日,逐日抓 Eris EOD 曲线;非交易日(两处都 404)返回 null,跳过。
// 幂等 upsert(可重复跑续填)。today 由参数注入以便测试;CLI 用真实今天。
export async function backfillEris(
  db: Database,
  sinceDate: string,
  fetchForDate: (d: string) => Promise<ErisCurve | null> = fetchErisForDate,
  today: string = new Date().toISOString().slice(0, 10),
): Promise<{ days: number; total: number }> {
  let days = 0, total = 0;
  for (let d = new Date(sinceDate + 'T00:00:00Z'); d.toISOString().slice(0, 10) <= today; d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    const curve = await fetchForDate(iso);
    if (!curve) continue;
    insertMarketSeries(db, curve.points.map((p) => ({ seriesId: `ERIS_OIS_${p.tenor}`, obsDate: curve.date, value: p.rate })));
    days += 1; total += curve.points.length;
  }
  return { days, total };
}

if (import.meta.main) {
  // 默认回填近 3 年;传参可更早,如 bun run src/server/jobs/erisBackfill.ts 2019-01-01
  const arg = process.argv[2];
  const since = arg ?? (() => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - 3); return d.toISOString().slice(0, 10); })();
  const db = openDb();
  migrate(db);
  const { days, total } = await backfillEris(db, since);
  db.close();
  console.log(`Eris backfill from ${since}: ${days} trading days, ${total} rows.`);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test src/server/jobs/erisBackfill.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/server/jobs/erisBackfill.ts src/server/jobs/erisBackfill.test.ts
git commit -m "feat(jobs): Eris SOFR OIS 历史回填 job(遍历 archives)"
```

---

## Task 4: 路由 sofr_ois 改读 Eris

**Files:**
- Modify: `src/server/analytics/rateCurves.ts`
- Modify: `src/server/analytics/rateCurves.test.ts`
- Modify: `src/server/routes/yieldCurve.ts`

**Interfaces:**
- `rateCurves.ts`:导出 `ERIS_OIS_TENORS: string[]`(24 档顺序);删 `OIS_TENORS` 与 `toPercent`;`FF_CONTRACTS`/`ffLabel`/`impliedFedRate` 保留。
- 路由 `sofr_ois`:读 `ERIS_OIS_{tenor}`,值恒等(已是 %)。

- [ ] **Step 1: 改测试(先失败)**

`src/server/analytics/rateCurves.test.ts`:删掉 OIS 小数×100 与 `OIS_TENORS symbol` 两条,换成:

```ts
import { ffLabel, impliedFedRate, ERIS_OIS_TENORS, FF_CONTRACTS } from './rateCurves';
// ...FF 相关的三条测试保留...
it('Eris OIS 期限表含短端到长端', () => {
  expect(ERIS_OIS_TENORS[0]).toBe('1D');
  expect(ERIS_OIS_TENORS).toContain('3M');
  expect(ERIS_OIS_TENORS).toContain('12M');
  expect(ERIS_OIS_TENORS.at(-1)).toBe('50Y');
  expect(ERIS_OIS_TENORS.length).toBe(24);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/server/analytics/rateCurves.test.ts`
Expected: FAIL(`ERIS_OIS_TENORS` 未定义 / 旧导出已删)。

- [ ] **Step 3: 改 rateCurves.ts**

删掉 `OIS_TENORS` 和 `toPercent`,加:

```ts
// Eris ParCouponCurve 的 24 档期限(顺序即曲线 x 轴)。存库 series_id = ERIS_OIS_{tenor}。
export const ERIS_OIS_TENORS: string[] = [
  '1D', '1W', '1M', '3M', '6M', '9M', '12M', '18M', '2Y', '3Y', '4Y', '5Y',
  '6Y', '7Y', '8Y', '9Y', '10Y', '12Y', '15Y', '20Y', '25Y', '30Y', '40Y', '50Y',
];
```

（保留 `FF_CONTRACTS` / `ffLabel` / `impliedFedRate` 不动。）

- [ ] **Step 4: 改 yieldCurve.ts 的 sofr_ois 分支**

import 改:去掉 `OIS_TENORS, toPercent`,加 `ERIS_OIS_TENORS`。`buildOis` 改为:

```ts
// Eris 的 FairCoupon 已是百分点 → 恒等 xform。
const buildOis = (): CurveBody =>
  buildFromDb(ERIS_OIS_TENORS.map((t) => ({ label: t, symbol: `ERIS_OIS_${t}` })), (v) => v);
```

（`buildFromDb` / `buildTreasury` / `buildFedPath` / 路由分派不动。）

- [ ] **Step 5: 跑测试 + 手测 + typecheck**

Run:
```bash
bun test src/server/analytics/rateCurves.test.ts    # 全绿
bunx tsc --noEmit                                     # EXIT 0
bun run src/server/jobs/erisSnapshot.ts               # 灌一天 Eris 数据
curl -s "http://localhost:3000/api/yield-curve?source=sofr_ois" | head -c 300
```
Expected:sofr_ois 回 `tenors:["1D","1W","1M","3M",...,"50Y"]`,3M≈3.7、10Y≈4.0 等真实值(dev server 在跑时)。

- [ ] **Step 6: 提交**

```bash
git add src/server/analytics/rateCurves.ts src/server/analytics/rateCurves.test.ts src/server/routes/yieldCurve.ts
git commit -m "feat(server): sofr_ois 源改用 Eris ParCouponCurve(24 档含短端)"
```

---

## Task 5: Pensford 瘦身(只留 FF)+ 删冗余库数据

**Files:**
- Modify: `src/server/jobs/pensfordSnapshot.ts`
- Modify: `src/server/jobs/pensfordSnapshot.test.ts`
- Create: `src/server/storage/cleanupPensford.ts`

**Interfaces:**
- `updatePensfordSnapshot`:改为只存 `FF*` 与 `FEDFUNDS`(Fed 路径所需)。
- `cleanupPensford.ts`:一次性删冗余序列。

- [ ] **Step 1: 改测试(先失败)**

`src/server/jobs/pensfordSnapshot.test.ts`:把 xml 样例加进一条 `SOFRSWAP` 和一条 `FF2_Comdty`、一条 `FEDFUNDS`,断言只存了 `FF2_Comdty` 和 `FEDFUNDS`,`SOFRSWAP Y5` 不入库:

```ts
const xml = (d: string) => `<TFCrecords timeStamp="${d} 06:00:01 PM">
  <record><symbol>SOFRSWAP Y5</symbol><quoteDate>${d}</quoteDate><quote>0.039</quote></record>
  <record><symbol>FF2_Comdty</symbol><quoteDate>${d}</quoteDate><quote>96.3</quote></record>
  <record><symbol>FEDFUNDS</symbol><quoteDate>${d}</quoteDate><quote>0.0363</quote></record></TFCrecords>`;
// ...
const { total } = await updatePensfordSnapshot(db, async () => new Response(xml('07/02/2026')));
expect(total).toBe(2); // 只存 FF2 + FEDFUNDS
expect(getMarketSeries(db, 'SOFRSWAP Y5')).toEqual([]);
expect(getMarketSeries(db, 'FF2_Comdty').length).toBe(1);
```

（保留原有幂等/攒历史断言,但序列改用 `FF2_Comdty`。）

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/server/jobs/pensfordSnapshot.test.ts`
Expected: FAIL(当前实现全存,SOFRSWAP 也入库)。

- [ ] **Step 3: 改 updatePensfordSnapshot**

只保留 Fed 路径需要的序列:

```ts
  const snap = await fetchPensfordQuotes(doFetch);
  // 只留 Fed 路径所需:FF 期货 strip + 隔夜 FEDFUNDS 锚(OIS 已改用 Eris,Term SOFR/美债冗余)。
  const keep = snap.quotes.filter((q) => q.symbol.startsWith('FF') || q.symbol === 'FEDFUNDS');
  insertMarketSeries(db, keep.map((q) => ({ seriesId: q.symbol, obsDate: snap.quoteDate, value: q.value })));
  return { total: keep.length };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test src/server/jobs/pensfordSnapshot.test.ts`
Expected: PASS。

- [ ] **Step 5: 写一次性清理脚本**

`src/server/storage/cleanupPensford.ts`:

```ts
import { openDb } from './db';

// 一次性:删掉 OIS 改用 Eris 后冗余的 Pensford 序列(保留 FF*/FEDFUNDS 供 Fed 路径)。
// 幂等,可重复跑。运行:bun run src/server/storage/cleanupPensford.ts
if (import.meta.main) {
  const db = openDb();
  const info = db.run(
    `DELETE FROM market_series
     WHERE series_id LIKE 'SOFRSWAP%' OR series_id LIKE 'TREASURY%' OR series_id LIKE 'SOFRTERM%'
        OR series_id IN ('SOFR', 'SOFR_M1', 'SOFR_M3', 'SOFR_M6')`,
  );
  db.close();
  console.log(`Cleaned up ${info.changes} redundant Pensford rows.`);
}
```

- [ ] **Step 6: 全量测试 + typecheck + 提交**

Run: `bun test` → 全绿;`bunx tsc --noEmit` → EXIT 0。

```bash
git add src/server/jobs/pensfordSnapshot.ts src/server/jobs/pensfordSnapshot.test.ts src/server/storage/cleanupPensford.ts
git commit -m "refactor(jobs): Pensford 瘦身为只抓 FF 期货 + 一次性清理冗余序列脚本"
```

---

## 运维交接(非代码)

- 上线后跑一次灌数:`bun run src/server/jobs/erisSnapshot.ts`(当天)+ `bun run src/server/jobs/erisBackfill.ts`(默认回填 3 年;要更早传日期如 `... 2019-01-01`)。
- 清理旧 Pensford 冗余:`bun run src/server/storage/cleanupPensford.ts`(一次)。
- `eris_snapshot` 已挂进 `runDailyJob` → com.mtv.daily 每天自动抓。
- 前端无需改动;`sofr_ois` tab 现显示 Eris 24 档(1D…50Y),有回填历史 → 多时点叠加立即可用。

## Self-Review

- **Spec 覆盖**:Eris 抓取(T1)、每日 job+编排(T2)、历史回填(T3)、路由切 Eris(T4)、Pensford 瘦身+清理(T5)、运维——全覆盖。"用精确 par-OIS" = 读 FairCoupon 列(T1);"回填历史" = T3;"Pensford 瘦身留 FF" = T5;OIS 换 Eris = T4。✅
- **占位符**:无 TBD,每步含实际代码/命令。✅
- **类型一致**:`ErisCurve`/`ErisPoint`(T1)→ T2/T3 用;`ERIS_OIS_{tenor}` series_id 在 T2/T3 存、T4 读一致;`ERIS_OIS_TENORS`(T4)与存储 tenor 命名一致;`updateErisSnapshot`/`backfillEris` 签名定义与调用一致;Pensford `FF*`/`FEDFUNDS` 在 T5 存、既有 fed_path 路由读 `FF{n}_Comdty` 对齐。✅
- **注意**:`erisBackfill` 与 `shiftDate` 都用 `new Date()`;仅在应用/CLI 运行,非 Workflow 脚本,允许。
