# BTC 现货抓取解耦 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 BTC 现货(price_eod)抓取从美股周历(主 daily job,Tue–Sat)挪进 7 天的 cryptoDaily,让 BTC 现货每天(含周末)都有,与 BTC 期权同节奏。

**Architecture:** 抽出 `updateBtcPrice(db)`(Deribit 主源 / Yahoo 降级,搬自 vrpInputs 的 BTC priceLeg);`runDailyJob` 加注入式 `btcPriceUpdater` + `btc_price` job_run 块(仿 vxUpdater);cryptoDaily 注入它并把守卫改成 options_crypto + btc_price 两组;vrpInputs 删掉 BTC priceLeg。

**Tech Stack:** Bun + TypeScript,bun:sqlite,`bun test`。

## Global Constraints

- 全 TypeScript on Bun;无新依赖;中文注释;声明式优先。
- 只新增 `btc_price` 一个 job_run 名;不改现有名(options / options_crypto / vrp_inputs / vx_term_structure)。
- BTC 现货 bar 自带真实日期(Deribit/Yahoo,24/7),无打戳逻辑。
- `runDailyJob` 函数除新增 btc_price 块外不动;主 daily CLI 不注入 btcPriceUpdater(只有 cryptoDaily 注入)。
- 不回填:`updateBtcPrice` 增量,`since` 从 price_eod 已存最新 BTC 日期续抓,自然补周末。
- VRP 仍在 routes/vrp.ts 读时从 price_eod 读 BTC,不受影响。

---

### Task 1: 抽出 updateBtcPrice(可注入 fetcher)

**Files:**
- Create: `src/server/jobs/btcPrice.ts`
- Test: `src/server/jobs/btcPrice.test.ts`

**Interfaces:**
- Consumes: `getLatestPriceDate`、`insertPriceEod`(repository)、`HISTORY_START_DATE`(config)、`fetchBtcDailyBars`(deribitBtcPrice)、`createYahooFetcher`(yahoo)、`type Bar`(moomooHistoryKL)。
- Produces: `updateBtcPrice(db: Database, opts?: { deribit?: (since: Date) => Promise<Bar[]>; yahoo?: (since: Date) => Promise<Bar[]> }): Promise<{ total: number }>` —— 增量抓 BTC 日 bar 写 price_eod(Deribit 主源,抛错降级 Yahoo);返回写入行数。opts 仅供测试注入,默认用真实 fetcher。

- [ ] **Step 1: 写失败测试**

新建 `src/server/jobs/btcPrice.test.ts`:
```ts
import { describe, test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate } from '../storage/db';
import { getPriceBars } from '../storage/repository';
import { updateBtcPrice } from './btcPrice';

function freshDb(): Database {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}

describe('updateBtcPrice', () => {
  let db: Database;
  beforeEach(() => { db = freshDb(); });

  test('写 BTC 日 bar 进 price_eod,source=deribit', async () => {
    const { total } = await updateBtcPrice(db, {
      deribit: async () => [
        { date: '2026-06-27', open: 1, high: 2, low: 0.5, close: 1.5 },
        { date: '2026-06-28', open: 1.5, high: 2.5, low: 1, close: 2 },
      ],
    });
    expect(total).toBe(2);
    const bars = getPriceBars(db, 'BTC');
    expect(bars.map((b) => b.date)).toEqual(['2026-06-27', '2026-06-28']); // 含周末,无过滤
    expect(bars[1].close).toBe(2);
  });

  test('Deribit 抛错 → 降级 Yahoo,source=yahoo', async () => {
    const { total } = await updateBtcPrice(db, {
      deribit: async () => { throw new Error('Deribit 503'); },
      yahoo: async () => [{ date: '2026-06-27', open: 1, high: 2, low: 0.5, close: 1.5 }],
    });
    expect(total).toBe(1);
    expect(getPriceBars(db, 'BTC')[0].close).toBe(1.5);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/server/jobs/btcPrice.test.ts`
Expected: FAIL —— `./btcPrice` 模块不存在 / `updateBtcPrice` 未定义。

- [ ] **Step 3: 实现 updateBtcPrice**

