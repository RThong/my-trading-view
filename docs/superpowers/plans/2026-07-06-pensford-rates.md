# Pensford 利率视角(Fed 路径 + SOFR OIS)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 每天抓 Pensford `quotes.xml` 存库,新增「SOFR OIS」和「Fed 路径」两个利率竖 tab,复用已有的收益曲线图/表/日期选择器。

**Architecture:** 一个 daily job 抓 Pensford 快照(只有当天、无历史,逐日 upsert 攒历史)存进现有 `market_series` 表;`/api/yield-curve` 路由加 `?source=` 分支(treasury 走 FRED 现拉、sofr_ois / fed_path 读库);前端把收益曲线视图泛化成按 `source` 取数,`利率` 视角下开三个 tab 各传一个 source。

**Tech Stack:** Bun + Hono(后端)、React 19 + Vite + SWR(前端)、SQLite(`market_series`)、`bun test`。

## Global Constraints

- 全 TypeScript on Bun,**不用 Python**。
- 中文注释,只解释「为什么」;声明式优先(map/filter,除非明显更绕)。
- Pensford `quotes.xml` = 只有当天快照、**无历史、不能回填**;每天 upsert 一行,历史从上线日起攒。
- Pensford 是营销静态文件、无 SLA;fetch 失败必须优雅降级(job 记 failed,不崩)。
- 值单位:XML 里利率是小数(0.0366=3.66%),FF 期货是价格(96.315);**存原始值,读时按 source 转**(OIS ×100、Fed 路径 100−price)。
- 复用现有:`insertMarketSeries` / `getMarketSeries`(`storage/repository.ts`)、daily job 形状(`jobs/vxTermStructure.ts`)、`YieldCurveChart` / `YieldCurvePanel` / `useYieldCurve`(`web/panels/`)。
- 数据源常量:`https://19621209.fs1.hubspotusercontent-na1.net/hubfs/19621209/quotes.xml`

---

## File Structure

- `src/server/fetchers/pensford.ts`(新)—— 拉 + 解析 quotes.xml(纯解析函数 `parsePensfordXml` 可单测)。
- `src/server/fetchers/pensford.test.ts`(新)—— 解析单测(样例 XML 夹具)。
- `src/server/jobs/pensfordSnapshot.ts`(新)—— 把全部记录 upsert 进 `market_series`;`import.meta.main` 独跑。
- `src/server/jobs/daily.ts`(改)—— 挂进 `runDailyJob`。
- `src/server/analytics/rateCurves.ts`(新)—— OIS/Fed 路径的期限映射 + 值转换纯函数。
- `src/server/analytics/rateCurves.test.ts`(新)—— 转换/映射单测。
- `src/server/routes/yieldCurve.ts`(改)—— 加 `?source=treasury|sofr_ois|fed_path` 分支。
- `src/web/panels/yieldCurve.hooks.ts`(改)—— `useYieldCurve(source)` 带 source 参数。
- `src/web/panels/YieldCurvePanel.tsx`(改)—— 接收 `source` prop 传给 hook。
- `src/web/App.tsx`(改)—— `利率` 视角改成三个 tab。

---

## Task 1: Pensford 抓取 + 解析

**Files:**
- Create: `src/server/fetchers/pensford.ts`
- Test: `src/server/fetchers/pensford.test.ts`

**Interfaces:**
- Produces:
  - `type PensfordQuote = { symbol: string; value: number }`
  - `type PensfordSnapshot = { quoteDate: string; quotes: PensfordQuote[] }`
  - `function parsePensfordXml(xml: string): PensfordSnapshot`(纯,`quoteDate` 归一成 `YYYY-MM-DD`)
  - `function fetchPensfordQuotes(doFetch?: (url: string) => Promise<Response>): Promise<PensfordSnapshot>`

- [ ] **Step 1: 写失败测试**

