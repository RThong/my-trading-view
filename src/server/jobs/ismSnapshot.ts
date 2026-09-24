import type { Database } from 'bun:sqlite';
import { openDb, migrate } from '../storage/db';
import { insertMarketSeries, getMarketSeries } from '../storage/repository';
import { createIsmFetcher, type IsmRelease, type IsmSector } from '../fetchers/ismPrn';
import { HISTORY_START_DATE } from '../config';

/**
 * ISM 制造业 / 服务业 PMI + 各自 Prices 分项 → market_series 四条(月频,`YYYY-MM-01`)。
 *
 * 为什么落库而不是像 EIA 那样现拉:PRN 一篇只带当月 + 上月两个点,拼一条历史要拉上百篇,
 * 不可能每次请求重来。所以回填一次(`--backfill`),之后 daily 增量。
 *
 * 增量的跳过判据:新版 slug 自带「扇区 + 报告月」(`…-august-2026-ism-…`),库里已有那个月
 * 就不拉正文 —— 稳态下每次只打一次列表页。
 *
 * ⚠️ **按报告月升序写入,同月后到的覆盖先到的**:每篇都带上月值,而 ISM 每年 1 月重估季节因子,
 * 2 月那篇里的「12 月」就是修订后的值。升序 upsert = 每个月留下最后一次被发布的读数。
 * 但更早的月份不会被回头改 —— 回填出来的是「每月的准初值」拼接,不是 ISM 官方的修订后全序列。
 * 读水平与方向够用,精确回测不够。
 */

export const ISM_SERIES: Record<IsmSector, { pmi: string; prices: string }> = {
  mfg: { pmi: 'ISM_MFG_PMI', prices: 'ISM_MFG_PRICES' },
  svc: { pmi: 'ISM_SVC_PMI', prices: 'ISM_SVC_PRICES' },
};

/** `failed` = 这一轮的抓取 / 解析失败;`stale` = 库里某扇区停更。分开是因为严重度不同(见 daily 的 ism 分组)。 */
export type IsmResult = { fetched: string[]; skipped: number; failed: string[]; stale: string[]; written: number };

/**
 * 每个扇区最新报告月允许落后当前月多少个月。**2 = 月报正常节奏的上限**:
 * 9 月的数 10 月初才发(制造业第 1 个工作日、服务业第 3 个),所以 10 月 1~5 日之间最新仍是 8 月
 * (落后 2 个月)是正常的;落后 3 个月就说明整整一期没进来。
 */
const MAX_LAG_MONTHS = 2;

/**
 * 单扇区停更检查:两个扇区**各自**的最新报告月够不够新。
 *
 * 为什么不是「第一页每个扇区至少一个候选」:列表页一页约等于一年的月报,某个扇区改名以后,
 * 旧名字的月报还会在第一页挂一年 —— 那个条件一年内都满足,挡不住。2020-07 服务业从 NMI 改名、
 * 制造业没改,就是这种「一边断、另一边照常」的真实先例。
 * 看库里的结果不看原因,改名 / PRN 停发 / 认不出版式都能抓到;代价是最晚约一个月后才报。
 */
export function staleSectors(latest: Record<IsmSector, string | null>, now: Date): string[] {
  const floor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - MAX_LAG_MONTHS, 1))
    .toISOString()
    .slice(0, 10);

  return (Object.entries(latest) as [IsmSector, string | null][])
    .filter(([, month]) => !month || month < floor)
    .map(([sector, month]) =>
      month
        ? `${sector} 最新报告月 ${month.slice(0, 7)} 落后超过 ${MAX_LAG_MONTHS} 个月(slug 可能改名 / PRN 停发 / 版式变了)`
        : `${sector} 库里一个点都没有(先跑 bun run src/server/jobs/ismSnapshot.ts --backfill)`,
    );
}

type Fetcher = ReturnType<typeof createIsmFetcher>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 发布件 → 四行(上月在前、当月在后;调用方已按报告月升序排好)。 */
const rowsOf = (r: IsmRelease) =>
  [
    { month: r.prevMonth, v: r.pmi.prev, id: ISM_SERIES[r.sector].pmi },
    { month: r.prevMonth, v: r.prices.prev, id: ISM_SERIES[r.sector].prices },
    { month: r.month, v: r.pmi.cur, id: ISM_SERIES[r.sector].pmi },
    { month: r.month, v: r.prices.cur, id: ISM_SERIES[r.sector].prices },
  ]
    .filter((x) => x.month >= HISTORY_START_DATE)
    .map((x) => ({ seriesId: x.id, obsDate: x.month, value: x.v }));