新建 `src/server/jobs/btcPrice.ts`:
```ts
/**
 * BTC 现货日 bar 抓取(Deribit BTC-PERPETUAL 主源,Yahoo BTC-USD 降级)→ price_eod。
 * 原在 vrpInputs 的 priceLeg('BTC') 中;独立出来由 7 天的 cryptoDaily 调用,
 * 让 BTC 现货含周末、与 BTC 期权同节奏。增量:since 从 price_eod 已存最新 BTC 日期续抓。
 * opts 仅供测试注入假 fetcher;默认用真实 Deribit / Yahoo。
 */
import type { Database } from 'bun:sqlite';
import { getLatestPriceDate, insertPriceEod } from '../storage/repository';
import { HISTORY_START_DATE } from '../config';
import { fetchBtcDailyBars } from '../fetchers/deribitBtcPrice';
import { createYahooFetcher } from '../fetchers/yahoo';
import type { Bar } from '../fetchers/moomooHistoryKL';

type BarsFetcher = (since: Date) => Promise<Bar[]>;

export async function updateBtcPrice(
  db: Database,
  opts?: { deribit?: BarsFetcher; yahoo?: BarsFetcher },
): Promise<{ total: number }> {
  const deribit: BarsFetcher = opts?.deribit ?? ((since) => fetchBtcDailyBars(since.getTime(), Date.now()));
  const yahoo: BarsFetcher = opts?.yahoo ?? (async (since) =>
    (await createYahooFetcher().fetchDailyBars('BTC-USD', since)).map((r) => ({
      date: r.tradeDate, open: r.open, high: r.high, low: r.low, close: r.close,
    })));

  const latest = getLatestPriceDate(db, 'BTC');
  const since = latest ? new Date(latest + 'T00:00:00Z') : new Date(HISTORY_START_DATE);

  let bars: Bar[];
  let source: string;
  try {
    bars = await deribit(since);
    source = 'deribit';
  } catch (e) {
    console.warn(`[btcPrice] Deribit 失败,降级 Yahoo: ${(e as Error).message}`);
    bars = await yahoo(since);
    source = 'yahoo';
  }

  insertPriceEod(db, bars.map((b) => ({
    underlying: 'BTC', obsDate: b.date, open: b.open, high: b.high, low: b.low, close: b.close, source,
  })));
  return { total: bars.length };
}
```

- [ ] **Step 4: 跑测试确认通过 + 类型检查**

Run: `bun test src/server/jobs/btcPrice.test.ts && bunx tsc --noEmit`
Expected: 2 pass;tsc 无错误。

- [ ] **Step 5: 提交**

```bash
git add src/server/jobs/btcPrice.ts src/server/jobs/btcPrice.test.ts
git commit -m "feat(crypto): 抽出 updateBtcPrice(Deribit 主源/Yahoo 降级 → price_eod)"
```

---

### Task 2: runDailyJob 加 btc_price 组 + cryptoDaily 注入 + 守卫改两组

**Files:**
- Modify: `src/server/jobs/daily.ts`(RunDailyJobOpts 加 btcPriceUpdater + btc_price job_run 块)
- Modify: `src/server/jobs/cryptoDaily.ts`(import + 注入 + 守卫两组)
- Test: 无单测(注入式 job_run 块结构与 vxUpdater 同;CLI 入口按惯例 tsc + 手动 smoke)

**Interfaces:**
- Consumes: `updateBtcPrice`(Task 1)、`getTodaySucceededJobs`、`runDailyJob`。
- Produces: `RunDailyJobOpts.btcPriceUpdater?: (db: Database) => Promise<{ total: number }>`;runDailyJob 注入它时记一条 `btc_price` job_run。cryptoDaily 守卫 = `['options_crypto','btc_price']` 两组当天都成功才跳过。

- [ ] **Step 1: daily.ts 加 btcPriceUpdater 字段**

`src/server/jobs/daily.ts` 的 `RunDailyJobOpts`,在 `vxUpdater?` 行之后加:
```ts
  /** BTC 现货日 bar 更新器(注入式;cryptoDaily 传 updateBtcPrice,测试省略以免联网)。 */
  btcPriceUpdater?: (db: Database) => Promise<{ total: number }>;
```

- [ ] **Step 2: daily.ts 加 btc_price job_run 块**

在 runDailyJob 内、`vx_term_structure` 块的 `}` 之后追加(仿 vxUpdater):
```ts
  // btc_price 分组:BTC 现货日 bar(Deribit 主源 / Yahoo 降级;成功/失败两态)。
  if (opts.btcPriceUpdater) {
    const btcRun = startJobRun(opts.db, 'btc_price');
    try {
      const { total } = await opts.btcPriceUpdater(opts.db);
      finishJobRun(opts.db, btcRun, { status: 'success', recordsWritten: total });
    } catch (err) {
      finishJobRun(opts.db, btcRun, { status: 'failed', error: (err as Error).message });
    }
  }
```

- [ ] **Step 3: cryptoDaily.ts 注入 + 守卫改两组**

`src/server/jobs/cryptoDaily.ts`:
- import 区加:`import { updateBtcPrice } from './btcPrice';`
- 守卫与调用整段替换为:
```ts
  const REQUIRED = ['options_crypto', 'btc_price'];
  if (REQUIRED.every((j) => getTodaySucceededJobs(db).includes(j))) {
    console.log('今天 加密期权 + BTC 现货 均已成功,跳过本次运行。');
  } else {
    await runDailyJob({
      db,
      cryptoOptionsUnderlyings: DERIBIT_UNDERLYINGS,
      cryptoOptionsClient: defaultDeribitOptionsClient(),
      btcPriceUpdater: updateBtcPrice,
    });
    console.log('Crypto job complete.');
  }
```
(注:`getTodaySucceededJobs`、`runDailyJob`、`DERIBIT_UNDERLYINGS`、`defaultDeribitOptionsClient` 已 import,沿用。)

