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
import { updateErisSnapshot } from './erisSnapshot';
import { updateIceCds } from './iceCdsSnapshot';
import { updateMoveIndex, type MoveUpdateResult } from './moveSnapshot';
import { updateIsm, type IsmResult } from './ismSnapshot';
import type { SupplyDensityResult } from './supplyDensitySnapshot';

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
  /** Eris SOFR OIS 曲线更新器(注入式;CLI 传 updateErisSnapshot,测试省略以免联网)。 */
  erisUpdater?: (db: Database) => Promise<{ total: number }>;
  /** ICE 单名 CDS(AI 巨头 + 甲骨文)更新器(注入式;CLI 传 updateIceCds,测试省略以免联网)。 */
  iceCdsUpdater?: (db: Database) => Promise<{ total: number; missing: string[] }>;
  /** MOVE 债市波动率更新器(注入式;CLI 传 updateMoveIndex,测试省略以免联网)。 */
  moveUpdater?: (db: Database) => Promise<MoveUpdateResult>;
  /** ISM 制造业 / 服务业 PMI 更新器(注入式;CLI 传 updateIsm,测试省略以免联网)。 */
  ismUpdater?: (db: Database) => Promise<IsmResult>;
  /** Computable GPU Index(H100/H200/B200/B300 算力租赁价)更新器(注入式;cryptoDaily 传 updateComputableGpu,测试省略以免联网)。 */
  computableGpuUpdater?: (db: Database) => Promise<{ total: number; missing: string[]; errors: string[] }>;
  /** BTC ±5% 已实现供应密度(BRK URPD)更新器(注入式;cryptoDaily 传 updateSupplyDensity,测试省略以免联网)。 */
  supplyDensityUpdater?: (db: Database) => Promise<SupplyDensityResult>;
};

