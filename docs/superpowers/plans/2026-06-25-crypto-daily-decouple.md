# 加密(BTC)期权抓取解耦 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把加密(BTC/Deribit)期权抓取从美股周历解耦——按 UTC 日打戳、独立 job、独立 7 天调度,让 BTC 每天(含周末)都有数据。

**Architecture:** Deribit client 实现 `getTradingDate()` 返回当前 UTC 日(复用 runOptionsSnapshot 现成的打戳钩子);加密组从主 daily job 移出,新建 `cryptoDaily.ts` 复用 `runDailyJob` 只跑 crypto 组 + 独立「当天成功即止」守卫;新建 `com.mtv.crypto` launchd plist 每天 5 触发。

**Tech Stack:** Bun + TypeScript,bun:sqlite,Hono(无关),launchd;`bun test` 测试。

## Global Constraints

- 全 TypeScript on Bun;无新依赖;中文注释;声明式优先。
- BTC 打戳口径 = **当前 UTC 日**(`new Date().toISOString().slice(0,10)`),不跳周末、不认假期。
- 加密 job 与股票 job **完全独立**:各自的「当天成功即止」守卫只看自己的组(加密只看 `options_crypto`),互不影响。
- 加密 job **无 OpenD 依赖**(Deribit 公开 REST),直接 `bun run`,不走 daily-with-opend.sh。
- 不回填历史周末 BTC(Deribit 期权链快照型、无历史);只修将来。
- `runDailyJob` 函数本身不改(仍支持注入式 crypto 参数)。

---

### Task 1: Deribit client 实现 `getTradingDate()` → 当前 UTC 日

**Files:**
- Modify: `src/server/fetchers/deribitOptions.ts`(在 `defaultDeribitOptionsClient` 返回的对象里加方法)
- Test: `src/server/fetchers/deribitOptions.test.ts`(新建)

**Interfaces:**
- Consumes: `OptionsChainClient`(其 `getTradingDate?(): Promise<string | null>` 为可选方法,见 optionsSnapshot.ts)。
- Produces: `defaultDeribitOptionsClient()` 返回的 client 新增 `getTradingDate(): Promise<string>`,返回当前 UTC 日 `YYYY-MM-DD`。runOptionsSnapshot 已有 `(await client.getTradingDate?.()) ?? lastClosedTradingDate()`,故实现后 BTC 自动按 UTC 日打戳。

- [ ] **Step 1: 写失败测试**

新建 `src/server/fetchers/deribitOptions.test.ts`:
```ts
import { describe, test, expect } from 'bun:test';
import { defaultDeribitOptionsClient } from './deribitOptions';

describe('defaultDeribitOptionsClient.getTradingDate', () => {
  test('返回当前 UTC 日(YYYY-MM-DD),不跳周末/假期', async () => {
    const client = defaultDeribitOptionsClient();
    const d = await client.getTradingDate!();
    expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(d).toBe(new Date().toISOString().slice(0, 10)); // 就是 UTC 当日
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/server/fetchers/deribitOptions.test.ts`
Expected: FAIL —— `client.getTradingDate` 是 undefined(`undefined is not a function`)。

- [ ] **Step 3: 实现 getTradingDate**

在 `src/server/fetchers/deribitOptions.ts` 的 `defaultDeribitOptionsClient` 里,给返回对象加一个方法(放在 `async fetchChain(...) {...}` 之后、对象闭合 `}` 之前)。当前结构:
```ts
export function defaultDeribitOptionsClient(): OptionsChainClient {
  return {
    async fetchChain(symbol, targetDte): Promise<OptionChainSnapshot> {
      // … 既有实现不动 …
    },
  };
}
```
改为(仅新增 getTradingDate 方法):
```ts
export function defaultDeribitOptionsClient(): OptionsChainClient {
  return {
    async fetchChain(symbol, targetDte): Promise<OptionChainSnapshot> {
      // … 既有实现不动 …
    },
    // BTC 24/7:按当前 UTC 日打戳(不跳周末、不认假期),区别于美股的 lastClosedTradingDate。
    async getTradingDate(): Promise<string> {
      return new Date().toISOString().slice(0, 10);
    },
  };
}
```
(注意:保留 fetchChain 原有全部代码,只在其后追加 getTradingDate。)

