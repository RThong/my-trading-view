# VIX 期限结构(VX1 − VX3 价差)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 CBOE VX 期货的 VX1 − VX3 点差作为 VIX 期限结构指标,在 `.VIX` tab 加一个 pane 显示倒挂信号(>0 backwardation / <0 contango)。

**Architecture:** 复用现有 VRP 模式——存原料(VX1/VX3 进 `market_series`)、读时算价差(路由 inner join)。fetcher 把现有 front-month 逻辑推广为"第 N 近合约";daily job 加一个单一职责增量更新组;前端在 `.VIX` 加一个带 0 基准线的 line pane。

**Tech Stack:** Bun + TypeScript,Hono(路由),bun:sqlite,lightweight-charts v5 + React 19(前端),`bun test`(测试)。

## Global Constraints

- 全 TypeScript on Bun,不引入 Python,不加新依赖(sqlite3/CBOE 直连/lightweight-charts 均已在用)。
- 中文注释;声明式优先于命令式 `for` 循环(数据变换用 map/flatMap/reduce)。
- 测试用 `bun test`,无框架/fixture。**本仓库无前端测试先例**:前端任务用 `bunx tsc --noEmit` 类型检查 + 手动验证,不新建 web 测试框架(YAGNI)。
- `spread = VX1 − VX3`(点差);正=倒挂/恐慌结构化,负=contango。
- 价差读时算,不存 derived 序列;只存 VX1/VX3 原料;不存 VX2、不画全曲线、不爬 vixcentral。
- **硬前提**:任何写进 `market_series` 的新 series_id 必须进 `db.ts` 的 `VOL_INDICES`,否则每天 `migrate()` 里的全量 DELETE 会清掉它。

---

### Task 1: `computeNthMonth` — 把近月推广为第 N 近合约

**Files:**
- Modify: `src/server/fetchers/cboeVx.ts:98-120`(`computeFrontMonth` → `computeNthMonth` + 兼容别名)
- Test: `src/server/fetchers/cboeVx.test.ts`(现有 `computeFrontMonth` 用例须继续通过 + 新增 n=3 用例)

**Interfaces:**
- Produces: `computeNthMonth(contractRows: Array<{ expireDate: string; rows: CboeSettleRow[] }>, n: number): Array<{ tradeDate: string; settle: number; expireDate: string }>` —— 每个交易日取第 n 近未到期合约,合约不足 n 的交易日略过,结果按 tradeDate 升序。
- Produces: `computeFrontMonth(contractRows)` 保留为 `computeNthMonth(contractRows, 1)` 的别名,签名与行为不变。

- [ ] **Step 1: 写失败测试(n=3 选第三近 + 不足则略过)**

在 `src/server/fetchers/cboeVx.test.ts` 顶部 import 改为:
```ts
import { parseSettleCsv, computeFrontMonth, computeNthMonth } from './cboeVx';
```
在文件末尾 `describe('computeFrontMonth', ...)` 之后追加:
```ts
describe('computeNthMonth', () => {
  // 同一交易日 1/15 有三份合约在交易:F6(1/21到期,近月)、G6(2/18,次月)、H6(3/18,三月)。
  const rows = [
    { expireDate: '2026-03-18', rows: [{ tradeDate: '2026-01-15', settle: 19.0 }] }, // H6
    { expireDate: '2026-01-21', rows: [{ tradeDate: '2026-01-15', settle: 17.5 }] }, // F6
    { expireDate: '2026-02-18', rows: [{ tradeDate: '2026-01-15', settle: 18.2 }] }, // G6
  ];

  test('n=3 picks the third-nearest non-expired contract', () => {
    const s = computeNthMonth(rows, 3);
    expect(s).toHaveLength(1);
    expect(s[0]).toEqual({ tradeDate: '2026-01-15', settle: 19.0, expireDate: '2026-03-18' });
  });

  test('n=1 equals front month', () => {
    expect(computeNthMonth(rows, 1)[0].settle).toBe(17.5);
  });

  test('skips trade dates lacking an nth contract', () => {
    // 只有近月一份在交易的日期,取 n=3 无结果。
    const thin = [{ expireDate: '2026-01-21', rows: [{ tradeDate: '2026-01-15', settle: 17.5 }] }];
    expect(computeNthMonth(thin, 3)).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/server/fetchers/cboeVx.test.ts`
Expected: FAIL —— `computeNthMonth` 未导出(`computeNthMonth is not a function` 或类型/import 报错)。

- [ ] **Step 3: 实现 `computeNthMonth`,把 `computeFrontMonth` 改成别名**

