// ponytail: 静音 moomoo-api SDK 的 console.debug 噪音(每次断开/异常都 dump 整个 WebSocket Event)。
// 我们自己不用 console.debug。改用打补丁会被 bun install 冲掉,这里一行覆盖最省。
console.debug = () => {};

import type { Database } from 'bun:sqlite';
import { openDb, migrate } from '../storage/db';
import {
  startJobRun,
  finishJobRun,
  getTodaySucceededJobs,
  getLatestMarketDate,
  type FinishParams,
} from '../storage/repository';
import { lastClosedTradingDate } from '../analytics/tradingCalendar';
import { OPTIONS_UNDERLYINGS } from '../config';
import { defaultMoomooOptionsClient } from '../fetchers/moomooOptions';
import type { OptionsChainClient } from '../fetchers/optionsChain';
import { runOptionsSnapshot } from './optionsSnapshot';
import { createCboeOptionsClient } from '../fetchers/cboeOptions';
import { updateVxTermStructure } from './vxTermStructure';
import { updateErisSnapshot } from './erisSnapshot';
import { updateIceCds, ingestArchivedIce } from './iceCdsSnapshot';
import { ingestArchivedOptions } from './cboeArchive';
import { ingestArchivedDeribit } from './deribitArchive';
import { syncedArchiveRuns, type ArchiveRun } from '../fetchers/snapshotArchive';
import { updateDtccCds, type DtccCdsResult } from './dtccCdsSnapshot';
import { updateDtccZcis, type ZcisResult } from './dtccZcisSnapshot';
import { updateDtccFxVol, type FxVolResult } from './dtccFxVolSnapshot';
import { updateCreditSpreads } from './creditSpreadSnapshot';
import { updateMoveIndex, ingestArchivedMove, type MoveUpdateResult } from './moveSnapshot';
import { updateIsm, type IsmResult } from './ismSnapshot';
import { updatePutCall, PUT_CALL_SERIES, type PutCallResult } from './putCallSnapshot';
import { updateSpxSkew, type SpxSkewResult } from './spxSkewSnapshot';
import { updateJgbi, expectedQuoteDate, JGBI_SERIES, type JgbiResult } from './jgbiSnapshot';

// 认沽认购比的新鲜度探针:三条同一页同一时刻写,看个股那条就够
const PUT_CALL_PROBE = PUT_CALL_SERIES.equity;
// 日本实际利率的新鲜度探针:名义腿每个报价日都有(JGBi 偶尔不公表价格)
const JGBI_PROBE = JGBI_SERIES.nominal;

