import type { Database } from 'bun:sqlite';
import { openDb, migrate } from '../storage/db';
import { insertMarketSeries, getMarketSeries } from '../storage/repository';
import { fetchJsdaJgbi, fetchBbBei, type JsdaJgbiDay } from '../fetchers/jsdaJgbi';
import { fetchJpHolidays } from '../fetchers/jpHolidays';
import { jgbiCompoundYield } from '../analytics/jgbiYield';
import {
  addDays,
  isJpBusinessDay,
  jpBusinessDaysBetween,
  nextJpBusinessDay,
  prevJpBusinessDay,
} from '../analytics/jpCalendar';

/**
 * 日本 10 年期实际利率 + BEI(日度)→ market_series 三条,按**报价日**幂等 upsert:
 *   实际 = 最新一回物価連動国債(JGBi)的复利收益率(由 JSDA 实际价格倒推,见 analytics/jgbiYield)
 *   名义 = 与它同到期年月的 10 年利付国债(现为 #382)的复利收益率(JSDA 直接给)
 *   BEI  = 名义 − 实际
 * 口径与日本相互证券 BB「BEIの推移」/ 财务省 BEI 资料一致(实测逐位相同)。
 *
 * 为什么落库:JSDA 一天一个文件、还限流(连续请求即 429),一条历史拉不动。
 * 历史一次性从 BB 回填(`--backfill-bb`,2024-04-01 起,BB 按月更新),之后 daily 每轮**只打一次** JSDA:
 * 最近 WINDOW_DAYS 天里库里缺的报价日取最新的一天去拉,其余留给下一个触发点(组记 partial,守卫会让它再跑)。
 * daily 只在周二~周六触发:周二~周五的报价当晚(20 点)入库,周一的要等周二上午(接受,不单独加触发点)。
 */
export const JGBI_SERIES = { real: 'JP_REAL10', nominal: 'JP_NOM10_JGBI', bei: 'JP_BEI10' } as const;

const WINDOW_DAYS = 30;
/** JSDA 约 17:30~18:30 JST 挂出当天报价,19 点后才算「今天的该有了」 */
const POSTED_HOUR_JST = 19;
/** 落后应有报价日 ≥ 3 个营业日 = 停更(平时 0~1 个) */
const STALE_LAG = 3;
const JST_MS = 9 * 3_600_000;

function jstNow(now: Date): { date: string; hour: number } {
  const t = new Date(now.getTime() + JST_MS);
  return { date: t.toISOString().slice(0, 10), hour: t.getUTCHours() };
}

/** 现在按理应该有的最新报价日 */
export function expectedQuoteDate(now: Date, holidays: ReadonlySet<string>): string {
  const { date, hour } = jstNow(now);
  return isJpBusinessDay(date, holidays) && hour >= POSTED_HOUR_JST ? date : prevJpBusinessDay(date, holidays);
}

export function staleProblem(
  latest: string | undefined,
  expected: string,
  holidays: ReadonlySet<string>,
): string | null {
  if (!latest) return '库里一个点都没有(先跑 bun run src/server/jobs/jgbiSnapshot.ts --backfill-bb)';
  const lag = jpBusinessDaysBetween(addDays(latest, 1), expected, holidays).length;
  return lag >= STALE_LAG ? `最新 ${latest} 落后应有报价日 ${expected} ${lag} 个营业日(JSDA 版式或限流?)` : null;
}

/** 一天的 JSDA 读数 → 三条序列的行(JGBi 当天没公表价格时只写名义) */
export function rowsOf(quoteDate: string, day: JsdaJgbiDay) {
  const nominal = { seriesId: JGBI_SERIES.nominal, obsDate: quoteDate, value: day.nominal.yield };
  if (day.jgbi.price === null) return [nominal];

  const real =
    Math.round(jgbiCompoundYield(day.jgbi.price, day.jgbi.coupon, day.settle, day.jgbi.maturity) * 1000) / 1000;
  return [
    nominal,
    { seriesId: JGBI_SERIES.real, obsDate: quoteDate, value: real },
    { seriesId: JGBI_SERIES.bei, obsDate: quoteDate, value: Math.round((day.nominal.yield - real) * 1000) / 1000 },
  ];
}

export type JgbiResult = {
  /** 这一轮拉到的报价日 */
  fetched: string | null;
  failed: string | null;
  /** 这一轮之后窗口里还缺的报价日 */
  missing: string[];
  stale: string | null;
  latest: string | null;
};

export async function updateJgbi(
  db: Database,
  opts: { now?: Date; holidays?: ReadonlySet<string>; fetchDay?: typeof fetchJsdaJgbi } = {},
): Promise<JgbiResult> {
  const now = opts.now ?? new Date();
  const holidays = opts.holidays ?? (await fetchJpHolidays(Number(jstNow(now).date.slice(0, 4))));
  const fetchDay = opts.fetchDay ?? fetchJsdaJgbi;
  const expected = expectedQuoteDate(now, holidays);

  // 名义腿每天都有(JGBi 偶尔不公表价格),用它判断「这天拉过没有」
  const have = () => new Set(getMarketSeries(db, JGBI_SERIES.nominal).map((p) => p.date));
  const window = jpBusinessDaysBetween(addDays(expected, -WINDOW_DAYS), expected, holidays);
  const target = window.filter((d) => !have().has(d)).at(-1);

  let fetched: string | null = null;
  let failed: string | null = null;
  if (target) {
    const settle = nextJpBusinessDay(target, holidays);
    try {
      const day = await fetchDay(settle);
      if (day && day.settle !== settle) throw new Error(`文件日期 ${day.settle} 与请求的 ${settle} 不符`);
      if (day) {
        insertMarketSeries(db, rowsOf(target, day));
        fetched = target;
      } else failed = `${target}: JSDA 文件 ${settle} 还没挂出(404)`;
    } catch (err) {
      failed = `${target}: ${(err as Error).message}`;
    }
  }

  const stored = have();
  const latest = [...stored].sort().at(-1) ?? null;
  return {
    fetched,
    failed,
    missing: window.filter((d) => !stored.has(d)),
    stale: staleProblem(latest ?? undefined, expected, holidays),
    latest,
  };
}

/** BB 回填:三条全量 upsert(BB 是财务省口径的官方数,覆盖 JSDA 自算的同一天也无妨) */
export async function backfillFromBb(db: Database, fetchBb = fetchBbBei): Promise<number> {
  const rows = (await fetchBb()).flatMap((r) => [
    { seriesId: JGBI_SERIES.real, obsDate: r.date, value: r.real },
    { seriesId: JGBI_SERIES.nominal, obsDate: r.date, value: r.nominal },
    { seriesId: JGBI_SERIES.bei, obsDate: r.date, value: r.bei },
  ]);
  insertMarketSeries(db, rows);
  return rows.length / 3;
}

// CLI:bun run src/server/jobs/jgbiSnapshot.ts [--backfill-bb]
if (import.meta.main) {
  const db = openDb();
  migrate(db);
  if (process.argv.includes('--backfill-bb')) {
    console.log(`BB 回填 ${await backfillFromBb(db)} 天`);
  } else {
    const r = await updateJgbi(db);
    console.log(
      `拉到 ${r.fetched ?? '无'},最新 ${r.latest};窗口里还缺 ${r.missing.length} 天${r.failed ? `;失败:${r.failed}` : ''}`,
    );
    if (r.stale) console.log(`  停更:${r.stale}`);
  }
  db.close();
}
