import type { Database } from 'bun:sqlite';
import { openDb, migrate } from '../storage/db';
import {
  insertSecFundamentals,
  insertMarketSeries,
  getSecFundamentals,
  getLatestSecFiled,
  getMarketSeriesByPrefix,
  startJobRun,
  finishJobRun,
  type MarketSeriesRow,
} from '../storage/repository';
import { createSecFetcher } from '../fetchers/secXbrl';
import {
  extractFundamentals,
  deriveSeries,
  aggregateFcf,
  seriesId,
  AICHAIN_FCF_SERIES,
  type QuarterPoint,
} from '../analytics/secFundamentals';
import { SEC_ACTIVE_TICKERS, cikOf } from '../config';

/**
 * SEC XBRL 财务 job。**不进 com.mtv.daily**(那是日频行情)——季频数据,每周跑一次足够,
 * 财报季集中在 1/4/7/10 月中下旬,其余周 submissions 一比对就 no-op。
 *
 * 流程:submissions(几百 KB)比 filed → 有新 10-Q/10-K 才拉 companyfacts(几 MB)
 *      → 归一化成单季行落 sec_fundamentals → 派生 TTM 三条 + 合计 FCF 写 market_series。
 *
 * 直接运行:bun run src/server/jobs/secFundamentals.ts [--force] [TICKER...]
 */

type Fetcher = ReturnType<typeof createSecFetcher>;

const SEC_SERIES_PREFIX = 'SEC_';
const SEC_SERIES_PREFIX_ESCAPED = 'SEC\\_'; // LIKE 的 `_` 是通配符,转义后才是字面下划线
const key = (r: MarketSeriesRow) => `${r.seriesId}@${r.obsDate}=${r.value}`;

/**
 * 按**当前启用名单**整体重算派生量,和库里现有的 `SEC_*` 比对:一致就一行都不写。
 *
 * 为什么不是「只算本轮抓到的那几家」:合计线的口径随名单变化(多一家 = 每个点都变),而名单变更
 * 恰恰发生在「手动单跑核对 → 通过 → 加进 SEC_ACTIVE_TICKERS」之后的那一轮 —— 那一轮所有公司都会
 * 因为没有新申报而 skip。若重算挂在「有抓到东西」上,合计线会停在旧名单口径,最长等三个月才自愈。
 *
 * 为什么用「算完比对」而不是无条件重写:算是纯本地计算(微秒级),写才是副作用。比对相同就跳过,
 * 既保证名单变更能自愈,又让没有变化的那几周真的是 no-op。
 *
 * 删而不是只 upsert:名单缩小或历史点减少时,旧点会残留成一条口径不一的线,upsert 清不掉。
 */
function writeDerived(db: Database): number {
  // 名单取「启用且库里真有数据」的——刚加进 SEC_ACTIVE_TICKERS 还没抓的那家不该把合计清空。
  const derived = SEC_ACTIVE_TICKERS.map((t) => [t, getSecFundamentals(db, t)] as const)
    .filter(([, rows]) => rows.length > 0)
    .map(([ticker, rows]) => [ticker, deriveSeries(rows)] as const);

  const perTicker: MarketSeriesRow[] = derived.flatMap(([ticker, { gmTtm, capexTtm, fcfTtm }]) => {
    const asRows = (kind: 'GM' | 'CAPEX' | 'FCF', points: QuarterPoint[]) =>
      points.map((p) => ({ seriesId: seriesId(ticker, kind), obsDate: p.date, value: p.value }));

    return [...asRows('GM', gmTtm), ...asRows('CAPEX', capexTtm), ...asRows('FCF', fcfTtm)];
  });

  const aggregate = aggregateFcf(new Map(derived.map(([t, d]) => [t, d.fcfTtm])));
  const desired = [
    ...perTicker,
    ...aggregate.map((p) => ({ seriesId: AICHAIN_FCF_SERIES, obsDate: p.date, value: p.value })),
  ];

  const stored = getMarketSeriesByPrefix(db, SEC_SERIES_PREFIX);
  const same =
    stored.length === desired.length &&
    new Set(stored.map(key)).symmetricDifference(new Set(desired.map(key))).size === 0;
  if (same) return 0;

  // 删 + 写同一事务:中途崩掉会让整族序列空着,而下一轮比对又会以为「库里就是这样」。
  // LIKE 里的 `_` 是单字符通配符,必须转义——否则这条 DELETE 会匹配「SEC + 任意一字符」开头的序列。
  db.transaction(() => {
    db.run(`DELETE FROM market_series WHERE series_id LIKE ? ESCAPE '\\'`, [`${SEC_SERIES_PREFIX_ESCAPED}%`]);
    insertMarketSeries(db, desired);
  })();

  return desired.length;
}