- [ ] **Step 4: 跑测试确认通过 + 类型检查**

Run: `bun test src/server/fetchers/deribitOptions.test.ts && bunx tsc --noEmit`
Expected: 测试 PASS;tsc 无错误。

- [ ] **Step 5: 提交**

```bash
git add src/server/fetchers/deribitOptions.ts src/server/fetchers/deribitOptions.test.ts
git commit -m "feat(crypto): Deribit getTradingDate 返回当前 UTC 日(BTC 24/7 打戳)"
```

---

### Task 2: 加密组移出主 daily job

**Files:**
- Modify: `src/server/jobs/daily.ts`(CLI 入口去掉 crypto;REQUIRED_JOBS 去掉 options_crypto;移除随之无用的 import)
- Test: `src/server/jobs/daily.test.ts`(既有注入式测试应继续通过;无需新增)

**Interfaces:**
- Consumes: `runDailyJob`(不变,仍支持 crypto 注入参数)、`getTodaySucceededJobs`。
- Produces: 主 job CLI 只跑 3 组;`REQUIRED_JOBS = ['options', 'vrp_inputs', 'vx_term_structure']`。加密参数不再由主 CLI 传入(改由 Task 3 的 cryptoDaily.ts 传)。

- [ ] **Step 1: 改 REQUIRED_JOBS + CLI 入口去掉 crypto**

`src/server/jobs/daily.ts`:
- 把
```ts
const REQUIRED_JOBS = ['options', 'options_crypto', 'vrp_inputs', 'vx_term_structure'];
```
改为
```ts
const REQUIRED_JOBS = ['options', 'vrp_inputs', 'vx_term_structure'];
```
- CLI 入口的 `if/else`:把跳过日志的「4 组」改成「3 组」,并从 `runDailyJob({...})` 调用里**删掉** `cryptoOptionsUnderlyings` 和 `cryptoOptionsClient` 两行。改后该块为:
```ts
  const done = getTodaySucceededJobs(db);
  if (REQUIRED_JOBS.every((j) => done.includes(j))) {
    console.log(`今天 3 组已全部成功(${done.join(', ')}),跳过本次运行。`);
  } else {
    await runDailyJob({
      db,
      optionsUnderlyings: OPTIONS_UNDERLYINGS,
      optionsClient: defaultMoomooOptionsClient(),
      vrpInputsUpdater: updateVrpInputs,
      vxUpdater: updateVxTermStructure,
    });
    console.log('Daily job complete.');
  }
  db.close();
```

- [ ] **Step 2: 移除无用 import**

`src/server/jobs/daily.ts` 顶部:`DERIBIT_UNDERLYINGS` 与 `defaultDeribitOptionsClient` 主 CLI 已不用,删掉。
- 把 `import { OPTIONS_UNDERLYINGS, DERIBIT_UNDERLYINGS } from '../config';`
  改为 `import { OPTIONS_UNDERLYINGS } from '../config';`
- 删掉整行 `import { defaultDeribitOptionsClient } from '../fetchers/deribitOptions';`

(注意:`runDailyJob` 内部 `runOptionsGroup(..., 'options_crypto', ...)` 的逻辑保留不动——它由 opts.cryptoOptionsClient 触发,Task 3 会注入。)

- [ ] **Step 3: 跑测试 + 类型检查**

Run: `bun test src/server/jobs/daily.test.ts && bunx tsc --noEmit`
Expected: 既有测试全 PASS(注入式测试本就没传 crypto,行为不变);tsc 无错误(确认无未用 import 残留)。

- [ ] **Step 4: 提交**

```bash
git add src/server/jobs/daily.ts
git commit -m "refactor(ops): 加密组移出主 daily job(主 job 退回 3 组)"
```

---

### Task 3: 新建独立加密 job 入口 cryptoDaily.ts

**Files:**
- Create: `src/server/jobs/cryptoDaily.ts`
- Test: 无单测(CLI 入口,按仓库惯例用 tsc + 手动 smoke 验证;守卫逻辑 getTodaySucceededJobs 已在 repository.test.ts 覆盖)

