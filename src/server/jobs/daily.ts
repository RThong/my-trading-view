// ponytail: 静音 moomoo-api SDK 的 console.debug 噪音(每次断开/异常都 dump 整个 WebSocket Event)。
// 我们自己不用 console.debug。改用打补丁会被 bun install 冲掉,这里一行覆盖最省。
console.debug = () => {};

import type { Database } from 'bun:sqlite';
import { openDb, migrate } from '../storage/db';
import { startJobRun, finishJobRun, getTodaySucceededJobs } from '../storage/repository';
import { OPTIONS_UNDERLYINGS } from '../config';
import { defaultMoomooOptionsClient } from '../fetchers/moomooOptions';
import { runOptionsSnapshot, type OptionsChainClient } from './optionsSnapshot';
import { updateVrpInputs } from './vrpInputs';
import { updateVxTermStructure } from './vxTermStructure';

type RunDailyJobOpts = {
  db: Database;
  /** moomoo 期权标的(如 ['SPY', '.VIX'])。需配合 optionsClient 使用。 */
  optionsUnderlyings?: string[];
  optionsClient?: OptionsChainClient;
  /** Deribit 加密期权标的(如 ['BTC'])。需配合 cryptoOptionsClient 使用。 */
  cryptoOptionsUnderlyings?: string[];
  cryptoOptionsClient?: OptionsChainClient;
  /** VRP 输入序列更新器(注入式;CLI 传 updateVrpInputs,测试省略以免联网)。 */
  vrpInputsUpdater?: (db: Database) => Promise<{ total: number; succeeded: number; failures: string[] }>;
  /** VX 期限结构(VX1/VX3)更新器(注入式;CLI 传 updateVxTermStructure,测试省略以免联网)。 */
  vxUpdater?: (db: Database) => Promise<{ total: number }>;
};

/** 跑一组期权快照并记一个 job_run(单标的失败 → partial,全失败 → failed)。 */
async function runOptionsGroup(
  db: Database,
  jobName: string,
  source: string,
  underlyings: string[],
  client: OptionsChainClient,
): Promise<void> {
  const runId = startJobRun(db, jobName);
  try {
    const { rows, failures } = await runOptionsSnapshot({ db, source, underlyings, client });
    if (failures.length === 0) {
      finishJobRun(db, runId, { status: 'success', recordsWritten: rows.length });
    } else if (rows.length === 0) {
      finishJobRun(db, runId, { status: 'failed', error: failures.join('; ') });
    } else {
      finishJobRun(db, runId, { status: 'partial', recordsWritten: rows.length, error: failures.join('; ') });
    }
  } catch (err) {
    finishJobRun(db, runId, { status: 'failed', error: (err as Error).message });
  }
}

export async function runDailyJob(opts: RunDailyJobOpts): Promise<void> {
  // 期权快照:moomoo(股票/ETF/指数)与 Deribit(加密)各记一个 job,互不连累。
  if (opts.optionsUnderlyings?.length && opts.optionsClient) {
    await runOptionsGroup(opts.db, 'options', 'moomoo', opts.optionsUnderlyings, opts.optionsClient);
  }
  if (opts.cryptoOptionsUnderlyings?.length && opts.cryptoOptionsClient) {
    await runOptionsGroup(opts.db, 'options_crypto', 'deribit', opts.cryptoOptionsUnderlyings, opts.cryptoOptionsClient);
  }

  // vrp_inputs 分组:增量更新各 VRP 配方的隐含腿与 RV 腿
  // (隐含 VIX/VXN/GVZ/OVX/DVOL,RV 现货 SPX/NDX/GLD/USO/BTC)。
  // 每源独立容错:全成功 → success,部分源失败 → partial,全失败 → failed。
  if (opts.vrpInputsUpdater) {
    const vrpRun = startJobRun(opts.db, 'vrp_inputs');
    try {
      const { total, succeeded, failures } = await opts.vrpInputsUpdater(opts.db);
      if (failures.length === 0) {
        finishJobRun(opts.db, vrpRun, { status: 'success', recordsWritten: total });
      } else if (succeeded === 0) {
        finishJobRun(opts.db, vrpRun, { status: 'failed', error: failures.join('; ') });
      } else {
        finishJobRun(opts.db, vrpRun, { status: 'partial', recordsWritten: total, error: failures.join('; ') });
      }
    } catch (err) {
      finishJobRun(opts.db, vrpRun, { status: 'failed', error: (err as Error).message });
    }
  }

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
}

// 一天多触发点(08/11/14/17/20)的「成功即止」守卫:这 3 组当天全部 success 过 → 跳过本次。
// 任一组当天还没成功(含失败/部分)→ 照常跑,直到跑出一次全绿。
const REQUIRED_JOBS = ['options', 'vrp_inputs', 'vx_term_structure'];

// CLI 入口
if (import.meta.main) {
  const db = openDb();
  migrate(db);

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
}