/** 包一次 job_run:开跑 → 按 fn 结果落终态;fn 抛异常记 failed。所有分组共用,免去 4 处重复 try/catch。 */
async function withJobRun(db: Database, jobName: string, fn: () => Promise<FinishParams>): Promise<void> {
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
  db: Database,
  jobName: string,
  source: string,
  underlyings: string[],
  client: OptionsChainClient,
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
    await runOptionsGroup(
      opts.db,
      'options_crypto',
      'deribit',
      opts.cryptoOptionsUnderlyings,
      opts.cryptoOptionsClient,
    );
  }

  // vrp_inputs 分组:各 VRP 配方的隐含腿(VIX/VXN/GVZ/OVX/DVOL,增量)与 ETF 现货 RV 腿
  // (SPY/QQQ/GLD/USO/TLT/NOBL,Yahoo 每轮全量重拉;BTC 现货在 crypto job)。
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

  // eris_snapshot 分组:Eris SOFR OIS 曲线(24 档,成功/失败两态)。
  if (opts.erisUpdater) {
    await withJobRun(opts.db, 'eris_snapshot', async () => {
      const { total } = await opts.erisUpdater!(opts.db);
      return threeState(total, total, []);
    });
  }

  // ice_cds 分组:AI 巨头 + 甲骨文单名 CDS EOD 结算价(ICE 免费)。
  // 默认展示的 core 标的缺任一 → failed(数据源可能改 ticker),让当天后续触发重试并在状态板告警。
  if (opts.iceCdsUpdater) {
    await withJobRun(opts.db, 'ice_cds', async () => {
      const { total, missing } = await opts.iceCdsUpdater!(opts.db);
      return missing.length
        ? { status: 'failed', error: `核心标的缺失(数据源可能变动):${missing.join(', ')}`, recordsWritten: total }
        : { status: 'success', recordsWritten: total };
    });
  }

  // move 分组:MOVE 债市波动率。Yahoo 日线断供时只有 meta 当日快照,当天不记就永久缺一格。
  // 判成败看 gotMetaPoint 而非 total:断供时历史 bars 仍有几千行,只看 total 会误判成功、当天不再重试。
  // stalled(meta 日期不前进,疑似源冻结)只挂告警文案、仍记 success —— partial 不算 succeeded,
  // 会让当天守卫永远不绿、把整条 pipeline 重跑 5 次,代价大于收益。
  if (opts.moveUpdater) {
    await withJobRun(opts.db, 'move', async () => {
      const { total, metaDate, gotMetaPoint, stalled } = await opts.moveUpdater!(opts.db);
      if (!gotMetaPoint) {
        return {
          status: 'failed',
          error: `Yahoo meta 无可用收盘快照(meta 日期 ${metaDate ?? '无'})`,
          recordsWritten: total,
        };
      }

      return {
        status: 'success',
        recordsWritten: total,
        error: stalled ? `告警:meta 日期久未前进(仍是 ${metaDate}),疑似 Yahoo 源冻结` : undefined,
      };
    });
  }

  // computable_gpu 分组:CGI 算力租赁价(H100/H200/B200/B300)。B300 provider 最薄、允许缺(experimental),
  // H100/H200/B200 缺任一才算 failed。
  //
  // ⚠️ 这个 failed **只作可见性标记,当天不会被重试** —— 别照 ice_cds 的直觉理解。
  // ice_cds 在 daily 的 REQUIRED 里,所以当天后续触发点会因为它没绿而重跑整组;
  // computable_gpu 故意**不进** cryptoDaily 的 REQUIRED(见那个文件的注释),于是只要
  // options_crypto + btc_price 已绿,后续触发就整体跳过,它当天不会再跑。
  // 这样取舍是因为 CGI **可回填**(服务端保留 26~39 天历史、抓取是幂等覆盖),靠次日跑补就够,
  // 不值得为一个 experimental 源让整组 crypto job 每个触发点都重跑一遍。
  if (opts.computableGpuUpdater) {
    await withJobRun(opts.db, 'computable_gpu', async () => {
      const { total, missing, errors } = await opts.computableGpuUpdater!(opts.db);
      // 有抓取报错就把原文带上 —— 断网和「源真的当天没发点」在这条消息里必须分得开。
      const why = errors.length ? errors.join('; ') : '数据源可能变动(抓取没报错但今天没有新点)';
      return missing.length
        ? { status: 'failed', error: `核心 SKU 缺失:${missing.join(', ')} —— ${why}`, recordsWritten: total }
        : { status: 'success', recordsWritten: total };
    });
  }

  // ism 分组:ISM PMI(月频,PR Newswire)。稳态每次只打一次列表页 —— 新月报一个月才来两篇。
  // **不进 REQUIRED_JOBS**:可回填(漏一天次日补),不值得为它让整组 daily 每个触发点重跑。
  // 美东 10:00 发布 = JST 23:00,当天最后一个触发点(22 点)赶不上,次日第一个触发点拿到。
  if (opts.ismUpdater) {
    await withJobRun(opts.db, 'ism', async () => {
      const { fetched, failed, stale, written } = await opts.ismUpdater!(opts.db);
      // 某扇区停更 = 直接 failed(红灯),不因为这一轮另一个扇区拉到了新数就被 threeState 降成 partial:
      // 停更不会自愈(多半是 slug 改名 / 版式变了,要改代码),黄灯太容易被忽略。
      if (stale.length) return { status: 'failed', error: [...stale, ...failed].join('; '), recordsWritten: written };
      // 稳态 fetched=0 且无失败 → success(没有新月报是常态,不是失败)。
      return threeState(written, fetched.length, failed);
    });
  }

  // btc_price 分组:BTC 现货日 bar(Bitstamp 主源 / Yahoo 降级;成功/失败两态)。
  if (opts.btcPriceUpdater) {
    await withJobRun(opts.db, 'btc_price', async () => {
      const total = await opts.btcPriceUpdater!(opts.db);
      return { status: 'success', recordsWritten: total };
    });
  }

  // btc_supply_density 分组:BTC ±5% 已实现供应密度(BRK,可回填)。
  // **不进 REQUIRED**:漏一天次日自动补(增量按「库里缺哪天」拉),同 ism。
  // 排在 btc_price 之后:首跑全量回填要几分钟,别让 REQUIRED 里的 btc_price 等它。
  // 停更(源最新日期 >3 天不前进)只挂告警文案、仍记 success:停更不会自愈,记 failed 也不会让它好起来。
  if (opts.supplyDensityUpdater) {
    await withJobRun(opts.db, 'btc_supply_density', async () => {
      const { succeeded, failures, latest, stale } = await opts.supplyDensityUpdater!(opts.db);
      const state = threeState(succeeded, succeeded, failures);
      if (!stale || state.status === 'failed') return state;

      const warn = `告警:BRK URPD 疑似停更(源最新 ${latest ?? '无'})`;
      return { ...state, error: state.error ? `${warn}; ${state.error}` : warn };
    });
  }
}

// 一天多触发点(JST 11/12/20/21/22,见 scripts/gen-cron.sh)的「成功即止」守卫:
// 这几组当天全部 success 过 → 跳过本次。
// 任一组当天还没成功(含失败/部分)→ 照常跑,直到跑出一次全绿。
// btc_price 不列入:低频,失败不该阻断"当天必需组已全绿则跳过"的逻辑。
// ice_cds 必须列入:ICE 端点只当日快照、不能回填,当天没抓到就永久丢,首触发失败须让后续触发补。
// move 必须列入:Yahoo 日线断供期间只有 meta 当日快照,当天没记就永久缺一格(同 ice_cds)。
const REQUIRED_JOBS = ['options', 'vrp_inputs', 'vx_term_structure', 'ice_cds', 'move'];

// CLI 入口
if (import.meta.main) {
  const db = openDb();
  migrate(db);

  const done = getTodaySucceededJobs(db);
  if (REQUIRED_JOBS.every((j) => done.includes(j))) {
    console.log(`今天必需组已全部成功(${done.join(', ')}),跳过本次运行。`);
  } else {
    await runDailyJob({
      db,
      optionsUnderlyings: OPTIONS_UNDERLYINGS,
      optionsClient: defaultMoomooOptionsClient(),
      vrpInputsUpdater: updateVrpInputs,
      vxUpdater: updateVxTermStructure,
      erisUpdater: updateErisSnapshot,
      iceCdsUpdater: updateIceCds,
      moveUpdater: updateMoveIndex,
      ismUpdater: updateIsm,
    });
    console.log('Daily job complete.');
  }
  db.close();
}