type RunDailyJobOpts = {
  db: Database;
  /** CBOE 延迟期权链(并行试跑,注入式;CLI 传 createCboeOptionsClient,测试省略以免联网)。 */
  cboeOptionsClient?: OptionsChainClient;
  /** Actions 快照存档(注入式;CLI 传 syncedArchiveRuns,测试省略以免联网)。CBOE / Deribit 期权、ICE、MOVE 先把存档写进库,再自己抓。 */
  archiveRuns?: () => ArchiveRun[];
  /** moomoo 期权标的(如 ['SPY', '.VIX'])。需配合 optionsClient 使用。 */
  optionsUnderlyings?: string[];
  optionsClient?: OptionsChainClient;
  /** Deribit 加密期权标的(如 ['BTC'])。需配合 cryptoOptionsClient 使用。 */
  cryptoOptionsUnderlyings?: string[];
  cryptoOptionsClient?: OptionsChainClient;
  /** VX 期限结构(VX1/VX3)更新器(注入式;CLI 传 updateVxTermStructure,测试省略以免联网)。 */
  vxUpdater?: (db: Database) => Promise<{ total: number }>;
  /** Eris SOFR OIS 曲线更新器(注入式;CLI 传 updateErisSnapshot,测试省略以免联网)。 */
  erisUpdater?: (db: Database) => Promise<{ total: number }>;
  /** ICE 单名 CDS(AI 巨头 + 甲骨文)更新器(注入式;CLI 传 updateIceCds,测试省略以免联网)。 */
  iceCdsUpdater?: (db: Database) => Promise<{ total: number; missing: string[] }>;
  /** 软银 5Y CDS(DTCC 成交披露)更新器(注入式;CLI 传 updateDtccCds,测试省略以免联网)。 */
  sbgCdsUpdater?: (db: Database) => Promise<DtccCdsResult>;
  /** 美元零息通胀掉期 1Y / 2Y(DTCC 成交)更新器(注入式;CLI 传 updateDtccZcis,测试省略以免联网)。 */
  zcisUpdater?: (db: Database) => Promise<ZcisResult>;
  /** 美元/日元 1 个月平值隐含波动率(DTCC 外汇期权成交反推)更新器(注入式;CLI 传 updateDtccFxVol,测试省略以免联网)。 */
  fxVolUpdater?: (db: Database) => Promise<FxVolResult>;
  /** ICE BofA 信用利差(FRED 只留 3 年,落库保历史)更新器(注入式;CLI 传 updateCreditSpreads,测试省略以免联网)。 */
  creditSpreadUpdater?: (db: Database) => Promise<{ total: number; succeeded: number; failures: string[] }>;
  /** MOVE 债市波动率更新器(注入式;CLI 传 updateMoveIndex,测试省略以免联网)。 */
  moveUpdater?: (db: Database) => Promise<MoveUpdateResult>;
  /** ISM 制造业 / 服务业 PMI 更新器(注入式;CLI 传 updateIsm,测试省略以免联网)。 */
  ismUpdater?: (db: Database) => Promise<IsmResult>;
  /** Cboe 认沽认购比(个股 / 指数 / 全部)更新器(注入式;CLI 传 updatePutCall,测试省略以免联网)。 */
  putCallUpdater?: (db: Database) => Promise<PutCallResult>;
  /** SPX 30 天 25Δ(Cboe VIX 分解接口)更新器(注入式;CLI 传 updateSpxSkew,测试省略以免联网)。 */
  spxSkewUpdater?: (db: Database) => Promise<SpxSkewResult>;
  /** 日本 10Y 实际利率 + BEI(JSDA 売買参考統計値)更新器(注入式;CLI 传 updateJgbi,测试省略以免联网)。 */
  jgbiUpdater?: (db: Database) => Promise<JgbiResult>;
  /** Computable GPU Index(H100/H200/B200/B300 算力租赁价)更新器(注入式;cryptoDaily 传 updateComputableGpu,测试省略以免联网)。 */
  computableGpuUpdater?: (db: Database) => Promise<{ total: number; missing: string[]; errors: string[] }>;
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
  storeKey?: (u: string) => string,
  covered?: () => Promise<Set<string>>,
): Promise<void> {
  await withJobRun(db, jobName, async () => {
    // 存档写坏了(文件损坏等)不挡本机自己抓
    const done = await covered?.().catch((err: Error) => {
      console.warn(`快照存档写入失败(本轮照旧自己抓):${err.message}`);
      return new Set<string>();
    });
    // CBOE 的交易日来自文件里的成交时间,取不到就整轮失败,不回退本地推算(不认假日)
    const strictTradingDate = source === 'cboe';
    const { rows, failures } = await runOptionsSnapshot({
      db,
      source,
      underlyings,
      client,
      storeKey,
      strictTradingDate,
      covered: done,
    });
    return threeState(rows.length, rows.length, failures); // rows==0 即无成功 → failed
  });
}