在 `src/server/fetchers/cboeVx.ts` 把 `computeFrontMonth`(第 98-120 行整段)替换为:
```ts
/**
 * 对每个交易日,在 expire_date 严格晚于该交易日的合约里,按到期日升序取**第 n 近**。
 * n=1 即约定俗成的 front month(近月)。合约数不足 n 的交易日被略过(不补零)。
 * 返回按交易日升序排列的数据行。
 */
export function computeNthMonth(
  contractRows: Array<{ expireDate: string; rows: CboeSettleRow[] }>,
  n: number,
): Array<{ tradeDate: string; settle: number; expireDate: string }> {
  // 按交易日分组所有未到期候选(同一交易日天然有近月/次月/三月多份合约)。
  const byDate = new Map<string, Array<{ settle: number; expireDate: string }>>();
  for (const c of contractRows) {
    for (const r of c.rows) {
      if (c.expireDate <= r.tradeDate) continue; // 跳过到期当天及之后
      const g = byDate.get(r.tradeDate) ?? [];
      g.push({ settle: r.settle, expireDate: c.expireDate });
      byDate.set(r.tradeDate, g);
    }
  }
  // 组内按到期日升序 → 取第 n 近(index n-1);不足则该日无结果。
  return Array.from(byDate.entries())
    .flatMap(([tradeDate, g]) => {
      const pick = g.sort((a, b) => a.expireDate.localeCompare(b.expireDate))[n - 1];
      return pick ? [{ tradeDate, settle: pick.settle, expireDate: pick.expireDate }] : [];
    })
    .sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
}

/** front month = 第 1 近合约。保留原名供既有调用方使用。 */
export function computeFrontMonth(
  contractRows: Array<{ expireDate: string; rows: CboeSettleRow[] }>,
): Array<{ tradeDate: string; settle: number; expireDate: string }> {
  return computeNthMonth(contractRows, 1);
}
```

- [ ] **Step 4: 跑测试确认全通过(含原 computeFrontMonth 用例)**

Run: `bun test src/server/fetchers/cboeVx.test.ts`
Expected: PASS(parseSettleCsv 4 + computeFrontMonth 2 + computeNthMonth 3)。

- [ ] **Step 5: 提交**

```bash
git add src/server/fetchers/cboeVx.ts src/server/fetchers/cboeVx.test.ts
git commit -m "feat(vx): 把 computeFrontMonth 推广为 computeNthMonth(第N近合约)"
```

---

### Task 2: `fetchVxTermStructure` — 一次下载产出 VX1 + VX3

**Files:**
- Modify: `src/server/fetchers/cboeVx.ts:135-171`(抽出下载逻辑,新增 term-structure 入口)
- Test: `src/server/fetchers/cboeVx.test.ts`(用 fake client 驱动入口)

**Interfaces:**
- Consumes: `computeNthMonth`(Task 1)、`CboeVxClient`、`HISTORY_START_DATE`、`QuoteRow`。
- Produces: `fetchVxTermStructure(opts?: FetchAllOpts): Promise<{ vx1: QuoteRow[]; vx3: QuoteRow[] }>` —— 一次下载合约,产出 symbol 为 `'VX1'` / `'VX3'` 的两条序列,各自套 `HISTORY_START_DATE` 过滤。
- Produces: `fetchVxFrontMonthSeries(opts?)` 保留,行为不变(内部复用下载逻辑)。

- [ ] **Step 1: 写失败测试(fake client → vx1/vx3 symbol 与值正确)**