**Interfaces:**
- Consumes: `openDb`、`migrate`、`runDailyJob`、`getTodaySucceededJobs`、`DERIBIT_UNDERLYINGS`、`defaultDeribitOptionsClient`。
- Produces: 可执行入口 `bun run src/server/jobs/cryptoDaily.ts`——只跑 `options_crypto` 组,自带「当天 options_crypto 成功过则跳过」守卫。

- [ ] **Step 1: 创建 cryptoDaily.ts**

新建 `src/server/jobs/cryptoDaily.ts`:
```ts
/**
 * 独立的加密(BTC/Deribit)期权抓取入口,与美股 daily job 解耦。
 * - 只跑 options_crypto 组(复用 runDailyJob 的注入式 crypto 参数)。
 * - 按当前 UTC 日打戳(Deribit client.getTradingDate),BTC 24/7、含周末。
 * - 「当天成功即止」守卫只看 options_crypto,与股票组互不影响。
 * - Deribit 公开 REST、无 OpenD 依赖,由 com.mtv.crypto 每天 08/11/14/17/20 触发。
 *   直接运行 = 立即抓一次:bun run src/server/jobs/cryptoDaily.ts
 */
import { openDb, migrate } from '../storage/db';
import { getTodaySucceededJobs } from '../storage/repository';
import { runDailyJob } from './daily';
import { DERIBIT_UNDERLYINGS } from '../config';
import { defaultDeribitOptionsClient } from '../fetchers/deribitOptions';

if (import.meta.main) {
  const db = openDb();
  migrate(db);

  if (getTodaySucceededJobs(db).includes('options_crypto')) {
    console.log('今天 options_crypto 已成功,跳过本次运行。');
  } else {
    await runDailyJob({
      db,
      cryptoOptionsUnderlyings: DERIBIT_UNDERLYINGS,
      cryptoOptionsClient: defaultDeribitOptionsClient(),
    });
    console.log('Crypto job complete.');
  }
  db.close();
}
```

- [ ] **Step 2: 类型检查**

Run: `bunx tsc --noEmit`
Expected: 无错误。

- [ ] **Step 3: 手动 smoke(真实抓一次,验证落库 + UTC 打戳)**

Run: `bun run src/server/jobs/cryptoDaily.ts`
Expected: 输出 `Crypto job complete.`;随后查库确认 BTC 行按 UTC 日打戳、options_crypto 记 success:
```bash
sqlite3 -readonly data/mtv.db "SELECT snapshot_date, underlying, source FROM option_snapshot_25delta WHERE underlying='BTC' ORDER BY snapshot_date DESC LIMIT 1;"
sqlite3 -readonly data/mtv.db "SELECT job_name,status FROM job_run WHERE job_name='options_crypto' ORDER BY run_id DESC LIMIT 1;"
```
Expected: snapshot_date = 当前 UTC 日(`date -u +%F`);status=success。
再跑一次 `bun run src/server/jobs/cryptoDaily.ts` → 应输出「今天 options_crypto 已成功,跳过本次运行。」(守卫生效)。

- [ ] **Step 4: 提交**

```bash
git add src/server/jobs/cryptoDaily.ts
git commit -m "feat(crypto): 独立 cryptoDaily 入口(只跑 BTC 组 + 独立守卫)"
```

---

### Task 4: 新建 com.mtv.crypto launchd plist(每天 5 触发)

**Files:**
- Create: `~/Library/LaunchAgents/com.mtv.crypto.plist`(不在 git 仓库)

**Interfaces:**
- Consumes: `src/server/jobs/cryptoDaily.ts`(Task 3)。
- Produces: launchd 任务 `com.mtv.crypto`,每天 08/11/14/17/20 跑加密 job。

- [ ] **Step 1: 写 plist**

