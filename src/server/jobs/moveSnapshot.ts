import type { Database } from 'bun:sqlite';
import { openDb, migrate } from '../storage/db';
import { insertMarketSeries } from '../storage/repository';
import { fetchMoveSeries, type MetaPoint, type MovePoint } from '../fetchers/moveIndex';
import { HISTORY_START_DATE } from '../config';
import { nyParts } from './tradingCalendar';

type MoveFetch = { points: MovePoint[]; meta: MetaPoint | null };

export type MoveUpdateResult = {
  total: number;
  /** 本次落库的最新日期(不是库里最新)。 */
  latest: string | null;
  /** meta 快照点的日期;没拿到可用快照则为 null。 */
  metaDate: string | null;
  /** 是否拿到可落库的 meta 收盘快照 —— job 成败判据。 */
  gotMetaPoint: boolean;
  /** meta 日期已久未前进(疑似源冻结);只告警,不判失败。 */
  stalled: boolean;
};

/** 超过这么久还没前进就当源冻结。跨得过长周末 + 连休假日,又能在一周内发现真冻结。 */
const STALE_DAYS = 5;
const STALE_MS = STALE_DAYS * 24 * 3600 * 1000;

/**
 * 判的是**现在**几点,不是 meta 那一刻几点 —— 见 isCloseSnapshot。
 * 取 17 不取 16:MOVE 实际定盘 ~16:34 ET,16:00–16:34 之间跑会把未定盘值当收盘落库,
 * 而那个时刻(= JST 次日 05:0x)与同 JST 日 11:00 那次触发同属一天,守卫会跳过后者
 * → 断供期那格永久留未定盘值。所有真实触发点都在 ET ≥21 点,多等一小时零代价。
 */
const CLOSE_HOUR_ET = 17;

/**
 * meta 快照是否已收盘、可以落库。盘中值不能当收盘值写进去:断供期该日日线永远是 null、
 * 不会被真值 upsert 盖回,加上按设计没有删除路径,那一格就永久是个盘中数。
 *
 * 判据「meta 的 ET 日已翻篇,或现在已过 CLOSE_HOUR_ET」,两条都是对**当下**的判断,
 * 不看 meta 那一刻是几点 —— 所以半日市(感恩节次日 / 平安夜 / 7·3,股市 13:00、债市 14:00 收)
 * 不构成特例。若改成只看 meta 小时数,半日市会整天判 failed:白跑 5 次全量,那格还因为
 * 被过滤掉不落库、次日 meta 前进而变成永久空洞。
 *
 * 各触发点推演(launchd JST 11/12/20/21/22,见 scripts/gen-cron.sh):
 *   JST 11/12  = ET 前一日 21–23 点(随夏令时)→ 后半句成立 → 首次触发即成功
 *   JST 20/21/22 = ET 当日 06–09 点            → 前半句成立(meta 日已翻篇)
 *   盘中唤醒补跑,且 meta 是**当日**盘中值      → 两句都不成立 → 不落库,等当天后续触发补
 *   盘中唤醒补跑,但 meta 还是**前一交易日**收盘 → 前半句成立 → 照常落库(那是已收盘的值)
 */
export function isCloseSnapshot(at: number, now: number = Date.now()): boolean {
  const meta = nyParts(new Date(at));
  const current = nyParts(new Date(now));

  return meta.date < current.date || current.hour >= CLOSE_HOUR_ET;
}

/**
 * MOVE 债市波动率 → market_series 的 MOVE(整条序列的本地镜像)。
 * Yahoo 日线 close 断供期间靠 meta 收盘快照补一格;日线恢复后同日被真值 upsert 覆盖。
 * 幂等,同日重跑无副作用,没有删除路径。
 *
 * 成败看 gotMetaPoint:断供时历史 bars 仍有几千行,只看 total 会把「快照没拿到」误判成 success,
 * 当天就不再重试,那一格永久缺失。用 meta 有无、而不是比对交易日历,是因为假日 Yahoo 照样回
 * 上一交易日的 meta,拿日历比会整天误判失败、把整条 pipeline 重跑 5 次。
 *
 * stalled 是另一件事:meta 日期若长期不前进(源冻结),上面那条判据看不出来,故单独回报供告警。
 * 判据是「距今超过 STALE_DAYS 天」——不能跟库里最新比,那个值就是本 job 自己写的,同日重试必误报。
 *
 * 直接运行:bun run src/server/jobs/moveSnapshot.ts
 */
export async function updateMoveIndex(
  db: Database,
  fetchSeries: (since: Date) => Promise<MoveFetch> = fetchMoveSeries,
  now: number = Date.now(),
): Promise<MoveUpdateResult> {
  const { points, meta } = await fetchSeries(new Date(HISTORY_START_DATE));

  // 盘中快照不落库:剔掉它,只写日线那部分,让当天后续触发拿到收盘值再补。
  const closed = meta !== null && isCloseSnapshot(meta.at, now);
  const rows = closed ? points : points.filter((p) => p.date !== meta?.date);

  insertMarketSeries(
    db,
    rows.map((p) => ({ seriesId: 'MOVE', obsDate: p.date, value: p.value })),
  );

  return {
    total: rows.length,
    latest: rows.at(-1)?.date ?? null,
    metaDate: meta?.date ?? null,
    gotMetaPoint: closed,
    stalled: meta !== null && now - meta.at > STALE_MS,
  };
}

if (import.meta.main) {
  const db = openDb();
  migrate(db);
  const { total, latest, metaDate, gotMetaPoint, stalled } = await updateMoveIndex(db);
  db.close();
  console.log(
    `MOVE stored: ${total} points, latest ${latest ?? '(none)'}, meta ${metaDate ?? '缺'}` +
      `${gotMetaPoint ? '(已收盘)' : '(未收盘/不可用,未落库)'}${stalled ? ',且久未前进' : ''}.`,
  );
}