- [ ] **Step 4: 类型检查 + 全量测试 + 手动 smoke**

Run: `bunx tsc --noEmit && bun test 2>&1 | tail -3`
Expected: tsc 无错误;既有测试全通过。
手动 smoke(今天 options_crypto 已成功但 btc_price 尚无 → 守卫不跳过 → 跑两组,补上周末现货):
```bash
bun run src/server/jobs/cryptoDaily.ts 2>&1 | tail -1
sqlite3 -readonly -header -column data/mtv.db "SELECT obs_date, close, source FROM price_eod WHERE underlying='BTC' AND obs_date>='2026-06-26' ORDER BY obs_date;"
sqlite3 -readonly -column data/mtv.db "SELECT job_name,status FROM job_run WHERE job_name='btc_price' ORDER BY run_id DESC LIMIT 1;"
```
Expected: `Crypto job complete.`;price_eod BTC 出现 06-27/06-28/06-29(补齐周末);btc_price job_run = success。

- [ ] **Step 5: 提交**

```bash
git add src/server/jobs/daily.ts src/server/jobs/cryptoDaily.ts
git commit -m "feat(crypto): cryptoDaily 增 btc_price 组 + 守卫改 options_crypto+btc_price 两组"
```

---

### Task 3: vrpInputs 删掉 BTC 现货

**Files:**
- Modify: `src/server/jobs/vrpInputs.ts`(删 BTC priceLeg 一行 + 无用 import)
- Test: 既有 daily/vrpInputs 测试应继续通过

**Interfaces:**
- Consumes: 无新增。
- Produces: vrpInputs 不再写 BTC 现货(改由 cryptoDaily 的 btc_price 组写);ETF/VIX/DVOL 等保持不动。

- [ ] **Step 1: 删 BTC priceLeg 行**

`src/server/jobs/vrpInputs.ts` 删除这一行(约 line 107):
```ts
  await priceLeg('BTC', (since) => fetchBtcDailyBars(since.getTime(), Date.now()), 'deribit', 'BTC-USD');
```
(ETF 的 priceLeg 循环、VIX/DVOL 的 run 块、return 都保留不动。)

- [ ] **Step 2: 删无用 import**

`src/server/jobs/vrpInputs.ts` 删除该行(BTC 删后 fetchBtcDailyBars 不再被用):
```ts
import { fetchBtcDailyBars } from '../fetchers/deribitBtcPrice';
```
(`createYahooFetcher`、`fetchDailyBars`、其余 import 仍被 ETF 腿用,保留。)

- [ ] **Step 3: 类型检查 + 全量测试**

Run: `bunx tsc --noEmit && bun test 2>&1 | tail -3`
Expected: tsc 无错误(确认无 fetchBtcDailyBars 残留引用 / 未用 import);既有测试全通过。

- [ ] **Step 4: 提交**

```bash
git add src/server/jobs/vrpInputs.ts
git commit -m "refactor(vrp): vrpInputs 不再写 BTC 现货(改由 cryptoDaily btc_price 组)"
```

---

## 初始验证(全部完成后)

```bash
# BTC 现货应连续含周末(06-26..06-29 都在)
sqlite3 -readonly -header -column data/mtv.db "SELECT obs_date, source FROM price_eod WHERE underlying='BTC' ORDER BY obs_date DESC LIMIT 6;"
./scripts/cron.sh history 2   # history 里 options_crypto 与 btc_price 两组并列
```

## Self-Review

**Spec coverage:**
- updateBtcPrice 抽出(Deribit 主源/Yahoo 降级,增量,可注入)→ Task 1 ✓
- runDailyJob btcPriceUpdater + btc_price job_run 块 → Task 2 ✓
- cryptoDaily 注入 + 守卫两组 → Task 2 ✓
- vrpInputs 删 BTC priceLeg + 无用 import → Task 3 ✓
- 只新增 btc_price、不动现有 job 名 → Task 1/2 ✓
- 不回填(增量 since 续抓)→ updateBtcPrice 增量逻辑 ✓
- VRP 读 price_eod 不受影响 → 未动 routes/vrp.ts ✓
- 测试:updateBtcPrice 写入 + 降级 Yahoo 单测 → Task 1 ✓;守卫已由 repository.test.ts 覆盖

**Placeholder scan:** 无 TBD/TODO;每个 code step 给全代码;命令带预期输出。

**Type consistency:** `updateBtcPrice(db, opts?) => Promise<{total}>`(Task 1)契合 `btcPriceUpdater?: (db) => Promise<{total}>`(Task 2,与 vxUpdater 同形);`BarsFetcher = (since: Date) => Promise<Bar[]>` 与注入的假 fetcher 一致;`Bar` 来自 moomooHistoryKL(open/high/low/close/date)与 insertPriceEod 的 PriceEodRow 字段映射一致;guard 数组元素 'options_crypto'/'btc_price' 与 job_run 的 job_name 一致。
