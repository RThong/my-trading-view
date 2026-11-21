import type { Database } from 'bun:sqlite';
import { openDb, migrate } from '../storage/db';
import { getMarketSeries, insertMarketSeries } from '../storage/repository';
import {
  fetchMarketsDiary,
  parseMarketsDiary,
  type DiaryExchange,
  type MarketsDiary,
} from '../fetchers/wsjMarketsDiary';
import { readArchived, type ArchiveRun } from '../fetchers/snapshotArchive';
import { lastClosedTradingDate, nyParts } from '../analytics/tradingCalendar';
import { weekdaysBetween } from './putCallSnapshot';

/**
 * WSJ 市场日志(NYSE / NASDAQ 涨跌家数、新高新低、涨跌成交量)→ market_series,每个字段一条。
 * 源只给当天、补不了历史:漏一天就永久缺一天,涨跌线(读时累加,见 routes/regimeDb)从此差那一天的净差。
 * 所以拿不到收盘那份 → failed,当天后续触发点重跑(守卫按组判)。
 *
 * 停更防护(同 put_call):源卡在旧的一天时照样回 200、时间戳不动,只看「是不是收盘那份」会天天记 success。
 * 落后上一收盘日 → lagging(daily 记 partial 黄灯、后续触发点重跑);落后超过 MAX_LAG_WEEKDAYS → stale(failed 红灯)。
 * 不一落后就红灯:lastClosedTradingDate 不认交易所假日,假日那天恒判落后一天。
 */

const FIELD_ID: Record<keyof DiaryExchange, string> = {
  adv: 'ADV',
  dec: 'DEC',
  unch: 'UNCH',
  newHighs: 'NEW_HIGH',
  newLows: 'NEW_LOW',
  advVol: 'ADV_VOL',
  decVol: 'DEC_VOL',
};

function breadthSeriesId(exchange: 'NYSE' | 'NASDAQ', field: keyof DiaryExchange) {
  return `WSJ_${exchange}_${FIELD_ID[field]}`;
}

/** 取 17 不取 16:同 MOVE(jobs/moveSnapshot 的 CLOSE_HOUR_ET),WSJ 收盘那份 16:15 才出,多等一小时零代价 */
const CLOSE_HOUR_ET = 17;

/** 这份是不是已收盘的:时间戳的日子已过去,或现在已过 17 点(判**现在**,半日市不构成特例,见 moveSnapshot 的 isCloseSnapshot) */
export function isClosedDiary(date: string, now = new Date()): boolean {
  const current = nyParts(now);
  // 晚于美东今天的日期是源出错,当不是收盘那份(不写库,daily 记 failed)
  return date < current.date || (date === current.date && current.hour >= CLOSE_HOUR_ET);
}

function rowsOf(d: MarketsDiary) {
  return (['NYSE', 'NASDAQ'] as const).flatMap((ex) => {
    const values = ex === 'NYSE' ? d.nyse : d.nasdaq;
    return (Object.keys(FIELD_ID) as (keyof DiaryExchange)[]).map((f) => ({
      seriesId: breadthSeriesId(ex, f),
      obsDate: d.date,
      value: values[f],
    }));
  });
}

/** 连休(感恩节 / 圣诞 + 周末)加临时休市最多 3 个工作日,超过 5 个就是断了(同 putCallSnapshot 的 MAX_MISSING_WEEKDAYS) */
const MAX_LAG_WEEKDAYS = 5;

export type BreadthResult = { date: string; written: number; lagging: boolean; stale: string | null };

/** 源的日期落后上一收盘日几个工作日 → lagging / stale */
export function lagOf(date: string, lastClosed: string): Pick<BreadthResult, 'lagging' | 'stale'> {
  const lag = weekdaysBetween(date, lastClosed).length - 1;

  return {
    lagging: lag > 0,
    stale:
      lag > MAX_LAG_WEEKDAYS
        ? `WSJ 市场日志停在 ${date},落后上一收盘日 ${lastClosed} ${lag} 个工作日(源可能停更或改版)`
        : null,
  };
}

/** 拉一次、是收盘那份就写;盘中那份抛错(daily 记 failed、后续触发点重跑) */
export async function updateBreadth(
  db: Database,
  opts: { fetch?: typeof fetchMarketsDiary; now?: Date } = {},
): Promise<BreadthResult> {
  const diary = await (opts.fetch ?? fetchMarketsDiary)();
  if (!isClosedDiary(diary.date, opts.now)) throw new Error(`WSJ 市场日志还是 ${diary.date} 盘中的值,不落库`);

  const rows = rowsOf(diary);
  insertMarketSeries(db, rows);

  return { date: diary.date, written: rows.length, ...lagOf(diary.date, lastClosedTradingDate(opts.now)) };
}

/** Actions 存档里的文件名(market-snapshots 的 fetch.sh) */
const ARCHIVE_NAME = 'wsj-diary';

/**
 * 把 Actions 存档(见 fetchers/snapshotArchive)里的 WSJ 市场日志补进库:本机关机 / 没网的那几天靠它。
 * 收盘与否按**抓取时刻**判(同 MOVE 的 ingestArchivedMove),盘中那份不写。轮次升序,同一天后抓的覆盖先抓的。
 * **只补库里还没有的日子**:存档在美东 17:07 抓,本机 21 点后那份更晚、更接近定型值(收盘后头几个小时值还会变),
 * 而存档每轮都整批重放 14 天 —— 不跳过的话,次日那轮会把本机抓的改回存档那份。返回写入行数。
 */
export function ingestArchivedBreadth(db: Database, runs: ArchiveRun[]): number {
  const have = new Set(getMarketSeries(db, breadthSeriesId('NYSE', 'adv')).map((p) => p.date));
  const rows = runs.flatMap((run) => {
    if (!run.names.has(ARCHIVE_NAME)) return [];
    // 一份坏文件只跳过它,不挡后面的轮次
    try {
      const diary = parseMarketsDiary(JSON.parse(readArchived(run, ARCHIVE_NAME)));
      return isClosedDiary(diary.date, run.fetchedAt) && !have.has(diary.date) ? rowsOf(diary) : [];
    } catch (err) {
      console.warn(`WSJ 市场日志存档 ${run.dir} 读取失败,跳过:${(err as Error).message}`);
      return [];
    }
  });
  if (rows.length) insertMarketSeries(db, rows);

  return rows.length;
}

// CLI:bun run src/server/jobs/breadthSnapshot.ts
if (import.meta.main) {
  const db = openDb();
  migrate(db);
  const r = await updateBreadth(db);
  console.log(`写入 ${r.written} 行(${r.date})${r.stale ?? (r.lagging ? ',落后上一收盘日' : '')}`);
  db.close();
}