export async function runDailyJob(opts: RunDailyJobOpts): Promise<void> {
  // 期权快照:moomoo(股票/ETF/指数)与 Deribit(加密)各记一个 job,互不连累。
  if (opts.optionsUnderlyings?.length && opts.optionsClient) {
    await runOptionsGroup(opts.db, 'options', 'moomoo', opts.optionsUnderlyings, opts.optionsClient);
  }
  // 并行试跑:CBOE 延迟期权链,同一批标的,落库键带 `@cboe` 后缀(不覆盖 moomoo、不上图)。
  // 对照几个交易日、确认能接上后再切成主源(见 docs/data-sources-candidates.md §1.4)
  if (opts.cboeOptionsClient) {
    const key = (u: string) => `${u}@cboe`;
    const runs = opts.archiveRuns;
    await runOptionsGroup(
      opts.db,
      'options_cboe',
      'cboe',
      OPTIONS_UNDERLYINGS,
      opts.cboeOptionsClient,
      key,
      // async:runs() 同步抛的错也变成 rejected,由 runOptionsGroup 的 catch 兜住,不挡本机自己抓
      runs && (async () => ingestArchivedOptions(opts.db, runs(), OPTIONS_UNDERLYINGS, key)),
    );
  }
  if (opts.cryptoOptionsUnderlyings?.length && opts.cryptoOptionsClient) {
    const underlyings = opts.cryptoOptionsUnderlyings;
    const runs = opts.archiveRuns;
    await runOptionsGroup(
      opts.db,
      'options_crypto',
      'deribit',
      underlyings,
      opts.cryptoOptionsClient,
      undefined,
      runs && (async () => ingestArchivedDeribit(opts.db, runs(), underlyings)),
    );
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

  // ice_cds 分组:AI 巨头 + 甲骨文 + CoreWeave + SpaceX 单名 CDS EOD 结算价(ICE 免费),顺带 CDX 北美 IG / HY 指数。
  // 默认展示的 core 标的或任一 CDX 缺 → failed(数据源可能改 ticker / 端点挂了),让当天后续触发重试并在状态板告警。
  if (opts.iceCdsUpdater) {
    await withJobRun(opts.db, 'ice_cds', async () => {
      // 先补存档里本机没抓到的那几天;存档写坏了不挡本机自己抓
      try {
        if (opts.archiveRuns) ingestArchivedIce(opts.db, opts.archiveRuns());
      } catch (err) {
        console.warn(`ICE 快照存档写入失败(本轮照旧自己抓):${(err as Error).message}`);
      }
      const { total, missing } = await opts.iceCdsUpdater!(opts.db);
      return missing.length
        ? {
            status: 'failed',
            error: `核心标的 / CDX 缺失(数据源可能变动):${missing.join(', ')}`,
            recordsWritten: total,
          }
        : { status: 'success', recordsWritten: total };
    });
  }

  // sbg_cds 分组:软银 5Y CDS(DTCC 成交)。源只留约 2 年、每轮重拉最近两周;任一文件拉失败或两周零成交 → failed,
  // 当天后续触发点重跑(失败的那天下一轮的窗口还覆盖得到,不会永久丢)。
  if (opts.sbgCdsUpdater) {
    await withJobRun(opts.db, 'sbg_cds', async () => {
      const { written, failed } = await opts.sbgCdsUpdater!(opts.db);
      return failed.length
        ? { status: 'failed', error: failed.join('; '), recordsWritten: written }
        : { status: 'success', recordsWritten: written };
    });
  }

  // dtcc_zcis 分组:美元零息通胀掉期 1Y / 2Y(DTCC 成交)。源只留约 2 年、每轮重拉最近两周;任一文件拉失败或筛不出成交 → failed,
  // 当天后续触发点重跑(失败的那天下一轮的窗口还覆盖得到)。
  if (opts.zcisUpdater) {
    await withJobRun(opts.db, 'dtcc_zcis', async () => {
      const { written, failed } = await opts.zcisUpdater!(opts.db);
      return failed.length
        ? { status: 'failed', error: failed.join('; '), recordsWritten: written }
        : { status: 'success', recordsWritten: written };
    });
  }

  // dtcc_fx_vol 分组:美元/日元 1 个月平值隐含波动率(DTCC 外汇期权成交反推)。同 dtcc_zcis:源只留约 2 年、每轮重拉最近两周,
  // 任一文件拉失败或筛不出成交 → failed,当天后续触发点重跑。
  if (opts.fxVolUpdater) {
    await withJobRun(opts.db, 'dtcc_fx_vol', async () => {
      const { written, failed } = await opts.fxVolUpdater!(opts.db);
      return failed.length
        ? { status: 'failed', error: failed.join('; '), recordsWritten: written }
        : { status: 'success', recordsWritten: written };
    });
  }

  // credit_spread 分组:ICE BofA 利差镜像进库(FRED 窗口每天往前挪,漏跑一天就永久丢最早那天 → 失败当天后续触发重跑)。
  if (opts.creditSpreadUpdater) {
    await withJobRun(opts.db, 'credit_spread', async () => {
      const { total, succeeded, failures } = await opts.creditSpreadUpdater!(opts.db);
      return threeState(total, succeeded, failures);
    });
  }

  // move 分组:MOVE 债市波动率。Yahoo 日线断供时只有 meta 当日快照,当天不记就永久缺一格。
  // 判成败看 gotMetaPoint 而非 total:断供时历史 bars 仍有几千行,只看 total 会误判成功、当天不再重试。
  // stalled(meta 日期不前进,疑似源冻结)只挂告警文案、仍记 success —— partial 不算 succeeded,
  // 会让这组当天每个触发点都重跑,而冻结不会自愈,重跑无用。
  if (opts.moveUpdater) {
    await withJobRun(opts.db, 'move', async () => {
      // 先补存档里本机没抓到的那几天;存档写坏了不挡本机自己抓
      try {
        if (opts.archiveRuns) ingestArchivedMove(opts.db, opts.archiveRuns());
      } catch (err) {
        console.warn(`MOVE 快照存档写入失败(本轮照旧自己抓):${(err as Error).message}`);
      }
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
  // H100/H200/B200 缺任一才算 failed(当天后续触发点只重跑这一组,见 runPendingGroups)。
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

  // put_call 分组:Cboe 认沽认购比。最近 30 天里库里缺的天都补,漏的天下一轮自然补上。
  // 源还没发布(没数据)不算失败;当天后续触发点要不要再跑交给新鲜度探针(见 staleFreshnessProbes)。
  // 停更 / 断档(落后或中间缺超过 5 个工作日)= 直接 failed(红灯),同 ISM:不会自愈,黄灯太容易被忽略
  if (opts.putCallUpdater) {
    await withJobRun(opts.db, 'put_call', async () => {
      const { written, fetched, failed, stale } = await opts.putCallUpdater!(opts.db);
      if (stale.length) return { status: 'failed', error: [...stale, ...failed].join('; '), recordsWritten: written };
      return threeState(written, fetched.length, failed);
    });
  }

  // spx_skew 分组:SPX 30 天 25Δ。同 put_call:最近 30 天缺的天都补;当天的源要到美东次日凌晨才有,
  // 拉不到不算失败、下一轮补,所以不设新鲜度探针。停更 / 断档 = failed(红灯)
  if (opts.spxSkewUpdater) {
    await withJobRun(opts.db, 'spx_skew', async () => {
      const { written, fetched, failed, stale } = await opts.spxSkewUpdater!(opts.db);
      if (stale.length) return { status: 'failed', error: [...stale, ...failed].join('; '), recordsWritten: written };
      return threeState(written, fetched.length, failed);
    });
  }

  // jgbi 分组:日本 10Y 实际利率 + BEI。JSDA 限流(连续请求即 429),每轮只打一次:
  // 拉失败 → failed、窗口里还有缺的天 → partial,两种都让下一个触发点(隔一小时)再跑一次,一次补一天;
  // 停更(落后 ≥3 个营业日)= failed(红灯)
  if (opts.jgbiUpdater) {
    await withJobRun(opts.db, 'jgbi', async () => {
      const { fetched, failed, missing, stale } = await opts.jgbiUpdater!(opts.db);
      const written = fetched ? 1 : 0;
      if (stale || failed) {
        return { status: 'failed', error: [stale, failed].filter(Boolean).join('; '), recordsWritten: written };
      }
      if (missing.length) return { status: 'partial', error: `还缺 ${missing.join(', ')}`, recordsWritten: written };
      return { status: 'success', recordsWritten: written };
    });
  }
}

/** 组名(= job_run.job_name)→ 该组在 runDailyJob 里的注入参数。函数形式:没轮到的组不构造客户端。 */
export type GroupTable = Record<string, () => Partial<Omit<RunDailyJobOpts, 'db'>>>;

/**
 * 一天多触发点(JST 11/12/20/21/22,见 scripts/gen-cron.sh)的「成功即止」守卫,**按组**判:
 * 今天已 success 过的组剔掉,其余(没跑过 / failed / partial)照跑;force 里的组不论成败都跑。
 * 按组而不按整个 job:一组失败只重跑它自己 —— 整轮重跑会把已成功的期权快照换成更晚的那份,
 * 也白打一遍各家接口。所以也不再分「必需 / 可回填」,今天没成功的就再跑。
 */
export function pendingGroups(groups: string[], succeededToday: string[], force: string[] = []): string[] {
  return groups.filter((g) => force.includes(g) || !succeededToday.includes(g));
}

/**
 * 守卫放行跳过还要求数据**真到了上一交易日**,只看「当天 success 过」不够:数据源会晚发布。
 * 2026-10-20 实测:美东 20:08 跑,Yahoo 长历史日线与 CBOE 都还没有 10-19 那根,两组照样报 success
 * → 当天其余触发点全被跳过,面板停在上周五。
 * 探针 = VX1(vx_term_structure 写进 market_series)+ Cboe 认沽认购比(put_call,日统计页晚于收盘才发)。
 * (ETF 现货与 VIX 原先也是探针,2026-11-17 起改读时现拉、不再落库,没有要补跑的组了。)
 * 节假日 lastClosedTradingDate 不认交易所假日 → 恒判滞后 → 这两组当天每个触发点多跑一遍(几十秒,接受)。
 * VX 期货结算偶尔比 VIX 晚一天:那天同理多跑几遍,直到 VX1 到位。
 * 日本实际利率(jgbi)另按 JST 判:JSDA 报价日当晚 19 点后挂出,上午那轮 success 后晚上就该再拉一次。
 * 探针不拉假日表、只认周末和年末:祝日那晚会多跑一次 jgbi 组,组内按真假日表判断不缺,不会打 JSDA。
 */
export function staleFreshnessProbes(db: Database, lastClosed = lastClosedTradingDate(), now = new Date()): string[] {
  const latest: [string, string | null, string][] = [
    ['VX1', getLatestMarketDate(db, 'VX1'), lastClosed],
    [PUT_CALL_PROBE, getLatestMarketDate(db, PUT_CALL_PROBE), lastClosed],
    [JGBI_PROBE, getLatestMarketDate(db, JGBI_PROBE), expectedQuoteDate(now, new Set())],
  ];

  return latest.filter(([, d, want]) => (d ?? '') < want).map(([name]) => name);
}

// 滞后探针 → 写它的那一组
const PROBE_GROUP: Record<string, string> = {
  VX1: 'vx_term_structure',
  [PUT_CALL_PROBE]: 'put_call',
  [JGBI_PROBE]: 'jgbi',
};

/** 滞后探针 → 写它的那一组(见 staleFreshnessProbes)。 */
export function groupsForStaleProbes(stale: string[]): string[] {
  return [...new Set(stale.map((p) => PROBE_GROUP[p]))];
}

/** daily / cryptoDaily 两个 CLI 共用:挑出今天还没成功的组(加上 force)跑一轮,全绿就跳过。返回本轮跑的组。 */
export async function runPendingGroups(db: Database, table: GroupTable, force: string[] = []): Promise<string[]> {
  const pending = pendingGroups(Object.keys(table), getTodaySucceededJobs(db), force);
  if (!pending.length) {
    console.log('今天各组均已成功,跳过本次运行。');
    return pending;
  }

  console.log(`本轮跑:${pending.join(', ')}`);
  await runDailyJob(Object.assign({ db }, ...pending.map((g) => table[g]!())));
  return pending;
}

const DAILY_GROUPS: GroupTable = {
  options: () => ({ optionsUnderlyings: OPTIONS_UNDERLYINGS, optionsClient: defaultMoomooOptionsClient() }),
  vx_term_structure: () => ({ vxUpdater: updateVxTermStructure }),
  eris_snapshot: () => ({ erisUpdater: updateErisSnapshot }),
  options_cboe: () => ({ cboeOptionsClient: createCboeOptionsClient(), archiveRuns: syncedArchiveRuns }),
  ice_cds: () => ({ iceCdsUpdater: updateIceCds, archiveRuns: syncedArchiveRuns }),
  sbg_cds: () => ({ sbgCdsUpdater: (db: Database) => updateDtccCds(db) }),
  dtcc_zcis: () => ({ zcisUpdater: (db: Database) => updateDtccZcis(db) }),
  dtcc_fx_vol: () => ({ fxVolUpdater: (db: Database) => updateDtccFxVol(db) }),
  credit_spread: () => ({ creditSpreadUpdater: updateCreditSpreads }),
  move: () => ({ moveUpdater: updateMoveIndex, archiveRuns: syncedArchiveRuns }),
  ism: () => ({ ismUpdater: updateIsm }),
  put_call: () => ({ putCallUpdater: updatePutCall }),
  spx_skew: () => ({ spxSkewUpdater: updateSpxSkew }),
  jgbi: () => ({ jgbiUpdater: (db: Database) => updateJgbi(db) }),
};

// CLI 入口
if (import.meta.main) {
  const db = openDb();
  migrate(db);

  const stale = staleFreshnessProbes(db);
  // 滞后就说出是哪几条:首轮(还没跑过)本来就滞后,写出来也便于对照跑完有没有追上。
  if (stale.length) console.log(`数据还没到 ${lastClosedTradingDate()}(${stale.join(', ')})。`);

  if ((await runPendingGroups(db, DAILY_GROUPS, groupsForStaleProbes(stale))).length)
    console.log('Daily job complete.');
  db.close();
}