export async function updateIsm(
  db: Database,
  opts: { backfill?: boolean; fetcher?: Fetcher; politeMs?: number; now?: Date } = {},
): Promise<IsmResult> {
  const fetcher = opts.fetcher ?? createIsmFetcher();
  // 回填要翻很多页、拉几百篇:每篇之间停一下,别对着一个新闻站连发。
  const politeMs = opts.politeMs ?? (opts.backfill ? 300 : 0);
  const pageSize = opts.backfill ? 100 : 25;

  const have: Record<IsmSector, Set<string>> = {
    mfg: new Set(getMarketSeries(db, ISM_SERIES.mfg.pmi).map((p) => p.date)),
    svc: new Set(getMarketSeries(db, ISM_SERIES.svc.pmi).map((p) => p.date)),
  };

  const releases: IsmRelease[] = [];
  const fetched: string[] = [];
  const failed: string[] = [];
  let skipped = 0;

  // 回填:一页页往回翻,直到某页出现了展示起点之前的月报(再往后都是更老的)或翻空。增量:只看第一页。
  // 翻页有提前 break 的条件,用命令式循环比声明式直白。
  for (let page = 1; ; page++) {
    const candidates = await fetcher.listReleases(page, pageSize);
    // 第一页就一篇月报都认不出来 = slug 命名变了(或列表页结构变了),而不是「没有新数」。
    // 不在这里报红的话,job 会天天 success、面板永远停在最后一个月,没人知道。
    if (page === 1 && candidates.length === 0) throw new Error('PRN 列表页一篇月报都没认出来(slug 命名可能变了)');

    const todo = candidates.filter((c) => !(c.hint && have[c.hint.sector].has(c.hint.month)));
    skipped += candidates.length - todo.length;

    let reachedStart = false;
    for (const c of todo) {
      try {
        const r = await fetcher.fetchRelease(c.path);
        if (!r) {
          failed.push(`解析不出 AT A GLANCE 表(源结构可能变了):${c.path}`);
        } else {
          releases.push(r);
          fetched.push(`${r.sector}:${r.month.slice(0, 7)}`);
          // 列表按发布时间新 → 旧:第一篇早于起点的出现后,本页剩下的只会更老,立即停,不再拉正文。
          // (起点月自己的「最后读数」来自次月那篇,那篇比它新、早已拉过,所以停在这里不丢数。)
          if (r.month < HISTORY_START_DATE) reachedStart = true;
        }
      } catch (e) {
        failed.push(`${c.path}: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (reachedStart) break;
      if (politeMs) await sleep(politeMs);
    }

    if (!opts.backfill || reachedStart || candidates.length === 0) break;
  }

  // 按报告月升序;同扇区同月出现两篇(ISM 发更正件)时,releases 里先出现的是页面上更新的那篇,
  // 让它排在后面写 —— 后写者胜,才是「最后一次被发布的读数」。稳定排序默认会反过来。
  const rows = releases
    .map((r, i) => ({ r, i }))
    .sort((a, b) => a.r.month.localeCompare(b.r.month) || b.i - a.i)
    .flatMap(({ r }) => rowsOf(r));
  insertMarketSeries(db, rows);

  // 写完再查:这一轮刚补进来的月份也算数。
  const latestOf = (id: string) => getMarketSeries(db, id).at(-1)?.date ?? null;
  const stale = staleSectors(
    { mfg: latestOf(ISM_SERIES.mfg.pmi), svc: latestOf(ISM_SERIES.svc.pmi) },
    opts.now ?? new Date(),
  );

  return { fetched, skipped, failed, stale, written: rows.length };
}

// 直接运行:bun run src/server/jobs/ismSnapshot.ts [--backfill]
if (import.meta.main) {
  const db = openDb();
  migrate(db);
  try {
    const r = await updateIsm(db, { backfill: process.argv.includes('--backfill') });
    console.log(
      `ISM: fetched=${r.fetched.length} skipped=${r.skipped} written=${r.written} failed=[${r.failed.join('; ')}] stale=[${r.stale.join('; ')}]`,
    );
  } finally {
    db.close();
  }
}
