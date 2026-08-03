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
  BUYER_FCF_SERIES,
  CONCEPTS,
  type QuarterPoint,
} from '../analytics/secFundamentals';
import { SEC_ACTIVE_TICKERS, cikOf, isAggregateMember } from '../../shared/secCompanies';

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
function writeDerived(db: Database, active: string[], examine: string[]): { written: number; problems: string[] } {
  // 体检范围 = 启用名单 ∪ 本轮抓过的(单跑核对某家时它还没进启用名单,但那正是最该体检的时刻)。
  const all = [...new Set([...active, ...examine])].map((t) => [t, getSecFundamentals(db, t)] as const);

  // 派生只算启用且库里真有数据的那几家——刚加进名单还没抓的那家不该把合计清空。
  const loaded = all.filter(([t, rows]) => active.includes(t) && rows.length > 0);
  const derived = loaded.map(([ticker, rows]) => [ticker, deriveSeries(rows)] as const);

  const perTicker: MarketSeriesRow[] = derived.flatMap(([ticker, { gmTtm, capexTtm, fcfTtm }]) => {
    const asRows = (kind: 'GM' | 'CAPEX' | 'FCF', points: QuarterPoint[]) =>
      points.map((p) => ({ seriesId: seriesId(ticker, kind), obsDate: p.date, value: p.value }));

    return [...asRows('GM', gmTtm), ...asRows('CAPEX', capexTtm), ...asRows('FCF', fcfTtm)];
  });

  // ① 完整性体检:**每轮从库里查**,不挂在「这一轮有没有抓到东西」上。
  // 挂在抓取那一轮只会报一次 —— 行落库后水位前进,下周直接 skip,缺 revenue/cogs 的家从此
  // 永远没有毛利率线却再也没人提。放这里则每轮复发,直到 tag 链补好。
  // 体检对象 = 库里有数据的(启用名单里 ∪ 本轮单跑核对的那家)。「启用了但还没抓过」的 0 行是
  // 正常的、不报;而「拉到了却一行没落」在抓取处就被拦成 failed 了,到不了这里。
  //
  // 判据按**最新一期**而非全历史并集:某家若在新申报里把某科目换成链外 tag,老季度仍留在库里,
  // 按并集看四个科目全都「有过」→ 一条告警不报,而 TTM 因缺季不出新点、线静默停在旧日期。
  // 按最新一期看则立刻暴露。(rows 由 getSecFundamentals 按 period_end 升序返回。)
  const problems = all
    .filter(([, rows]) => rows.length > 0)
    .flatMap(([ticker, rows]) => {
      const latest = rows.at(-1)?.periodEnd;
      const present = new Set(rows.filter((r) => r.periodEnd === latest).map((r) => r.concept));
      const missing = CONCEPTS.filter((c) => !present.has(c));

      return missing.length
        ? [
            `${ticker}: 最新一期(${latest ?? '无数据'})缺科目 ${missing.join('/')} —— ` +
              '两种病因:① tag 链没覆盖到这家(可补 TAG_CHAINS);② 源本季根本没有这条行' +
              '(补不了,常见于早年 capex;裁剪规则已保证图上不画假斜率)。先去 sec_fundamentals 看 tag_used 再判。',
          ]
        : [];
    });

  // ② 合计 FCF **只汇总买方**(§6.14 判据线)。卖方在涨价周期里正 FCF 极大,混进来会让
  // 「跌破零轴」永远不成立。另:某家一个 FCF 点都出不来时把它排除并报出——aggregateFcf 要求
  // 每季每家都有点,一家全空会让整条线静默变空,而静默是这里唯一不可接受的行为。
  // 成员判据用 isAggregateMember(buyer 且在因果链内),不是光看 side ——
  // 目录里若有非链内的 buyer,光看 side 会让它静默把零轴垫高。
  const buyers = derived.filter(([t]) => isAggregateMember(t));
  problems.push(
    ...buyers
      .filter(([, d]) => d.fcfTtm.length === 0)
      .map(([t]) => `${t}: 一个 TTM FCF 点都算不出,已排除出买方合计线(检查 ocf/capex 的 tag)`),
  );

  const aggregate = aggregateFcf(new Map(buyers.filter(([, d]) => d.fcfTtm.length > 0).map(([t, d]) => [t, d.fcfTtm])));
  const desired = [
    ...perTicker,
    ...aggregate.map((p) => ({ seriesId: BUYER_FCF_SERIES, obsDate: p.date, value: p.value })),
  ];

  const stored = getMarketSeriesByPrefix(db, SEC_SERIES_PREFIX);
  const same =
    stored.length === desired.length &&
    new Set(stored.map(key)).symmetricDifference(new Set(desired.map(key))).size === 0;
  if (same) return { written: 0, problems };

  // 删 + 写同一事务:中途崩掉会让整族序列空着,而下一轮比对又会以为「库里就是这样」。
  // LIKE 里的 `_` 是单字符通配符,必须转义——否则这条 DELETE 会匹配「SEC + 任意一字符」开头的序列。
  db.transaction(() => {
    db.run(`DELETE FROM market_series WHERE series_id LIKE ? ESCAPE '\\'`, [`${SEC_SERIES_PREFIX_ESCAPED}%`]);
    insertMarketSeries(db, desired);
  })();

  return { written: desired.length, problems };
}