`src/server/fetchers/pensford.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import { parsePensfordXml } from './pensford';

const SAMPLE = `<TFCrecords timeStamp="07/03/2026 06:00:01 PM">
  <record><symbol>SOFR</symbol><desc>SOFR</desc><quoteDate>07/03/2026</quoteDate><quote>0.0366</quote><change>0</change></record>
  <record><symbol>SOFRSWAP Y5</symbol><desc>SOFR Swap 5-Year</desc><quoteDate>07/03/2026</quoteDate><quote>0.039389</quote><change>0</change></record>
  <record><symbol>FF2_Comdty</symbol><desc>2nd Fed Funds Future</desc><quoteDate>07/03/2026</quoteDate><quote>96.315000</quote><change>0</change></record>
</TFCrecords>`;

describe('parsePensfordXml', () => {
  const snap = parsePensfordXml(SAMPLE);
  it('把 timeStamp 归一成 YYYY-MM-DD', () => expect(snap.quoteDate).toBe('2026-07-03'));
  it('抓到全部记录', () => expect(snap.quotes.length).toBe(3));
  it('symbol 原样、value 转数字', () => {
    expect(snap.quotes.find((q) => q.symbol === 'SOFRSWAP Y5')?.value).toBe(0.039389);
    expect(snap.quotes.find((q) => q.symbol === 'FF2_Comdty')?.value).toBe(96.315);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/server/fetchers/pensford.test.ts`
Expected: FAIL —— `parsePensfordXml` 未定义 / 模块不存在。

- [ ] **Step 3: 写实现**

`src/server/fetchers/pensford.ts`:

```ts
import { fetchWithTimeout } from './http';

// Pensford(swap 顾问)公开的免费日更快照,唯一免费的 SOFR OIS / Fed Funds 期货 / Term SOFR 源。
// 只有当天一张快照,无历史 —— 靠 daily job 逐日存库攒历史。
const PENSFORD_URL = 'https://19621209.fs1.hubspotusercontent-na1.net/hubfs/19621209/quotes.xml';

export type PensfordQuote = { symbol: string; value: number };
export type PensfordSnapshot = { quoteDate: string; quotes: PensfordQuote[] };

// ponytail: 正则解析,结构固定(<record><symbol/><quote/></record>),不值得引 XML DOM 依赖。
export function parsePensfordXml(xml: string): PensfordSnapshot {
  const stamp = xml.match(/timeStamp="(\d{2})\/(\d{2})\/(\d{4})/);
  if (!stamp) throw new Error('Pensford XML: 找不到 timeStamp');
  const quoteDate = `${stamp[3]}-${stamp[1]}-${stamp[2]}`;

  const quotes = [...xml.matchAll(/<record>([\s\S]*?)<\/record>/g)].flatMap((m) => {
    const sym = m[1].match(/<symbol>([^<]*)<\/symbol>/)?.[1]?.trim();
    const raw = m[1].match(/<quote>([^<]*)<\/quote>/)?.[1]?.trim();
    const value = Number(raw);
    return sym && raw && Number.isFinite(value) ? [{ symbol: sym, value }] : [];
  });

  return { quoteDate, quotes };
}

export async function fetchPensfordQuotes(
  doFetch: (url: string) => Promise<Response> = fetchWithTimeout,
): Promise<PensfordSnapshot> {
  const res = await doFetch(PENSFORD_URL);
  if (!res.ok) throw new Error(`Pensford 请求失败:${res.status}`);
  return parsePensfordXml(await res.text());
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test src/server/fetchers/pensford.test.ts`
Expected: PASS(3 tests)。

- [ ] **Step 5: 提交**

```bash
git add src/server/fetchers/pensford.ts src/server/fetchers/pensford.test.ts
git commit -m "feat(fetchers): Pensford quotes.xml 抓取+解析"
```

---

## Task 2: Pensford daily job(存全部序列)