在 `src/server/fetchers/cboeVx.test.ts` import 增补 `fetchVxTermStructure`、`type CboeVxClient`:
```ts
import { parseSettleCsv, computeFrontMonth, computeNthMonth, fetchVxTermStructure, type CboeVxClient } from './cboeVx';
```
追加:
```ts
describe('fetchVxTermStructure', () => {
  // 三份合约,交易日 2025-01-02 同时在三者 CSV 出现(早于 HISTORY_START_DATE 的日期应被滤掉)。
  const fakeClient: CboeVxClient = {
    fetchContractList: async () => [
      { symbol: 'F', expireDate: '2025-01-21', csvUrl: 'f' },
      { symbol: 'G', expireDate: '2025-02-18', csvUrl: 'g' },
      { symbol: 'H', expireDate: '2025-03-18', csvUrl: 'h' },
    ],
    fetchContractCsv: async (c) => {
      const settle = { f: 17.5, g: 18.2, h: 19.0 }[c.csvUrl]!;
      return [
        { tradeDate: '2000-01-01', settle }, // 早于 HISTORY_START_DATE,应被滤掉
        { tradeDate: '2025-01-02', settle },
      ];
    },
  };

  test('one download yields VX1 (front) and VX3 (third) series', async () => {
    const { vx1, vx3 } = await fetchVxTermStructure({ client: fakeClient, freshSince: '1900-01-01' });
    expect(vx1).toHaveLength(1);
    expect(vx1[0]).toMatchObject({ symbol: 'VX1', tradeDate: '2025-01-02', close: 17.5 });
    expect(vx3[0]).toMatchObject({ symbol: 'VX3', tradeDate: '2025-01-02', close: 19.0 });
  });
});
```
（注:`HISTORY_START_DATE` 当前为 2018,故 2000-01-01 行被滤掉、2025-01-02 保留。）

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/server/fetchers/cboeVx.test.ts`
Expected: FAIL —— `fetchVxTermStructure` 未导出。

- [ ] **Step 3: 抽出下载逻辑 + 新增 term-structure 入口**

在 `src/server/fetchers/cboeVx.ts`,把 `fetchVxFrontMonthSeries`(第 135-171 行整段)替换为:
```ts
/** 下载合约列表 + 各合约 CSV,返回 {expireDate, rows} 数组(供 computeNthMonth 消费)。 */
async function downloadContractRows(
  opts: FetchAllOpts,
): Promise<Array<{ expireDate: string; rows: CboeSettleRow[] }>> {
  const client = opts.client ?? defaultCboeVxClient();
  const freshSince = opts.freshSince ?? new Date().toISOString().slice(0, 10);
  const concurrency = opts.concurrency ?? 12;

  const allContracts = await client.fetchContractList();
  const contracts = allContracts.filter((c) => c.expireDate >= freshSince);

  const contractRows: Array<{ expireDate: string; rows: CboeSettleRow[] }> = [];
  let done = 0;
  for (let i = 0; i < contracts.length; i += concurrency) {
    const batch = contracts.slice(i, i + concurrency);
    const results = await Promise.allSettled(batch.map((c) => client.fetchContractCsv(c)));
    results.forEach((res, idx) => {
      if (res.status === 'fulfilled') {
        contractRows.push({ expireDate: batch[idx].expireDate, rows: res.value });
      }
      done++;
      opts.onProgress?.(done, contracts.length);
    });
  }
  return contractRows;
}

/** 把第 n 近合约序列映射成 QuoteRow[](symbol='VX{n}'),套 HISTORY_START_DATE 过滤。 */
function toQuoteRows(
  contractRows: Array<{ expireDate: string; rows: CboeSettleRow[] }>,
  n: number,
): QuoteRow[] {
  return computeNthMonth(contractRows, n)
    .filter((r) => r.tradeDate >= HISTORY_START_DATE)
    .map((r) => ({
      symbol: `VX${n}`,
      tradeDate: r.tradeDate,
      open: null,
      high: null,
      low: null,
      close: r.settle,
      volume: null,
    }));
}

/**
 * 上层入口:一次下载,产出 VX1(近月)与 VX3(第三近)两条序列。
 * 全量回填传 `freshSince: '1900-01-01'`;日常刷新传较近日期(只处理仍在交易/近期到期的合约)。
 */
export async function fetchVxTermStructure(
  opts: FetchAllOpts = {},
): Promise<{ vx1: QuoteRow[]; vx3: QuoteRow[] }> {
  const contractRows = await downloadContractRows(opts);
  return { vx1: toQuoteRows(contractRows, 1), vx3: toQuoteRows(contractRows, 3) };
}

/** 仅近月 VX1(保留供既有调用方,如 backfillVx)。 */
export async function fetchVxFrontMonthSeries(opts: FetchAllOpts = {}): Promise<QuoteRow[]> {
  return toQuoteRows(await downloadContractRows(opts), 1);
}
```

- [ ] **Step 4: 跑测试 + 类型检查**

Run: `bun test src/server/fetchers/cboeVx.test.ts && bunx tsc --noEmit`
Expected: 测试 PASS;tsc 无错误。

- [ ] **Step 5: 提交**

```bash
git add src/server/fetchers/cboeVx.ts src/server/fetchers/cboeVx.test.ts
git commit -m "feat(vx): fetchVxTermStructure 一次下载产出 VX1+VX3"
```

---

### Task 3: VX1/VX3 进 VOL_INDICES 保留名单(真坑防护)

**Files:**
- Modify: `src/server/storage/db.ts:47`(VOL_INDICES + DELETE 注释)
- Test: `src/server/storage/db.test.ts`(新建:回归测试 migrate 不删 VX1/VX3)

**Interfaces:**
- Consumes: `migrate`、`insertMarketSeries`、`getMarketSeries`。
- Produces: 不变式——`VX1`/`VX3` 写入 `market_series` 后,重复 `migrate()` 不会删除。

- [ ] **Step 1: 写失败测试(migrate 后 VX1 仍在)**

新建 `src/server/storage/db.test.ts`:
```ts
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate } from './db';
import { insertMarketSeries, getMarketSeries } from './repository';