export async function updateSecFundamentals(
  db: Database,
  // activeTickers 只为测试留口(要验买/卖分侧就必须能换名单);CLI 不传,取 SEC_ACTIVE_TICKERS。
  opts: { tickers?: string[]; force?: boolean; fetcher?: Fetcher; activeTickers?: string[] } = {},
): Promise<{ fetched: string[]; skipped: string[]; failed: string[]; rowsWritten: number; seriesWritten: number }> {
  const active = opts.activeTickers ?? SEC_ACTIVE_TICKERS;
  const tickers = opts.tickers ?? active;
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
      // --force 跳过整段 filed 比对(连 submissions 都不打):它就是「不管水位,重拉一遍」的逃生口。
      let remoteFiled: string | null = null;
      if (!opts.force) {
        remoteFiled = await sec.latestFiledDate(cikOf(ticker)!);

        // 拿不到定期报告申报日 ≠ 正常跳过。大盘股必然有 10-Q/10-K,拿不到说明源出问题
        // (SEC 改了 filings.recent 结构 / 字段更名 / 响应降级)。若归入 skipped,每家都 null 时
        // 会变成「永远绿灯、永远零写入」的假绿。记 failed 但仍不拉几 MB。
        if (!remoteFiled) {
          failed.push(`${ticker}: submissions 里没有 10-Q/10-K 申报日(源结构可能变了),未拉 companyfacts`);
          continue;
        }

        const localFiled = getLatestSecFiled(db, ticker);
        if (localFiled && remoteFiled <= localFiled) {
          skipped.push(ticker);
          continue;
        }
      }

      // 拿到的行一律落库(可审计)。科目完整性搬到 writeDerived 每轮从库里体检(那里才能复发),
      // 但**这一轮有没有拿到东西必须在这里判**:writeDerived 只看得见「库里最新一期」,
      // 而库里已有历史的那家若新申报一行都解析不出(四科目全换链外 tag / SEC 改了 facts 结构 /
      // 响应降级成空 JSON),最新一期仍是那条旧的、四科目齐全的期 → 体检一条不报 → 绿灯 +
      // 水位不前进 + 每周白拉几 MB。稳态下(库早就有数据)这是唯一会发生的形态。
      const rows = extractFundamentals(ticker, await sec.companyFacts(cikOf(ticker)!));
      insertSecFundamentals(db, rows);
      rowsWritten += rows.length;

      // 判据用「水位有没有推到远端 filed」而非 rows.length —— 后者盖不住「拉到了但新那一期没解析出来」。
      // remoteFiled 只在非 force 路径有(force 连 submissions 都不打),故 force 时退回 rows.length。
      const advanced = remoteFiled ? (getLatestSecFiled(db, ticker) ?? '') >= remoteFiled : rows.length > 0;
      if (!advanced) {
        failed.push(
          `${ticker}: companyfacts 没贡献任何新一期的行(远端 filed=${remoteFiled ?? '未查'});` +
            'tag 链或 SEC 响应结构可能变了,水位不会前进 → 下次仍会重拉',
        );
        continue;
      }

      fetched.push(ticker);
    } catch (e) {
      failed.push(`${ticker}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 无条件重算但只在结果有变化时才写(见 writeDerived):没变化的那几周仍是零写入。
  // 完整性问题每轮复发,并入 failed —— 有问题时 job 记 partial,状态灯不会绿。
  const { written, problems } = writeDerived(db, active, fetched);
  failed.push(...problems);

  return { fetched, skipped, failed, rowsWritten, seriesWritten: written };
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
    // 「一个数都没拿到」就该红:既包括每家都抛错(fetched/skipped 双空),也包括拉到了但
    // 全员解析出 0 行(rowsWritten 为 0)—— 后者是 tag 链全不命中,比网络挂了更需要人看。
    const nothingWorked =
      (r.fetched.length === 0 && r.skipped.length === 0) || (r.fetched.length > 0 && r.rowsWritten === 0);
    // nothingWorked 必须先判:放在 `failed.length === 0 ? success : …` 后面会被短路掉,
    // 「拉到了但一行没落」正是 failed 为空却该报红的情形。
    finishJobRun(
      db,
      runId,
      nothingWorked
        ? { status: 'failed', error: error || '一个数都没拿到(见日志)', recordsWritten }
        : r.failed.length
          ? { status: 'partial', recordsWritten, error }
          : { status: 'success', recordsWritten },
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