**Files:**
- Create: `src/server/jobs/pensfordSnapshot.ts`
- Modify: `src/server/jobs/daily.ts`

**Interfaces:**
- Consumes: `fetchPensfordQuotes`(Task 1)、`insertMarketSeries`(`storage/repository.ts`)。
- Produces: `function updatePensfordSnapshot(db: Database): Promise<{ total: number }>`。series_id = Pensford symbol 原样(如 `SOFRSWAP Y5`、`FF2_Comdty`、`SOFR`),obs_date = 快照日。

- [ ] **Step 1: 写失败测试**

`src/server/jobs/pensfordSnapshot.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate } from '../storage/db';
import { getMarketSeries } from '../storage/repository';
import { updatePensfordSnapshot } from './pensfordSnapshot';

describe('updatePensfordSnapshot', () => {
  it('把 Pensford 快照按 symbol 存进 market_series', async () => {
    const db = new Database(':memory:');
    migrate(db);
    // 注入假 fetch(返回两天快照,验证逐日攒历史 + 幂等)
    const xml = (d: string) => `<TFCrecords timeStamp="${d} 06:00:01 PM">
      <record><symbol>SOFRSWAP Y5</symbol><quoteDate>${d}</quoteDate><quote>0.039</quote></record>
      <record><symbol>FF2_Comdty</symbol><quoteDate>${d}</quoteDate><quote>96.3</quote></record></TFCrecords>`;

    const { total } = await updatePensfordSnapshot(db, async () => new Response(xml('07/02/2026')));
    expect(total).toBe(2);
    await updatePensfordSnapshot(db, async () => new Response(xml('07/03/2026')));

    const ois = getMarketSeries(db, 'SOFRSWAP Y5');
    expect(ois.map((r) => r.date)).toEqual(['2026-07-02', '2026-07-03']); // 逐日攒
    expect(ois[1].value).toBe(0.039);
    db.close();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/server/jobs/pensfordSnapshot.test.ts`
Expected: FAIL —— `updatePensfordSnapshot` 未定义。

- [ ] **Step 3: 写实现**

`src/server/jobs/pensfordSnapshot.ts`:

```ts
import type { Database } from 'bun:sqlite';
import { openDb, migrate } from '../storage/db';
import { insertMarketSeries } from '../storage/repository';
import { fetchPensfordQuotes } from '../fetchers/pensford';

/**
 * 抓 Pensford 当天快照 → 把全部序列(OIS/FF 期货/Term SOFR/美债/SOFR 均值)按 symbol 存 market_series。
 * Pensford 无历史,每天存一份(obs_date=快照日),逐日攒;upsert 幂等,同日重跑不重复。
 * 直接运行 = 立即抓一次:bun run src/server/jobs/pensfordSnapshot.ts
 */
export async function updatePensfordSnapshot(
  db: Database,
  doFetch?: (url: string) => Promise<Response>,
): Promise<{ total: number }> {
  const snap = await fetchPensfordQuotes(doFetch);
  insertMarketSeries(db, snap.quotes.map((q) => ({ seriesId: q.symbol, obsDate: snap.quoteDate, value: q.value })));
  return { total: snap.quotes.length };
}

if (import.meta.main) {
  const db = openDb();
  migrate(db);
  const { total } = await updatePensfordSnapshot(db);
  db.close();
  console.log(`Pensford snapshot stored: ${total} series.`);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test src/server/jobs/pensfordSnapshot.test.ts`
Expected: PASS。

- [ ] **Step 5: 挂进 daily.ts**

在 `src/server/jobs/daily.ts` 的 `runDailyJob` 里,仿照 `vx_term_structure` 那段加(import 顶部加 `import { updatePensfordSnapshot } from './pensfordSnapshot';`):

```ts
    await withJobRun(opts.db, 'pensford_snapshot', async () => {
      const { total } = await updatePensfordSnapshot(opts.db);
      return threeState(total, total, []); // total==0 → failed(降级)
    });
```