写入 `~/Library/LaunchAgents/com.mtv.crypto.plist`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.mtv.crypto</string>

    <!-- BTC 24/7:每天(无 Weekday)08/11/14/17/20 触发;多触发 + cryptoDaily 自带
         「当天成功即止」守卫 = 抓成一次即止,没网则后续补。睡眠中不跑,唤醒补跑。 -->
    <key>StartCalendarInterval</key>
    <array>
        <dict><key>Hour</key><integer>8</integer><key>Minute</key><integer>0</integer></dict>
        <dict><key>Hour</key><integer>11</integer><key>Minute</key><integer>0</integer></dict>
        <dict><key>Hour</key><integer>14</integer><key>Minute</key><integer>0</integer></dict>
        <dict><key>Hour</key><integer>17</integer><key>Minute</key><integer>0</integer></dict>
        <dict><key>Hour</key><integer>20</integer><key>Minute</key><integer>0</integer></dict>
    </array>

    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/bun</string>
        <string>run</string>
        <string>/Users/hong/projects/my-trading-view/src/server/jobs/cryptoDaily.ts</string>
    </array>

    <key>WorkingDirectory</key>
    <string>/Users/hong/projects/my-trading-view</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin</string>
    </dict>

    <key>StandardOutPath</key>
    <string>/Users/hong/projects/my-trading-view/data/logs/crypto-cron.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/hong/projects/my-trading-view/data/logs/crypto-cron.log</string>
</dict>
</plist>
```

- [ ] **Step 2: 校验 + 加载**

```bash
plutil -lint ~/Library/LaunchAgents/com.mtv.crypto.plist
launchctl bootout "gui/$(id -u)/com.mtv.crypto" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.mtv.crypto.plist
```
Expected: lint = `OK`;bootstrap 无报错。

- [ ] **Step 3: 验证注册 + 触发一次**

```bash
launchctl print "gui/$(id -u)/com.mtv.crypto" | grep -cE '"Hour"'   # 期望 5
launchctl kickstart -k "gui/$(id -u)/com.mtv.crypto"
sleep 20
tail -n 3 data/logs/crypto-cron.log
```
Expected: 触发数 5;日志出现 `Crypto job complete.` 或「今天 options_crypto 已成功,跳过」。

- [ ] **Step 4: (无 git 提交——plist 不在仓库)**

记录到进度即可;plist 在 `~/Library/LaunchAgents/`,不进版本库。

---

## 初始验证(全部完成后)

```bash
# 连续两天的 BTC 应出现连续 UTC 日期(今天 + 历史);周末不再缺口(将来积累)
sqlite3 -readonly data/mtv.db "SELECT snapshot_date FROM option_snapshot_25delta WHERE underlying='BTC' ORDER BY snapshot_date DESC LIMIT 5;"
./scripts/cron.sh history 2   # job_run 里能看到 options_crypto(由 com.mtv.crypto 写)
```

## Self-Review

**Spec coverage:**
- Deribit getTradingDate → UTC 日 → Task 1 ✓
- 加密组移出主 job + REQUIRED_JOBS 去 options_crypto → Task 2 ✓
- 独立 cryptoDaily 入口 + 独立守卫(只看 options_crypto) → Task 3 ✓
- com.mtv.crypto 每天 5 触发、无 OpenD、独立日志 → Task 4 ✓
- 不回填历史 → 设计明确,计划无回填任务 ✓
- runDailyJob 不改 → Task 2/3 仅注入,未改函数体 ✓
- 测试:getTradingDate 单测(Task 1)+ 打戳贯通已由 optionsSnapshot.test.ts 既有用例覆盖(getTradingDate 钩子)+ 守卫已由 repository.test.ts 覆盖 ✓

**Placeholder scan:** 无 TBD/TODO;每个 code step 给全代码;命令带预期输出。

**Type consistency:** `getTradingDate(): Promise<string>`(Task 1)契合 `OptionsChainClient.getTradingDate?(): Promise<string|null>`;`runDailyJob` 的 `cryptoOptionsUnderlyings/cryptoOptionsClient` 注入(Task 3)与 daily.ts 既有签名一致;`getTodaySucceededJobs(db): string[]`(已存在)在 Task 3 用 `.includes('options_crypto')` 一致;REQUIRED_JOBS 数组元素名与 job_run 的 job_name 一致。
