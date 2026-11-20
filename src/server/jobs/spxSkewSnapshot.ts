import type { Database } from 'bun:sqlite';
import { openDb, migrate } from '../storage/db';
import { insertMarketSeries, getMarketSeries } from '../storage/repository';
import { fetchSpx25Pair, NotTradingDayError, SPX_DECOMP_MIN_DATE, type Spx25 } from '../fetchers/cboeVixDecomp';
import { lastClosedTradingDate } from '../analytics/tradingCalendar';
import { nearestKnown, orderPair, planPairs } from '../analytics/tradingDayPairs';
import { staleProblems, weekdaysBetween } from './putCallSnapshot';

/**
 * SPX 30 天恒定期限 25Δ(put IV / call IV / skew,百分数)→ market_series 三条。源见 fetchers/cboeVixDecomp。
 *
 * 为什么落库:源一次只给两天、每次要算约 13 秒(Cboe 服务端现算),一条历史要几百次请求;且同属无文档接口,
 * 哪天被拦(同 delayed_quotes 2026-11-19)库里的历史还在。
 * 回填一次(`--backfill`,从 2022-09-01 起约 800 个交易日,两天一请求、3 并发约 25 分钟),之后 daily 补最近
 * MAX_GAP_DAYS 天里库里缺的工作日(同 put_call)。当天的要到美东次日凌晨才有,所以库里常比上一收盘日晚一天,是常态。
 *
 * 请求怎么配对(见 analytics/tradingDayPairs):源要求两天都是交易日,不认假日的我们不知道哪天休市 —— 先把缺的天两两配对拉;
 * 某对报「有非交易日」、或两天都缺却没拿全,再把这对里没拿到的天各配库里离它最近的已知交易日单独问一次,
 * 还报「非交易日」就是假日、跳过。
 */

export const SPX_SKEW_SERIES: Record<keyof Spx25, string> = {
  putIv: 'CBOE_SPX30_PUT25',
  callIv: 'CBOE_SPX30_CALL25',
  skew: 'CBOE_SPX30_SKEW25',
};

export type SpxSkewResult = {
  written: number;
  fetched: string[];
  failed: string[];
  stale: string[];
  latest: string | null;
};

const SCRIPT = 'src/server/jobs/spxSkewSnapshot.ts';
const MAX_GAP_DAYS = 30;
const DAY_MS = 86_400_000;

type FetchPair = typeof fetchSpx25Pair;

function addDays(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function rowsOf(date: string, v: Spx25) {
  return (Object.keys(SPX_SKEW_SERIES) as (keyof Spx25)[]).map((k) => ({
    seriesId: SPX_SKEW_SERIES[k],
    obsDate: date,
    value: Math.round(v[k] * 10000) / 10000,
  }));
}

export async function updateSpxSkew(
  db: Database,
  opts: { backfill?: boolean; fetchPair?: FetchPair; politeMs?: number; until?: string } = {},
): Promise<SpxSkewResult> {
  const fetchPair = opts.fetchPair ?? fetchSpx25Pair;
  // 一次约 13 秒:回填几百次时 3 个一组并发;日常只一两次
  const concurrency = opts.backfill ? 3 : 1;
  const politeMs = opts.politeMs ?? 300;
  const until = opts.until ?? lastClosedTradingDate();
  const storedDates = () => getMarketSeries(db, SPX_SKEW_SERIES.skew).map((p) => p.date);
  const have = new Set(storedDates());
  const floor = opts.backfill ? SPX_DECOMP_MIN_DATE : addDays(until, -MAX_GAP_DAYS);
  const todo = weekdaysBetween(floor, until).filter((d) => !have.has(d));

  const fetched: string[] = [];
  const failed: string[] = [];
  const retryDays: string[] = [];

  // 拉一批对子,拿到就写(中途断了已拉到的不丢);要第二轮单独再问的天交给 onRetry
  const runPairs = async (pairs: [string, string][], onRetry: (days: string[]) => void) => {
    const batches = Array.from({ length: Math.ceil(pairs.length / concurrency) }, (_, i) =>
      pairs.slice(i * concurrency, (i + 1) * concurrency),
    );
    for (const batch of batches) {
      const results = await Promise.allSettled(batch.map(([a, b]) => fetchPair(a, b)));
      results.forEach((r, i) => {
        const pair = batch[i];
        if (r.status === 'fulfilled') {
          const fresh = [...r.value].filter(([d]) => todo.includes(d) && !fetched.includes(d));
          insertMarketSeries(
            db,
            fresh.flatMap(([d, v]) => rowsOf(d, v)),
          );
          fetched.push(...fresh.map(([d]) => d));
          // 两天都缺的对子只拿到一天或没拿到:源对整对回空(某天缺利率数据 / 未发布)会拖住另一天,
          // 不单独再问的话,下一轮同样配对、永远拿不到。最新一天本来就单独配已知日,不在此列
          const both = pair.every((d) => todo.includes(d));
          if (both) onRetry(pair.filter((d) => !r.value.has(d)));
        } else if (r.reason instanceof NotTradingDayError) onRetry(pair.filter((d) => todo.includes(d)));
        else failed.push(`${pair.join(' ~ ')}: ${(r.reason as Error).message}`);
      });
      if (politeMs) await sleep(politeMs);
    }
  };

  await runPairs(planPairs(todo, [...have]), (days) => {
    retryDays.push(...days);
  });

  // 第二轮:每天配库里最近的已知交易日。还报「非交易日」= 它就是假日;还回空 = 源那天确实没数。都不算失败
  const known = storedDates();
  const retry = retryDays
    .filter((d) => !fetched.includes(d))
    .flatMap((d) => {
      const k = nearestKnown(d, known);
      return k ? [orderPair(d, k)] : [];
    });
  await runPairs(retry, () => {});

  const stored = storedDates();
  return {
    written: fetched.length * 3,
    fetched,
    failed,
    stale: staleProblems(stored, until, SCRIPT),
    latest: stored.at(-1) ?? null,
  };
}

// CLI:bun run src/server/jobs/spxSkewSnapshot.ts [--backfill]
if (import.meta.main) {
  const db = openDb();
  migrate(db);
  const r = await updateSpxSkew(db, { backfill: process.argv.includes('--backfill') });
  console.log(`写入 ${r.written} 行(${r.fetched.length} 天),最新 ${r.latest};失败 ${r.failed.length} 对`);
  r.stale.forEach((s) => {
    console.log(`  停更 / 断档:${s}`);
  });
  r.failed.slice(0, 10).forEach((f) => {
    console.log(`  ${f}`);
  });
  db.close();
}