- [ ] **Step 6: 全量测试 + 提交**

Run: `bun test`
Expected: 全绿。

```bash
git add src/server/jobs/pensfordSnapshot.ts src/server/jobs/pensfordSnapshot.test.ts src/server/jobs/daily.ts
git commit -m "feat(jobs): Pensford 快照 daily job + 挂进 daily 编排"
```

---

## Task 3: 后端曲线源分支(sofr_ois / fed_path)

**Files:**
- Create: `src/server/analytics/rateCurves.ts`
- Create: `src/server/analytics/rateCurves.test.ts`
- Modify: `src/server/routes/yieldCurve.ts`

**Interfaces:**
- Consumes: `getMarketSeries`、现有 `Point`(`analytics/regime`)。
- Produces(`rateCurves.ts`):
  - `const OIS_TENORS: { tenor: string; symbol: string }[]`(1Y/2Y/3Y/5Y/7Y/10Y/15Y/30Y → `SOFRSWAP Y{n}`)
  - `const FF_CONTRACTS: number[]`(2..25)
  - `function ffLabel(n: number): string`(`n` → `+{n-1}m`)
  - `function toPercent(v: number): number`(×100)
  - `function impliedFedRate(price: number): number`(100 − price)
- Route:`GET /api/yield-curve?source=treasury|sofr_ois|fed_path`,三者都回 `{ tenors: string[]; series: Record<string, Point[]>; unavailable: string[] }`。默认 `treasury`。

- [ ] **Step 1: 写失败测试**

`src/server/analytics/rateCurves.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import { ffLabel, toPercent, impliedFedRate, OIS_TENORS, FF_CONTRACTS } from './rateCurves';

describe('rateCurves 纯转换', () => {
  it('OIS 小数转百分点', () => expect(toPercent(0.039389)).toBeCloseTo(3.9389, 4));
  it('FF 价格转隐含利率', () => expect(impliedFedRate(96.315)).toBeCloseTo(3.685, 3));
  it('FF 合约 n 标成"月数在前"', () => { expect(ffLabel(2)).toBe('+1m'); expect(ffLabel(13)).toBe('+12m'); });
  it('OIS 期限映射到 Pensford symbol', () =>
    expect(OIS_TENORS.find((t) => t.tenor === '5Y')?.symbol).toBe('SOFRSWAP Y5'));
  it('FF 合约从 2 起', () => expect(FF_CONTRACTS[0]).toBe(2));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/server/analytics/rateCurves.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 写 rateCurves.ts**

```ts
// SOFR OIS / Fed 路径两条曲线的期限映射 + 值转换(纯函数,便于单测)。
// 存进 market_series 的是 Pensford 原始值(OIS 小数、FF 价格),这里定义怎么读成百分点。

// OIS:Pensford 只给这几个期限(SOFRSWAP Y{n}),没有 sub-1Y。
export const OIS_TENORS: { tenor: string; symbol: string }[] = [1, 2, 3, 5, 7, 10, 15, 30].map((y) => ({
  tenor: `${y}Y`,
  symbol: `SOFRSWAP Y${y}`,
}));

// Fed Funds 期货:FF1(当月,部分已过)不给,从 FF2 起;FF{n} = 当月+(n-1) 交割 → 标 "+{n-1}m"。
export const FF_CONTRACTS: number[] = Array.from({ length: 24 }, (_, i) => i + 2); // FF2..FF25
export const ffLabel = (n: number): string => `+${n - 1}m`;

