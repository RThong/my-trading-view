import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate } from '../storage/db';
import { getMarketSeries } from '../storage/repository';
import { isCloseSnapshot, updateMoveIndex } from './moveSnapshot';

const CLOSE_AT = Date.parse('2026-07-31T20:34:30Z'); // 16:34 ET,已收盘
const INTRADAY_AT = Date.parse('2026-07-31T15:00:00Z'); // 11:00 ET,盘中(早于半日市 13:00 收盘)

function freshDb(): Database {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}

describe('isCloseSnapshot', () => {
  // 各触发点用真实换算:JST 11:00 = ET 前一日 22:00(夏令时)/ 21:00(冬令时)
  const jst11 = Date.parse('2026-08-01T02:00:00Z'); // = 7/31 22:00 ET
  const jst20 = Date.parse('2026-08-01T11:00:00Z'); // = 8/01 07:00 ET

  it('现在已过 16:00 ET → 算收盘(JST 11/12 那两个触发点)', () => {
    expect(isCloseSnapshot(CLOSE_AT, jst11)).toBe(true);
  });

  it('meta 的 ET 日已翻篇 → 算收盘(JST 20/21/22 那三个触发点)', () => {
    expect(isCloseSnapshot(CLOSE_AT, jst20)).toBe(true);
  });

  it('盘中唤醒补跑 → 不算收盘,当天后续触发再补', () => {
    const et14 = Date.parse('2026-07-31T18:00:00Z'); // 14:00 ET,常规盘中
    const et11 = Date.parse('2026-07-31T15:00:00Z'); // 11:00 ET

    expect(isCloseSnapshot(INTRADAY_AT, et11)).toBe(false);
    expect(isCloseSnapshot(Date.parse('2026-07-31T17:30:00Z'), et14)).toBe(false); // 13:30 ET 的值
  });

  it('半日市不构成特例:13:05 ET 收盘的值,晚间触发照样收', () => {
    // 感恩节次日 2026-11-27,股市 13:00 ET 收;冬令时 ET = UTC-5
    const halfDayClose = Date.parse('2026-11-27T18:05:00Z'); // 13:05 ET
    const jst11Next = Date.parse('2026-11-28T02:00:00Z'); // = 11/27 21:00 ET

    expect(isCloseSnapshot(halfDayClose, jst11Next)).toBe(true);
  });

  it('meta 是前一交易日收盘、现在却是盘中 → 照常算收盘(那值确实已收盘)', () => {
    const prevClose = Date.parse('2026-07-30T20:34:30Z'); // 7/30 16:34 ET
    const et1030 = Date.parse('2026-07-31T14:30:00Z'); // 7/31 10:30 ET,盘中

    expect(isCloseSnapshot(prevClose, et1030)).toBe(true);
  });

  it('16:00–17:00 ET 之间不算:MOVE ~16:34 才定盘,早收会把未定盘值写死', () => {
    const et1605 = Date.parse('2026-07-31T20:05:00Z'); // 16:05 ET
    const et1705 = Date.parse('2026-07-31T21:05:00Z'); // 17:05 ET

    expect(isCloseSnapshot(CLOSE_AT, et1605)).toBe(false);
    expect(isCloseSnapshot(CLOSE_AT, et1705)).toBe(true);
  });
});

describe('updateMoveIndex', () => {
  const points = [
    { date: '2026-07-17', value: 70.88 },
    { date: '2026-07-31', value: 83.02 },
  ];
  const closeFetch = async () => ({ points, meta: { date: '2026-07-31', value: 83.02, at: CLOSE_AT } });
  const now = Date.parse('2026-07-31T22:00:00Z');

  it('收盘快照:整条序列落库,回报 meta 日期', async () => {
    const db = freshDb();

    expect(await updateMoveIndex(db, closeFetch, now)).toEqual({
      total: 2,
      latest: '2026-07-31',
      metaDate: '2026-07-31',
      gotMetaPoint: true,
      stalled: false,
    });
    expect(getMarketSeries(db, 'MOVE')).toEqual(points);

    db.close();
  });

  it('盘中快照:那一格不落库,判失败等当天后续触发补', async () => {
    const db = freshDb();
    const duringSession = Date.parse('2026-07-31T18:00:00Z'); // 14:00 ET,唤醒补跑落在盘中

    const r = await updateMoveIndex(
      db,
      async () => ({ points, meta: { date: '2026-07-31', value: 81.5, at: INTRADAY_AT } }),
      duringSession,
    );

    expect(r.gotMetaPoint).toBe(false);
    expect(r.metaDate).toBe('2026-07-31');
    // 只写了日线那部分,盘中那天不在库里
    expect(getMarketSeries(db, 'MOVE')).toEqual([{ date: '2026-07-17', value: 70.88 }]);

    db.close();
  });

  it('同日重跑幂等;自愈后真值 upsert 覆盖,且不删旧行', async () => {
    const db = freshDb();
    await updateMoveIndex(db, closeFetch, now);
    await updateMoveIndex(db, closeFetch, now);
    expect(getMarketSeries(db, 'MOVE')).toEqual(points);

    const healed = { date: '2026-07-31', value: 83.0244 };
    await updateMoveIndex(db, async () => ({ points: [healed], meta: { ...healed, at: CLOSE_AT } }), now);
    expect(getMarketSeries(db, 'MOVE')).toEqual([
      { date: '2026-07-17', value: 70.88 }, // 本次抓取里没有 → 保留
      healed,
    ]);

    db.close();
  });

  it('同日重试不误报 stalled(库里那格是本 job 自己写的,不能拿来比)', async () => {
    const db = freshDb();
    await updateMoveIndex(db, closeFetch, now);

    expect((await updateMoveIndex(db, closeFetch, now)).stalled).toBe(false);

    db.close();
  });

  it('meta 超过 5 天没前进 → stalled 告警', async () => {
    const db = freshDb();
    const sixDaysLater = CLOSE_AT + 6 * 24 * 3600 * 1000;

    expect((await updateMoveIndex(db, closeFetch, sixDaysLater)).stalled).toBe(true);

    db.close();
  });

  it('长周末不误报:3 天内仍算正常', async () => {
    const db = freshDb();
    const threeDaysLater = CLOSE_AT + 3 * 24 * 3600 * 1000;

    expect((await updateMoveIndex(db, closeFetch, threeDaysLater)).stalled).toBe(false);

    db.close();
  });

  it('meta 完全缺失 → gotMetaPoint=false,日线照样落库', async () => {
    const db = freshDb();

    const r = await updateMoveIndex(db, async () => ({ points, meta: null }), now);

    expect(r).toEqual({ total: 2, latest: '2026-07-31', metaDate: null, gotMetaPoint: false, stalled: false });
    expect(getMarketSeries(db, 'MOVE')).toEqual(points);

    db.close();
  });

  it('空结果不抛', async () => {
    const db = freshDb();

    expect(await updateMoveIndex(db, async () => ({ points: [], meta: null }), now)).toEqual({
      total: 0,
      latest: null,
      metaDate: null,
      gotMetaPoint: false,
      stalled: false,
    });

    db.close();
  });
});
