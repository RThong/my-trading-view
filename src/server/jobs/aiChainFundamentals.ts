import { openDb, migrate } from '../storage/db';
import { startJobRun, finishJobRun } from '../storage/repository';
import { updateSecFundamentals } from './secFundamentals';
import { updateTwseRevenue } from './twseRevenue';
import { updateSec6kReports } from './sec6kReports';
import { updateDartFinancials } from './dartFinancials';
import { ACTIVE_TICKERS, hasSource, type ChainSource } from '../../shared/aiChain';

/**
 * AI 链基本面 job 的**统一入口**:按名单里每家的 source 分派到对应的更新器。
 *
 * 为什么要分派表而不是一个大函数:各源产出的东西根本不同 —— SEC 给四科目、能算 TTM 派生量;
 * TWSE 只给月营收。硬塞进一条流水线会让「哪一步适用于哪个源」变成一堆隐式条件。
 * 加源的动作固定成四步:ChainSource 加值 → SOURCE_KINDS 补格子 → 这里补一行 → 面板补 pane 构造。
 *
 * 每个源**各记一条 job_run**(名字见下表),不是合成一条:
 * TWSE 挂了不该把 SEC 那条的状态灯也弄黄,反之亦然;而且两者的健康含义不同
 * (SEC 稳态是「全 skip 算成功」,TWSE 稳态是「一个月才动一次」)。
 *
 * 直接运行:bun run src/server/jobs/aiChainFundamentals.ts [--force] [TICKER...]
 *   不带 TICKER = 跑启用名单全体;带了就只跑那几家(单跑核对新公司时用)。
 */

/** job_run 里各源记的名字。分开记:TWSE 挂了不该把 SEC 那条状态灯也弄黄。 */
const JOB_NAMES: Record<ChainSource, string> = {
  sec: 'sec_fundamentals',
  sec6k: 'sec6k_reports',
  twse: 'twse_revenue',
  dart: 'dart_financials',
};

type Outcome = {
  fetched: string[];
  skipped: string[];
  failed: string[];
  written: number;
  /** 一行日志 */
  log: string;
  /** 这一轮「一个数都没拿到」——该报红而不是黄。 */
  nothingWorked: boolean;
};

type Runner = (db: ReturnType<typeof openDb>, tickers: string[] | undefined, force: boolean) => Promise<Outcome>;

const RUNNERS: Record<ChainSource, Runner> = {
  async sec(db, tickers, force) {
    // 必须按源过滤(同 sec6k / twse):混合名单单跑(如 `… NVDA TSM`)时,
    // TSM 不走 sec → cikOf 返回 undefined → updateSecFundamentals 直接抛「unknown SEC ticker」,
    // 整条 SEC job 记 failed,连同一轮里本该更新的 NVDA 一起赔进去。
    const only = tickers?.filter((t) => hasSource(t, 'sec'));
    const r = await updateSecFundamentals(db, { force, tickers: only });
    // records_written 记「实际写进库的总行数」= 原始单季行 + 派生序列点。
    // 状态:**「正确地跳过」算成功**——多数天本就该全 skip。
    // 「一个数都没拿到」才红:每家都抛(fetched/skipped 双空),或拉到了但全员解析出 0 行
    // (后者是 tag 链全不命中,比网络挂了更需要人看)。
    return {
      fetched: r.fetched,
      skipped: r.skipped,
      failed: r.failed,
      written: r.rowsWritten + r.seriesWritten,
      nothingWorked:
        (r.fetched.length === 0 && r.skipped.length === 0) || (r.fetched.length > 0 && r.rowsWritten === 0),
      log:
        `SEC: fetched=[${r.fetched}] skipped=[${r.skipped}] failed=[${r.failed}]` +
        `${r.fallback.length ? ` 申报实例兜底=[${r.fallback}]` : ''} rows=${r.rowsWritten} series=${r.seriesWritten}`,
    };
  },

  async sec6k(db, tickers, force) {
    const only = tickers?.filter((t) => hasSource(t, 'sec6k'));
    const r = await updateSec6kReports(db, { force, tickers: only });
    return {
      fetched: r.fetched,
      skipped: r.skipped,
      failed: r.failed,
      written: r.rowsWritten + r.seriesWritten,
      nothingWorked: r.fetched.length === 0 && r.skipped.length === 0,
      log: `SEC6K: fetched=[${r.fetched}] skipped=[${r.skipped}] failed=[${r.failed}] rows=${r.rowsWritten} series=${r.seriesWritten}`,
    };
  },

  async dart(db, tickers, force) {
    const only = tickers?.filter((t) => hasSource(t, 'dart'));
    const r = await updateDartFinancials(db, { force, tickers: only });
    return {
      fetched: r.fetched,
      skipped: r.skipped,
      failed: r.failed,
      written: r.rowsWritten + r.seriesWritten,
      // 缺 key 也走 skipped —— 那是「没配」不是「挂了」,不该报红。
      nothingWorked: r.fetched.length === 0 && r.skipped.length === 0,
      log: `DART: fetched=[${r.fetched}] skipped=[${r.skipped}] failed=[${r.failed}] rows=${r.rowsWritten} series=${r.seriesWritten}`,
    };
  },

  async twse(db, tickers, force) {
    const only = tickers?.filter((t) => hasSource(t, 'twse'));
    // 指定了 TICKER 但没有一个走 TWSE → 本源无事可做,不该记一条空 run。
    const r = await updateTwseRevenue(db, { force, tickers: only });
    return {
      fetched: r.fetched,
      skipped: r.skipped,
      failed: r.failed,
      written: r.written,
      nothingWorked: r.fetched.length === 0 && r.skipped.length === 0,
      log: `TWSE: fetched=[${r.fetched}] skipped=[${r.skipped}] failed=[${r.failed}] rows=${r.written}`,
    };
  },
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const picked = args.filter((a) => !a.startsWith('--'));
  const tickers = picked.length ? picked : undefined;

  // 名单打错字要立刻炸(不是静默跳过):配置错误和数据源故障要分开。
  const unknown = picked.filter((t) => !ACTIVE_TICKERS.includes(t));
  if (unknown.length) throw new Error(`未启用或不存在的 ticker: ${unknown.join(', ')}(见 ACTIVE_TICKERS)`);

  // 只跑「本轮真的有活」的源:指定了 TICKER 时,没被指到的源整个跳过,不记空 run。
  const sources = (Object.keys(RUNNERS) as ChainSource[]).filter(
    (s) => !tickers || tickers.some((t) => hasSource(t, s)),
  );

  const db = openDb();
  migrate(db);

  try {
    // 逐源串行:两个源都要打外部网络,而且各自内部已经是串行(SEC 限速 10 req/s)。
    for (const source of sources) {
      const runId = startJobRun(db, JOB_NAMES[source]);
      try {
        const r = await RUNNERS[source](db, tickers, force);
        const error = r.failed.join('; ');
        finishJobRun(
          db,
          runId,
          r.nothingWorked
            ? { status: 'failed', error: error || '一个数都没拿到(见日志)', recordsWritten: r.written }
            : r.failed.length
              ? { status: 'partial', recordsWritten: r.written, error }
              : { status: 'success', recordsWritten: r.written },
        );
        console.log(r.log);
      } catch (e) {
        // 单源整体抛错只终结它自己那条 run,另一个源照常跑 —— 一个源挂了不该让另一个源当天不更新。
        finishJobRun(db, runId, { status: 'failed', error: String(e) });
        console.error(`${source} 源整体失败:`, e instanceof Error ? e.message : e);
      }
    }
  } finally {
    db.close();
  }
}