export const toPercent = (v: number): number => v * 100;          // OIS 小数 → 百分点
export const impliedFedRate = (price: number): number => 100 - price; // FF 价格 → 隐含利率(已是百分点)
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test src/server/analytics/rateCurves.test.ts`
Expected: PASS。

- [ ] **Step 5: 改路由加 source 分支**

`src/server/routes/yieldCurve.ts` —— 保留现有 treasury(FRED)逻辑,重构成按 `source` 分派。顶部加 import:

```ts
import { openDb } from '../storage/db';
import { getMarketSeries } from '../storage/repository';
import { OIS_TENORS, FF_CONTRACTS, ffLabel, toPercent, impliedFedRate } from '../analytics/rateCurves';
```

把现有 handler 里 treasury 的主体抽成 `buildTreasury()`(返回 `{tenors, series, unavailable}`,即原来 return 的那个对象),然后加两个读库函数 + 分派:

```ts
type CurveBody = { tenors: string[]; series: Record<string, Point[]>; unavailable: string[] };

// 从 market_series 读一组 (label→symbol),按 xform 转值;缺行的 label 进 unavailable。
function buildFromDb(pairs: { label: string; symbol: string }[], xform: (v: number) => number): CurveBody {
  const db = openDb();
  try {
    const series: Record<string, Point[]> = {};
    const unavailable: string[] = [];
    for (const { label, symbol } of pairs) {
      const rows = getMarketSeries(db, symbol);
      if (rows.length) series[label] = rows.map((r) => ({ date: r.date, value: xform(r.value) }));
      else unavailable.push(label);
    }
    return { tenors: pairs.map((p) => p.label), series, unavailable };
  } finally {
    db.close();
  }
}

const buildOis = (): CurveBody => buildFromDb(OIS_TENORS.map((t) => ({ label: t.tenor, symbol: t.symbol })), toPercent);
const buildFedPath = (): CurveBody =>
  buildFromDb(FF_CONTRACTS.map((n) => ({ label: ffLabel(n), symbol: `FF${n}_Comdty` })), impliedFedRate);
