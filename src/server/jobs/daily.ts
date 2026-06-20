import type { Database } from 'bun:sqlite';
import { openDb, migrate } from '../storage/db';
import { startJobRun, finishJobRun } from '../storage/repository';
import { OPTIONS_UNDERLYINGS, DERIBIT_UNDERLYINGS } from '../config';
import { defaultMoomooOptionsClient } from '../fetchers/moomooOptions';
import { defaultDeribitOptionsClient } from '../fetchers/deribitOptions';
import { runOptionsSnapshot, type OptionsChainClient } from './optionsSnapshot';

type RunDailyJobOpts = {
  db: Database;
  /** moomoo 期权标的(如 ['SPY', '.VIX'])。需配合 optionsClient 使用。 */
  optionsUnderlyings?: string[];
  optionsClient?: OptionsChainClient;
  /** Deribit 加密期权标的(如 ['BTC'])。需配合 cryptoOptionsClient 使用。 */
  cryptoOptionsUnderlyings?: string[];
  cryptoOptionsClient?: OptionsChainClient;
};

/** 跑一组期权快照并记一个 job_run(单标的失败 → partial,全失败 → failed)。 */
async function runOptionsGroup(
  db: Database,
  jobName: string,
  underlyings: string[],
  client: OptionsChainClient,
): Promise<void> {
  const runId = startJobRun(db, jobName);
  try {
    const { rows, failures } = await runOptionsSnapshot({ db, underlyings, client });
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
    await runOptionsGroup(opts.db, 'options', opts.optionsUnderlyings, opts.optionsClient);
  }
  if (opts.cryptoOptionsUnderlyings?.length && opts.cryptoOptionsClient) {
    await runOptionsGroup(opts.db, 'options_crypto', opts.cryptoOptionsUnderlyings, opts.cryptoOptionsClient);
  }
}

// CLI 入口
if (import.meta.main) {
  const db = openDb();
  migrate(db);

  await runDailyJob({
    db,
    optionsUnderlyings: OPTIONS_UNDERLYINGS,
    optionsClient: defaultMoomooOptionsClient(),
    cryptoOptionsUnderlyings: DERIBIT_UNDERLYINGS,
    cryptoOptionsClient: defaultDeribitOptionsClient(),
  });

  db.close();
  console.log('Daily job complete.');
}