export async function updateSecFundamentals(
  db: Database,
  opts: { tickers?: string[]; force?: boolean; fetcher?: Fetcher } = {},
): Promise<{ fetched: string[]; skipped: string[]; failed: string[]; rowsWritten: number; seriesWritten: number }> {
  const tickers = opts.tickers ?? SEC_ACTIVE_TICKERS;
  const sec = opts.fetcher ?? createSecFetcher();

  // 名单打错字要立刻炸,不能静默跳过——这是配置错误,不是数据源故障。
  const unknown = tickers.filter((t) => !cikOf(t));
  if (unknown.length) throw new Error(`unknown SEC ticker: ${unknown.join(', ')}`);

  const fetched: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];
  let rowsWritten = 0;

  // 逐家串行:SEC 限速 10 req/s,且 companyfacts 有几 MB,并发没意义。
  // 单家失败只记 failed 继续跑下一家 —— 一家网络抖动不该让其余公司整轮不更新。
  for (const ticker of tickers) {
    try {
      const remoteFiled = await sec.latestFiledDate(cikOf(ticker)!);
      // remoteFiled 为 null = 拿不到定期报告申报日 → 无法确认有新申报,不去拉几 MB 的 companyfacts。
      const localFiled = getLatestSecFiled(db, ticker);
      if (!opts.force && (!remoteFiled || (localFiled && remoteFiled <= localFiled))) {
        skipped.push(ticker);
        continue;
      }

      const rows = extractFundamentals(ticker, await sec.companyFacts(cikOf(ticker)!));

      // 拉到了却解析出 0 行 = 这家的 tag 全在四条链之外。此时 getLatestSecFiled 永远是 null,
      // 水位不前进 → 每周都会重新白拉几 MB。记 failed 让它浮出来,别冒充 success。
      if (rows.length === 0) {
        failed.push(`${ticker}: companyfacts 解析出 0 行(tag 链没覆盖到这家,需补 TAG_CHAINS)`);
        continue;
      }

      insertSecFundamentals(db, rows);

      fetched.push(ticker);
      rowsWritten += rows.length;
    } catch (e) {
      failed.push(`${ticker}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 无条件重算但只在结果有变化时才写(见 writeDerived):没变化的那几周仍是零写入。
  return { fetched, skipped, failed, rowsWritten, seriesWritten: writeDerived(db) };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const tickers = args.filter((a) => !a.startsWith('--'));

  const db = openDb();
  migrate(db);
  const runId = startJobRun(db, 'sec_fundamentals');

  try {
    const r = await updateSecFundamentals(db, { force, tickers: tickers.length ? tickers : undefined });

    // records_written 记「实际写进库的总行数」= 原始单季行 + 派生序列点。
    // 状态:**「正确地跳过」算成功**——多数周本就该全 skip。只有「一家都没跑通」(fetched 与
    // skipped 双空,如 UA 没配导致每家都抛)才报红;其余有失败的情况记 partial 黄灯。
    const recordsWritten = r.rowsWritten + r.seriesWritten;
    const error = r.failed.join('; ');
    const nothingWorked = r.fetched.length === 0 && r.skipped.length === 0;
    finishJobRun(
      db,
      runId,
      r.failed.length === 0
        ? { status: 'success', recordsWritten }
        : nothingWorked
          ? { status: 'failed', error, recordsWritten }
          : { status: 'partial', recordsWritten, error },
    );
    console.log(
      `SEC fundamentals: fetched=[${r.fetched}] skipped=[${r.skipped}] failed=[${r.failed}] rows=${r.rowsWritten} series=${r.seriesWritten}`,
    );
  } catch (e) {
    finishJobRun(db, runId, { status: 'failed', error: String(e) });
    throw e;
  } finally {
    db.close();
  }
}
