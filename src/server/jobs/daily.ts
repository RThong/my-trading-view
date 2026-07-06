// ponytail: 静音 moomoo-api SDK 的 console.debug 噪音(每次断开/异常都 dump 整个 WebSocket Event)。
// 我们自己不用 console.debug。改用打补丁会被 bun install 冲掉,这里一行覆盖最省。
console.debug = () => {};

import type { Database } from 'bun:sqlite';
import { openDb, migrate } from '../storage/db';
import { startJobRun, finishJobRun, getTodaySucceededJobs, type FinishParams } from '../storage/repository';
import { OPTIONS_UNDERLYINGS } from '../config';
import { defaultMoomooOptionsClient } from '../fetchers/moomooOptions';
import { runOptionsSnapshot, type OptionsChainClient } from './optionsSnapshot';
import { updateVrpInputs } from './vrpInputs';
import { updateVxTermStructure } from './vxTermStructure';
import { updatePensfordSnapshot } from './pensfordSnapshot';

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
  /** BTC 现货日 bar 更新器(注入式;cryptoDaily 传 updateBtcPrice,测试省略以免联网)。返回写入行数。 */
  btcPriceUpdater?: (db: Database) => Promise<number>;
};

/** 包一次 job_run:开跑 → 按 fn 结果落终态;fn 抛异常记 failed。所有分组共用,免去 4 处重复 try/catch。 */
async function withJobRun(
  db: Database, jobName: string, fn: () => Promise<FinishParams>,
): Promise<void> {
  const runId = startJobRun(db, jobName);
  try {
    finishJobRun(db, runId, await fn());
  } catch (err) {
    finishJobRun(db, runId, { status: 'failed', error: (err as Error).message });
  }
}

/** total/succeeded/failures → 三态终态:无失败 success,零成功 failed,其余 partial。 */
function threeState(total: number, succeeded: number, failures: string[]): FinishParams {
  if (failures.length === 0) return { status: 'success', recordsWritten: total };
  if (succeeded === 0) return { status: 'failed', error: failures.join('; ') };
  return { status: 'partial', recordsWritten: total, error: failures.join('; ') };
}

/** 跑一组期权快照并记一个 job_run(单标的失败 → partial,全失败 → failed)。 */
async function runOptionsGroup(
  db: Database, jobName: string, source: string, underlyings: string[], client: OptionsChainClient,
): Promise<void> {
  await withJobRun(db, jobName, async () => {
    const { rows, failures } = await runOptionsSnapshot({ db, source, underlyings, client });
    return threeState(rows.length, rows.length, failures); // rows==0 即无成功 → failed
  });
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
    await withJobRun(opts.db, 'vrp_inputs', async () => {
      const { total, succeeded, failures } = await opts.vrpInputsUpdater!(opts.db);
      return threeState(total, succeeded, failures);
    });
  }

  // vx_term_structure 分组:增量更新 VX1/VX3 期货序列(单一 CBOE 源,成功/失败两态)。
  if (opts.vxUpdater) {
    await withJobRun(opts.db, 'vx_term_structure', async () => {
      const { total } = await opts.vxUpdater!(opts.db);
      return { status: 'success', recordsWritten: total };
    });
  }

  // pensford_snapshot 分组:Pensford 当天快照(OIS/FF/Term SOFR/美债/SOFR 均值,成功/失败两态)。
  await withJobRun(opts.db, 'pensford_snapshot', async () => {
    const { total } = await updatePensfordSnapshot(opts.db);
    return threeState(total, total, []);
  });

  // btc_price 分组:BTC 现货日 bar(Deribit 主源 / Yahoo 降级;成功/失败两态)。
  if (opts.btcPriceUpdater) {
    await withJobRun(opts.db, 'btc_price', async () => {
      const total = await opts.btcPriceUpdater!(opts.db);
      return { status: 'success', recordsWritten: total };
    });
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
