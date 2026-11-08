import type { Database } from 'bun:sqlite';
import { openDb, migrate } from '../storage/db';
import { insertMarketSeries, getMarketSeries } from '../storage/repository';
import { fetchPutCallDay, PUT_CALL_MIN_DATE, type PcVolume, type PutCallDay } from '../fetchers/cboePutCall';
import { lastClosedTradingDate } from './tradingCalendar';

/**
 * Cboe 认沽认购比(个股 / 指数 / 全部)→ market_series 三条(日频,值 = 认沽量 ÷ 认购量)。
 *
 * 为什么落库:源一次只给一天(`?dt=`),一条历史要拉上千次,不能每次请求重来。
 * 回填一次(`--backfill`,从源头最早的 2019-10-07 起,约 1800 个交易日;4 并发约二十分钟),之后 daily 补缺口:
 * 最近 MAX_GAP_DAYS 天里库里缺的工作日都拉一遍,所以哪天没拉到(源晚发布、网络失败,哪怕后面的天已经拉到了)
 * 下一轮自然补上。窗口外的缺口(停机超过 30 天、空库)不在 daily 里悄悄补,跑一次 `--backfill`。
 * 代价:窗口里的工作日假日(源返回 null、库里不会有)每轮都会再问一次,一年约 9 天、一次一个请求。
 */

export const PUT_CALL_SERIES: Record<keyof PutCallDay, string> = {
  equity: 'CBOE_PC_EQUITY',
  index: 'CBOE_PC_INDEX',
  total: 'CBOE_PC_TOTAL',
};

/** `stale` = 停更 / 断档(见 staleProblems),与这一轮的抓取失败 `failed` 分开:严重度不同 */
export type PutCallResult = {
  written: number;
  fetched: string[];
  failed: string[];
  stale: string[];
  latest: string | null;
};

const MAX_GAP_DAYS = 30;
/**
 * 允许连着几个工作日没数据:最长的正常空档是连休(感恩节 / 圣诞 + 周末)加临时休市,不超过 3 个工作日;
 * 超过 5 个就说明断了 —— 源改版后一直回「没数据」(载荷里留着 optionsData:null、数据改由前端取),
 * 或停机超过 30 天、窗口外留下缺口。两种都不会自愈,得改代码或跑 --backfill
 */
const MAX_MISSING_WEEKDAYS = 5;
const DAY_MS = 86_400_000;

function addDays(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** since ~ until(含)之间的工作日。只跳周末:假日页面返回 null,跳过即可,不必维护假日表 */
export function weekdaysBetween(since: string, until: string): string[] {
  const n = Math.round((Date.parse(until) - Date.parse(since)) / DAY_MS) + 1;
  return Array.from({ length: Math.max(0, n) }, (_, i) => addDays(since, i)).filter((d) => {
    const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
    return wd !== 0 && wd !== 6;
  });
}

/**
 * 停更 / 断档检查,看库里的结果不看原因(同 ISM 的 staleSectors):末尾落后上一收盘日、或中间两天之间
 * 隔了超过 MAX_MISSING_WEEKDAYS 个工作日,各报一条
 */
export function staleProblems(dates: string[], lastClosed: string): string[] {
  const latest = dates.at(-1);
  if (!latest) return ['库里一个点都没有(先跑 bun run src/server/jobs/putCallSnapshot.ts --backfill)'];

  const missing = (from: string, to: string) => weekdaysBetween(addDays(from, 1), addDays(to, -1)).length;
  const holes = dates
    .slice(1)
    .map((d, i) => [dates[i], d] as const)
    .filter(([a, b]) => missing(a, b) > MAX_MISSING_WEEKDAYS)
    .map(([a, b]) => `库里 ${a} ~ ${b} 之间断档(停机超过 30 天?跑 --backfill)`);
  const lag = weekdaysBetween(addDays(latest, 1), lastClosed).length;
  const tail =
    lag > MAX_MISSING_WEEKDAYS
      ? [`最新 ${latest} 落后上一收盘日 ${lastClosed} ${lag} 个工作日(源可能改版、一直回「没数据」)`]
      : [];

  return [...tail, ...holes];
}

function ratio(v: PcVolume): number {
  return Math.round((v.put / v.call) * 10000) / 10000;
}

function rowsOf(date: string, day: PutCallDay) {
  return (Object.keys(PUT_CALL_SERIES) as (keyof PutCallDay)[]).map((k) => ({
    seriesId: PUT_CALL_SERIES[k],
    obsDate: date,
    value: ratio(day[k]),
  }));
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 要拉哪些天:窗口(回填 = 源头最早一天起,日常 = 最近 MAX_GAP_DAYS 天)里库里还缺的工作日,新的在前
 *  (回填时最近几个月先到;中途断了再跑只补缺的) */
function datesToFetch(db: Database, until: string, backfill: boolean): string[] {
  const have = new Set(getMarketSeries(db, PUT_CALL_SERIES.equity).map((p) => p.date));
  const floor = backfill ? PUT_CALL_MIN_DATE : addDays(until, -MAX_GAP_DAYS);
  return weekdaysBetween(floor, until)
    .filter((d) => !have.has(d))
    .reverse();
}

export async function updatePutCall(
  db: Database,
  opts: { backfill?: boolean; fetchDay?: typeof fetchPutCallDay; politeMs?: number; until?: string } = {},
): Promise<PutCallResult> {
  const fetchDay = opts.fetchDay ?? fetchPutCallDay;
  // 一页约 450KB、要 ~3 秒:回填上千天时 4 个一组并发(否则要一个多小时),组与组之间停一下;日常只几天,一个个来
  const concurrency = opts.backfill ? 4 : 1;
  const politeMs = opts.politeMs ?? 250;
  const until = opts.until ?? lastClosedTradingDate();
  const dates = datesToFetch(db, until, !!opts.backfill);
  const batches = Array.from({ length: Math.ceil(dates.length / concurrency) }, (_, i) =>
    dates.slice(i * concurrency, (i + 1) * concurrency),
  );

  const fetched: string[] = [];
  const failed: string[] = [];
  let written = 0;
  // 每组拿到就写,中途断了已拉到的不丢
  for (const batch of batches) {
    const results = await Promise.allSettled(batch.map((d) => fetchDay(d)));
    results.forEach((r, i) => {
      const date = batch[i];
      if (r.status === 'rejected') failed.push(`${date}: ${(r.reason as Error).message}`);
      else if (r.value) {
        insertMarketSeries(db, rowsOf(date, r.value));
        fetched.push(date);
        written += 3;
      }
    });
    if (politeMs) await sleep(politeMs);
  }

  const stored = getMarketSeries(db, PUT_CALL_SERIES.equity).map((p) => p.date);
  return { written, fetched, failed, stale: staleProblems(stored, until), latest: stored.at(-1) ?? null };
}

// CLI:bun run src/server/jobs/putCallSnapshot.ts [--backfill]
if (import.meta.main) {
  const db = openDb();
  migrate(db);
  const r = await updatePutCall(db, { backfill: process.argv.includes('--backfill') });
  console.log(`写入 ${r.written} 行(${r.fetched.length} 天),最新 ${r.latest};失败 ${r.failed.length} 天`);
  r.stale.forEach((s) => {
    console.log(`  停更 / 断档:${s}`);
  });
  r.failed.slice(0, 10).forEach((f) => {
    console.log(`  ${f}`);
  });
  db.close();
}