```

handler 改成:

```ts
export const yieldCurveRoute = new Hono().get('/', async (c) => {
  const source = c.req.query('source') ?? 'treasury';
  if (source === 'sofr_ois') return c.json(buildOis());
  if (source === 'fed_path') return c.json(buildFedPath());
  return c.json(await buildTreasury()); // 默认国债(FRED 现拉)
});
```

（`buildTreasury` 即把现有 FRED 抓取 + 组装那段包成一个 `async function buildTreasury(): Promise<CurveBody>`。）

- [ ] **Step 6: 手测三个 source**

Run(dev server 已在跑,或 `bun run src/server/index.ts`):

```bash
curl -s "http://localhost:3000/api/yield-curve?source=fed_path" | head -c 300
curl -s "http://localhost:3000/api/yield-curve?source=sofr_ois" | head -c 300
```

Expected:fed_path 回 `tenors:["+1m",...]`;sofr_ois 回 `tenors:["1Y",...]`。若库里还没 Pensford 数据,`series` 空、`unavailable` 列全 tenor(正常降级)。先跑一次 `bun run src/server/jobs/pensfordSnapshot.ts` 灌一天数据再测。

- [ ] **Step 7: typecheck + 提交**

Run: `bunx tsc --noEmit` → EXIT 0。

```bash
git add src/server/analytics/rateCurves.ts src/server/analytics/rateCurves.test.ts src/server/routes/yieldCurve.ts
git commit -m "feat(server): yield-curve 路由加 sofr_ois / fed_path 源"
```

---

## Task 4: 前端泛化 + 三个利率 tab

**Files:**
- Modify: `src/web/panels/yieldCurve.hooks.ts`
- Modify: `src/web/panels/YieldCurvePanel.tsx`
- Modify: `src/web/App.tsx`

**Interfaces:**
- Consumes: Task 3 的 `/api/yield-curve?source=`。
- Produces:`useYieldCurve(source: string)`;`<YieldCurvePanel source={...} />`。

- [ ] **Step 1: hook 加 source 参数**

`src/web/panels/yieldCurve.hooks.ts` —— 改 `useYieldCurve`:

```ts
export function useYieldCurve(source: string) {
  const { data = NO_DATA, error, isLoading } = useSWR(`/api/yield-curve?source=${source}`, getJson<YieldCurveData>, SWR_OPTS);
  const datesAsc = unionDatesAsc(data.series);
  const maxDate = datesAsc[datesAsc.length - 1];
  return { data, isLoading, error: error as Error | undefined, datesAsc, maxDate, presets: maxDate ? presetDates(maxDate, datesAsc) : [] };
}
```

- [ ] **Step 2: Panel 接 source prop**

`src/web/panels/YieldCurvePanel.tsx` —— 函数签名与首行改:

```tsx
export function YieldCurvePanel({ source }: { source: string }) {
  const { data, isLoading, error, datesAsc, maxDate, presets } = useYieldCurve(source);
  // ……其余不变
```

- [ ] **Step 3: App 利率视角改三 tab**

`src/web/App.tsx` —— 把原来的单 tab 利率视角替换成:

```tsx
  {
    id: 'rates', label: '利率',
    tabs: [
      { id: 'treasury', label: '收益曲线' },
      { id: 'sofr_ois', label: 'SOFR OIS' },
      { id: 'fed_path', label: 'Fed 路径' },
    ],
    render: (tabId) => <YieldCurvePanel source={tabId} />,
  },
```

（`tabId` 即 source:`treasury` / `sofr_ois` / `fed_path`,与路由 query 对齐。）

- [ ] **Step 4: 构建 + 类型 + 现有测试**

Run:
```bash
bunx tsc --noEmit          # EXIT 0
bunx vite build            # 成功
bun test src/web/panels/yieldCurve.hooks.test.ts   # 现有 18 测试仍过(纯逻辑未动)
```
Expected:全绿。

- [ ] **Step 5: 手测三 tab**

dev server 下切「利率」→ 收益曲线(FRED,照旧)/ SOFR OIS(1Y–30Y)/ Fed 路径(+1m…)。
注意:Pensford 系列**只有从灌数当天起的历史**,所以 OIS / Fed 路径的「1 week/month/year ago」预设在攒够之前会被自动丢弃,只剩 Current —— 正常。

- [ ] **Step 6: 提交**

```bash
git add src/web/panels/yieldCurve.hooks.ts src/web/panels/YieldCurvePanel.tsx src/web/App.tsx
git commit -m "feat(web): 利率视角三 tab(收益曲线/SOFR OIS/Fed 路径),视图按 source 泛化"
```

---

## 运维交接(非代码)

- 新 job `pensford_snapshot` 已挂进 `runDailyJob` → 由现有 `com.mtv.daily` launchd(周一~五 08:00)自动跑,无需改 launchd。
- 上线当天手动跑一次灌首日数据:`bun run src/server/jobs/pensfordSnapshot.ts`。
- **历史从上线日起攒、不能回填**;多时点叠加要等历史累积。
- Pensford URL 若失效 → job 记 failed(不崩),前端对应 tab 显示降级(全 tenor unavailable)。后备源见 [[pensford-quotes-xml]] 记忆(CheckMySwap / BoE)。

---

## Self-Review

- **Spec 覆盖**:Pensford 抓取(T1)、存库+编排(T2)、OIS+Fed 路径源(T3)、三 tab 视图(T4)、运维——全覆盖。"全存下来" = T2 存所有 record;"三独立 tab" = T4;"Fed 路径+OIS 一起" = T3+T4 同批。✅
- **占位符**:无 TBD/TODO,每步含实际代码/命令。✅
- **类型一致**:`PensfordSnapshot`/`PensfordQuote`(T1)→ T2 用;`CurveBody`/`{tenors,series,unavailable}` 三源一致;`ffLabel`/`toPercent`/`impliedFedRate` 定义(T3)与调用一致;`useYieldCurve(source)` 定义(T4-S1)与调用(T4-S2)一致。✅