describe('migrate 保留 VX 期限结构序列', () => {
  test('每次 migrate 的全量 DELETE 不清掉 VX1/VX3', () => {
    const db = new Database(':memory:');
    migrate(db);
    insertMarketSeries(db, [
      { seriesId: 'VX1', obsDate: '2026-06-01', value: 18.5 },
      { seriesId: 'VX3', obsDate: '2026-06-01', value: 19.2 },
    ]);
    migrate(db); // daily job 每次启动都会再跑一次 migrate

    expect(getMarketSeries(db, 'VX1')).toHaveLength(1);
    expect(getMarketSeries(db, 'VX3')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/server/storage/db.test.ts`
Expected: FAIL —— 第二次 migrate 的 `DELETE … NOT IN (VOL_INDICES)` 把 VX1/VX3 删了,`getMarketSeries` 返回空数组。

- [ ] **Step 3: 把 VX1/VX3 加进 VOL_INDICES + 改注释**

在 `src/server/storage/db.ts:47`,把
```ts
const VOL_INDICES = ['VIX', 'VXN', 'GVZ', 'OVX', 'DVOL'];
```
改为:
```ts
// market_series 的保留名单:波动率指数 + VX 期货期限结构序列。
// ⚠️ migrateSpotToPriceEod 里的 DELETE 是「每次 migrate() 都跑的全量删除」(daily job 每天启动即 migrate),
//    任何写进 market_series 的新 series_id 不进此名单 = 每日被无条件清掉,且增量抓取永不补回。
const VOL_INDICES = ['VIX', 'VXN', 'GVZ', 'OVX', 'DVOL', 'VX1', 'VX3'];
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test src/server/storage/db.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/server/storage/db.ts src/server/storage/db.test.ts
git commit -m "fix(db): VX1/VX3 进 VOL_INDICES 保留名单,防 migrate 每日清除"
```

---

### Task 4: `updateVxTermStructure` 增量更新组 + 接入 daily job

**Files:**
- Create: `src/server/jobs/vxTermStructure.ts`
- Modify: `src/server/jobs/daily.ts:14-24,49-76,80-93`(注入式 updater + 新 job 组 + CLI 接线)
- Test: `src/server/jobs/daily.test.ts`(注入 fake updater,断言记一条 `vx_term_structure` job_run)

**Interfaces:**
- Consumes: `fetchVxTermStructure`(Task 2)、`insertMarketSeries`、`getLatestMarketDate`、`HISTORY_START_DATE`、`startJobRun`/`finishJobRun`。
- Produces: `updateVxTermStructure(db: Database): Promise<{ total: number }>` —— 增量抓 VX1/VX3 upsert 进 market_series,返回写入行数。
- Produces: `RunDailyJobOpts.vxUpdater?: (db: Database) => Promise<{ total: number }>` —— 注入式;CLI 传 `updateVxTermStructure`,测试传 fake。job_name 固定 `'vx_term_structure'`。

- [ ] **Step 1: 写失败测试(注入 fake updater → 记一条 success job_run)**

在 `src/server/jobs/daily.test.ts` 的 `describe('daily job (options-only)', ...)` 内追加:
```ts
test('vx_term_structure: 注入的 updater 跑完记一条 success', async () => {
  await runDailyJob({
    db,
    vxUpdater: async () => ({ total: 7 }),
  });
  const h = getJobHealth(db).find((h) => h.name === 'vx_term_structure');
  expect(h?.status).toBe('success');
});

test('vx_term_structure: updater 抛错记 failed', async () => {
  await runDailyJob({
    db,
    vxUpdater: async () => { throw new Error('CBOE down'); },
  });
  const h = getJobHealth(db).find((h) => h.name === 'vx_term_structure');
  expect(h?.status).toBe('failed');
  expect(h?.error).toContain('CBOE down');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/server/jobs/daily.test.ts`
Expected: FAIL —— `vxUpdater` 不是 `RunDailyJobOpts` 字段(类型错误),且无 `vx_term_structure` job_run。

- [ ] **Step 3a: 在 daily.ts 加注入字段 + job 组**

`src/server/jobs/daily.ts`:`RunDailyJobOpts` 类型(第 22-23 行 `vrpInputsUpdater` 之后)加:
```ts
  /** VX 期限结构(VX1/VX3)更新器(注入式;CLI 传 updateVxTermStructure,测试省略以免联网)。 */
  vxUpdater?: (db: Database) => Promise<{ total: number }>;
```
在 `runDailyJob` 内、vrp_inputs 块(第 75 行 `}` )之后追加:
```ts
  // vx_term_structure 分组:增量更新 VX1/VX3 期货序列(单一 CBOE 源,成功/失败两态)。
  if (opts.vxUpdater) {
    const vxRun = startJobRun(opts.db, 'vx_term_structure');
    try {
      const { total } = await opts.vxUpdater(opts.db);
      finishJobRun(opts.db, vxRun, { status: 'success', recordsWritten: total });
    } catch (err) {
      finishJobRun(opts.db, vxRun, { status: 'failed', error: (err as Error).message });
    }
  }
```

- [ ] **Step 3b: 创建 updateVxTermStructure 实现**

新建 `src/server/jobs/vxTermStructure.ts`:
```ts
/**
 * 更新 VIX 期限结构原料到库:VX1(近月)/ VX3(第三近)CBOE 期货结算价 → market_series。
 * 价差 VX1−VX3 由 /api/term-structure/vix 读时算(本 job 不算 derived)。
 *
 * 增量:按已存最新日期续抓(freshSince 只下未到期 + 近期到期的合约);库空 → 全量回填。
 * upsert 幂等,可重复跑。直接运行 = 立即更新一次(库空即全量回填):
 *   bun run src/server/jobs/vxTermStructure.ts
 */
import type { Database } from 'bun:sqlite';
import { openDb, migrate } from '../storage/db';
import { insertMarketSeries, getLatestMarketDate } from '../storage/repository';
import { fetchVxTermStructure } from '../fetchers/cboeVx';
import type { QuoteRow } from '../storage/repository';

export async function updateVxTermStructure(db: Database): Promise<{ total: number }> {
  // 增量起点:VX1 已存最新日期(VX1/VX3 同源同步,取 VX1 即可);库空 → '1900-01-01' 全量。
  const freshSince = getLatestMarketDate(db, 'VX1') ?? '1900-01-01';
  const { vx1, vx3 } = await fetchVxTermStructure({ freshSince });

  const write = (rows: QuoteRow[], id: string): number => {
    insertMarketSeries(db, rows.map((r) => ({ seriesId: id, obsDate: r.tradeDate, value: r.close })));
    return rows.length;
  };
  const total = write(vx1, 'VX1') + write(vx3, 'VX3');
  return { total };
}

if (import.meta.main) {
  const db = openDb();
  migrate(db);
  const { total } = await updateVxTermStructure(db);
  db.close();
  console.log(`VX term structure updated: ${total} rows upserted.`);
}
```

- [ ] **Step 3c: CLI 入口接线**

`src/server/jobs/daily.ts`:第 12 行 `import { updateVrpInputs } from './vrpInputs';` 之后加:
```ts
import { updateVxTermStructure } from './vxTermStructure';
```
CLI 的 `runDailyJob({ ... })` 调用(第 84-90 行)里 `vrpInputsUpdater: updateVrpInputs,` 之后加:
```ts
    vxUpdater: updateVxTermStructure,
```

- [ ] **Step 4: 跑测试 + 类型检查**

Run: `bun test src/server/jobs/daily.test.ts && bunx tsc --noEmit`
Expected: 全 PASS(含原有 options 用例 + 两条新 vx 用例);tsc 无错误。

- [ ] **Step 5: 提交**

```bash
git add src/server/jobs/vxTermStructure.ts src/server/jobs/daily.ts src/server/jobs/daily.test.ts
git commit -m "feat(vx): updateVxTermStructure 增量更新组 + 接入 daily job"
```

---

### Task 5: 价差现算 + `/api/term-structure/vix` 路由

**Files:**
- Create: `src/server/analytics/termStructure.ts`(纯函数 `computeSpread`)
- Create: `src/server/routes/termStructure.ts`(Hono 路由)
- Modify: `src/server/index.ts:1-12`(挂载路由)
- Test: `src/server/analytics/termStructure.test.ts`

**Interfaces:**
- Consumes: `getMarketSeries`(返回 `Array<{ date: string; value: number }>`)、`openDb`、Hono。
- Produces: `computeSpread(vx1, vx3): Array<{ date: string; vx1: number; vx3: number; spread: number }>` —— 按 date inner join,`spread = vx1 - vx3`,只保留两边都有的日期。
- Produces: `termStructureRoute`(Hono),`GET /vix` 返回上述数组;在 index.ts 挂在 `/api/term-structure`。

- [ ] **Step 1: 写失败测试(inner join + 单边缺失被丢 + 价差正确)**

新建 `src/server/analytics/termStructure.test.ts`:
```ts
import { describe, test, expect } from 'bun:test';
import { computeSpread } from './termStructure';

describe('computeSpread', () => {
  test('inner joins on date and computes vx1 - vx3', () => {
    const vx1 = [
      { date: '2026-06-01', value: 20.0 },
      { date: '2026-06-02', value: 19.0 }, // 6-02 VX3 缺 → 丢弃
    ];
    const vx3 = [
      { date: '2026-06-01', value: 18.5 },
      { date: '2026-05-31', value: 18.0 }, // 5-31 VX1 缺 → 丢弃
    ];
    expect(computeSpread(vx1, vx3)).toEqual([
      { date: '2026-06-01', vx1: 20.0, vx3: 18.5, spread: 1.5 },
    ]);
  });

  test('empty inputs → empty', () => {
    expect(computeSpread([], [])).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/server/analytics/termStructure.test.ts`
Expected: FAIL —— `computeSpread` 模块不存在。

- [ ] **Step 3a: 实现纯函数**

新建 `src/server/analytics/termStructure.ts`:
```ts
// VIX 期限结构:VX1 − VX3 点差。正=倒挂(backwardation,恐慌结构化),负=contango。
// 按交易日 inner join 两条序列;只保留两边都有值的日期。读时算,不落库。
export type SpreadRow = { date: string; vx1: number; vx3: number; spread: number };

export function computeSpread(
  vx1: Array<{ date: string; value: number }>,
  vx3: Array<{ date: string; value: number }>,
): SpreadRow[] {
  const m3 = new Map(vx3.map((r) => [r.date, r.value]));
  return vx1.flatMap((r) => {
    const v3 = m3.get(r.date);
    return v3 === undefined ? [] : [{ date: r.date, vx1: r.value, vx3: v3, spread: r.value - v3 }];
  });
}
```

- [ ] **Step 3b: 实现路由 + 挂载**

新建 `src/server/routes/termStructure.ts`:
```ts
import { Hono } from 'hono';
import { openDb } from '../storage/db';
import { getMarketSeries } from '../storage/repository';
import { computeSpread } from '../analytics/termStructure';

// VIX 期限结构 VX1−VX3:读 market_series 的 VX1/VX3,inner join 现算价差。
// 仅 VIX 有此指标,路径硬编 vix。
export const termStructureRoute = new Hono()
  .get('/vix', (c) => {
    const db = openDb();
    try {
      return c.json(computeSpread(getMarketSeries(db, 'VX1'), getMarketSeries(db, 'VX3')));
    } finally {
      db.close();
    }
  });
```
`src/server/index.ts`:import 区(第 4 行 `import { priceRoute } ...` 之后)加:
```ts
import { termStructureRoute } from './routes/termStructure';
```
路由链(第 12 行 `.route('/price', priceRoute)` 之后、分号之前)改为:
```ts
  .route('/price', priceRoute)
  .route('/term-structure', termStructureRoute);
```

- [ ] **Step 4: 测试 + 类型检查 + 手动打端点**

Run: `bun test src/server/analytics/termStructure.test.ts && bunx tsc --noEmit`
Expected: 测试 PASS;tsc 无错误。
手动(需先有数据,见 Task 4 backfill;无数据返回 `[]` 也算通过):
```bash
bun run dev:server &   # 起服务
curl -s localhost:3000/api/term-structure/vix | head -c 200; echo
```
Expected: 返回 JSON 数组(有数据时形如 `[{"date":"…","vx1":…,"vx3":…,"spread":…}]`,无数据时 `[]`)。

- [ ] **Step 5: 提交**

```bash
git add src/server/analytics/termStructure.ts src/server/analytics/termStructure.test.ts src/server/routes/termStructure.ts src/server/index.ts
git commit -m "feat(vx): /api/term-structure/vix 读时算 VX1−VX3 价差"
```

---

### Task 6: 前端 — `.VIX` tab 加期限结构 pane(带 0 基准线)

**Files:**
- Modify: `src/web/panels/assetChart.hooks.ts`(类型 + paneConfig 加 underlying 入参 + buildSpecs + useAssetData + baseline 渲染 + COLORS)
- Modify: `src/web/panels/AssetChart.tsx:24,27-30`(paneConfig/useAssetData/buildSpecs 调用补 underlying 实参)

**Interfaces:**
- Consumes: `/api/term-structure/vix`(Task 5)返回 `Array<{ date; vx1; vx3; spread }>`。
- Produces: `paneConfig(underlying: string, vrpUnderlying?: string)` —— `underlying === '.VIX'` 时在末尾追加 `{ key: 'term', label: '期限结构 V1−V3', series: ['v1v3'] }`。
- Produces: `LineSpec` 新增可选字段 `baseline?: number`;`usePaneChart` 对有 baseline 的 line series 调 `createPriceLine`。

- [ ] **Step 1: 类型 + COLORS + TsRow + baseline 字段**

`src/web/panels/assetChart.hooks.ts`:
- 第 14 行 `LineSpec` 类型加可选 baseline:
```ts
export type LineSpec = { key: string; pane: number; kind: 'line'; color: string; title: string; data: LinePoint[]; baseline?: number };
```
- 第 10-12 行类型区追加:
```ts
export type TsRow = { date: string; vx1: number; vx3: number; spread: number };
```
- 第 19-23 行 `COLORS` 加一项(v1v3 用紫色):
```ts
  v1v3: '#a855f7',
```
- 第 27-29 行稳定空引用区追加:
```ts
const NO_TS: TsRow[] = [];
```

- [ ] **Step 2: paneConfig 加 underlying 入参 + term pane**

`src/web/panels/assetChart.hooks.ts:46-62` 的 `paneConfig` 整段替换为:
```ts
export function paneConfig(underlying: string, vrpUnderlying?: string) {
  const ivName = vrpUnderlying ? (IV_INDEX[vrpUnderlying] ?? 'IV') : 'IV';
  const isVix = underlying === '.VIX';
  const seriesName: Record<string, string> = {
    price: '现货', call: 'Call IV', put: 'Put IV', skew: 'Skew',
    iv: `隐含 (${ivName})`, rv: '已实现 RV', vrp: 'VRP',
    v1v3: 'V1−V3 ·到期前数日有 roll 噪音',
  };
  const paneDefs: PaneDef[] = [
    { key: 'price', label: '现货', series: ['price'] },
    { key: 'iv', label: 'IV', series: ['call', 'put'] },
    { key: 'skew', label: 'Skew', series: ['skew'] },
    ...(vrpUnderlying ? [
      { key: 'ivrv', label: '隐含/RV', series: ['iv', 'rv'] },
      { key: 'vrp', label: 'VRP', series: ['vrp'] },
    ] : []),
    ...(isVix ? [{ key: 'term', label: '期限结构 V1−V3', series: ['v1v3'] }] : []),
  ];
  return { seriesName, paneDefs, paneCount: paneDefs.length };
}
```

- [ ] **Step 3: useAssetData 拉 term structure(仅 .VIX)**

`src/web/panels/assetChart.hooks.ts:92-102` 的 `useAssetData` 整段替换为:
```ts
export function useAssetData(underlying: string, vrpUnderlying?: string) {
  // vrpUrl / tsUrl 为 null 时 SWR 原生跳过请求(.VIX 无 VRP;非 .VIX 无期限结构)。
  const optUrl = `/api/options/25delta/${encodeURIComponent(underlying)}?days=${HISTORY_DAYS}`;
  const vrpUrl = vrpUnderlying ? `/api/vrp/${encodeURIComponent(vrpUnderlying)}` : null;
  const priceUrl = `/api/price/${encodeURIComponent(underlying)}`;
  const tsUrl = underlying === '.VIX' ? '/api/term-structure/vix' : null;
  const { data: opt = NO_OPT, error: oe, isLoading: optLoading } = useSWR(optUrl, getJson<OptRow[]>, SWR_OPTS);
  const { data: vrp = NO_VRP, error: ve, isLoading: vrpLoading } = useSWR(vrpUrl, getJson<VrpRow[]>, SWR_OPTS);
  const { data: price = NO_PRICE, error: pe, isLoading: priceLoading } = useSWR(priceUrl, getJson<PriceBar[]>, SWR_OPTS);
  const { data: ts = NO_TS, error: te, isLoading: tsLoading } = useSWR(tsUrl, getJson<TsRow[]>, SWR_OPTS);
  return {
    opt, vrp, price, ts,
    error: (oe ?? ve ?? pe ?? te) as Error | undefined,
    isLoading: optLoading || vrpLoading || priceLoading || tsLoading,
  };
}
```

- [ ] **Step 4: buildSpecs 加 v1v3 line(带 baseline:0)**

`src/web/panels/assetChart.hooks.ts:71-89` 的 `buildSpecs` 整段替换为:
```ts
export function buildSpecs(
  opt: OptRow[], vrp: VrpRow[], price: PriceBar[], ts: TsRow[], interval: Interval,
  vrpUnderlying: string | undefined, paneDefs: PaneDef[], seriesName: Record<string, string>,
): Spec[] {
  const paneOf = (key: string) => paneDefs.findIndex((d) => d.series.includes(key));
  const line = (key: string, rows: Array<Record<string, unknown>>, field: string, color: string): LineSpec =>
    ({ key, pane: paneOf(key), kind: 'line', color, title: seriesName[key], data: aggregate(toLine(rows, field), interval) });
  return [
    { key: 'price', pane: paneOf('price'), kind: 'candle', title: seriesName.price, data: aggregateBars(toBars(price), interval) },
    line('call', opt, 'callIv', COLORS.call),
    line('put', opt, 'putIv', COLORS.put),
    line('skew', opt, 'skew', COLORS.skew),
    ...(vrpUnderlying ? [
      line('iv', vrp, 'iv', COLORS.iv),
      line('rv', vrp, 'rv', COLORS.rv),
      line('vrp', vrp, 'vrp', COLORS.vrp),
    ] : []),
    ...(paneOf('v1v3') >= 0 ? [{ ...line('v1v3', ts, 'spread', COLORS.v1v3), baseline: 0 }] : []),
  ];
}
```

- [ ] **Step 5: usePaneChart 渲染 baseline(0 参考线)**

`src/web/panels/assetChart.hooks.ts:129-138` 建 series 的循环里,把建好 line/candle 后的赋值块改为(在 `seriesRef.current.set(spec.key, s);` 之前插入 baseline 处理):
```ts
      if (!s) {
        s = spec.kind === 'candle'
          ? chart.addSeries(CandlestickSeries, { title: spec.title, upColor: '#22c55e', downColor: '#ef4444', borderVisible: false, wickUpColor: '#22c55e', wickDownColor: '#ef4444', priceLineVisible: false }, spec.pane)
          : chart.addSeries(LineSeries, { color: spec.color, title: spec.title, lineWidth: 2 }, spec.pane);
        if (spec.kind === 'line' && spec.baseline !== undefined) {
          s.createPriceLine({ price: spec.baseline, color: '#71717a', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '0' });
        }
        seriesRef.current.set(spec.key, s);
      }
```

- [ ] **Step 6: AssetChart.tsx 调用补 underlying 实参**

`src/web/panels/AssetChart.tsx`:
- 第 24 行:`const { seriesName, paneDefs, paneCount } = useMemo(() => paneConfig(vrpUnderlying), [vrpUnderlying]);`
  改为:`const { seriesName, paneDefs, paneCount } = useMemo(() => paneConfig(underlying, vrpUnderlying), [underlying, vrpUnderlying]);`
- 第 27 行:`const { opt, vrp, price, error, isLoading } = useAssetData(underlying, vrpUnderlying);`
  改为:`const { opt, vrp, price, ts, error, isLoading } = useAssetData(underlying, vrpUnderlying);`
- 第 28-31 行 `buildSpecs(...)` 调用补 `ts` 实参(与 Step 4 新签名一致):
```ts
  const specs = useMemo(
    () => buildSpecs(opt, vrp, price, ts, interval, vrpUnderlying, paneDefs, seriesName),
    [opt, vrp, price, ts, interval, vrpUnderlying, paneDefs, seriesName],
  );
```

- [ ] **Step 7: 类型检查 + 手动验证**

Run: `bunx tsc --noEmit`
Expected: 无错误。
手动(用 /run skill 或):
```bash
bun run dev   # 起前后端
```
打开 `.VIX` tab,确认底部多一个「期限结构 V1−V3」pane:一条价差线 + 0 处虚线基准;折叠/换位/crosshair 图例正常工作;图例显示 roll 噪音提示。(需 Task 4 已回填 VX 数据;否则该 pane 为空线但不报错。)

- [ ] **Step 8: 提交**

```bash
git add src/web/panels/assetChart.hooks.ts src/web/panels/AssetChart.tsx
git commit -m "feat(web): .VIX tab 加期限结构 V1−V3 pane(带0基准线)"
```

---

## 初始回填(实现完成后执行一次)

VX 数据当前库里为空。Task 4 的 job 在库空时自动全量回填,执行一次即可(下载全部 VX 合约 CSV,耗时数分钟):
```bash
bun run src/server/jobs/vxTermStructure.ts
```
之后每日 daily job 增量续抓。

## Self-Review

**Spec coverage**(逐节对应任务):
- 取数 `computeNthMonth` group→sort→pick + 两序列套 HISTORY_START_DATE → Task 1 + Task 2 ✓
- 存储 VX1/VX3 + VOL_INDICES 硬前提 + 改注释 → Task 3 ✓
- daily job `updateVxTermStructure` 单一职责 + 独立 job_run + 容错 → Task 4 ✓
- 路由 `/api/term-structure/vix` 读时算 → Task 5 ✓
- 前端 `.VIX` pane + 0 基准线 + roll 噪音提示 → Task 6 ✓
- 测试覆盖 computeNthMonth(n=1/n=3/不足)+ 价差(单边缺失)→ Task 1 + Task 5 ✓
- 口径 spread=VX1−VX3、正倒挂负contango → Task 5 注释 + Task 6 baseline ✓

**Placeholder scan:** 无 TBD/TODO;每个 code step 含完整代码;命令含预期输出。

**Type consistency:** `computeNthMonth`/`computeFrontMonth`(Task 1)→ `fetchVxTermStructure`(Task 2)→ `updateVxTermStructure`(Task 4)→ `getMarketSeries`('VX1'/'VX3') → `computeSpread`(Task 5)→ 前端 `TsRow`/`spread` 字段(Task 6)贯通一致;`vxUpdater` 返回 `{ total }` 在 daily.ts 与 vxTermStructure.ts 两处签名一致;`buildSpecs` 新增 `ts` 形参在 hooks 定义与 AssetChart 调用两处一致;`LineSpec.baseline` 在类型、buildSpecs、usePaneChart 三处一致。
