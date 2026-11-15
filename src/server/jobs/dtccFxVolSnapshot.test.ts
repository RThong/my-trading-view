import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate } from '../storage/db';
import { getMarketSeries, insertMarketSeries } from '../storage/repository';
import { gkPrice } from '../analytics/fxImpliedVol';
import type { FxOptionTrade } from '../fetchers/dtccFxOptions';
import { FX_VOL_SERIES, updateDtccFxVol } from './dtccFxVolSnapshot';

const TODAY = '2026-11-15';
const DAY = '2026-11-13';

function trade(id: string, call: boolean): FxOptionTrade {
  const price = gkPrice({ spot: 155, strike: 155, years: 30 / 365, vol: 0.09, rd: 0.0075, rf: 0.04, call });
  return {
    id,
    date: DAY,
    expiry: '2026-12-13',
    call,
    strike: 155,
    usdNotional: 1e7,
    premium: (price / 155) * 1e7,
    premiumCcy: 'USD',
  };
}
const SIX = ['c1', 'c2', 'c3', 'p1', 'p2', 'p3'].map((id) => trade(id, id.startsWith('c')));

function setup() {
  const db = new Database(':memory:');
  migrate(db);
  insertMarketSeries(db, [{ seriesId: 'ERIS_OIS_1M', obsDate: '2026-11-01', value: 4 }]);
  return db;
}
// 只有 DAY 那天有文件;其它天当成源不保留(null),日常模式下会记「缺失」—— 这里只看写库结果
function fetchDay(trades: FxOptionTrade[], cancelled: string[] = []) {
  return async (d: string) => (d === DAY ? { trades, cancelled } : null);
}

describe('updateDtccFxVol', () => {
  test('写入反推出的 9%;那天全被撤销后重跑 → 删掉旧值', async () => {
    const db = setup();
    const fetchSpot = async () => new Map([[DAY, 155]]);
    await updateDtccFxVol(db, { backfill: true, today: TODAY, deps: { fetchDay: fetchDay(SIX), fetchSpot } });
    expect(getMarketSeries(db, FX_VOL_SERIES)).toEqual([{ date: DAY, value: expect.closeTo(9, 3) }]);

    await updateDtccFxVol(db, {
      backfill: true,
      today: TODAY,
      deps: { fetchDay: fetchDay(SIX, ['c1', 'c2']), fetchSpot },
    });
    expect(getMarketSeries(db, FX_VOL_SERIES)).toEqual([]);
  });

  test('成交日早于美元利率序列起点 → 不出点、也不删旧值(不拿未来的利率反推)', async () => {
    const db = setup();
    insertMarketSeries(db, [{ seriesId: FX_VOL_SERIES, obsDate: '2026-10-30', value: 8 }]);
    const early = SIX.map((t) => ({ ...t, date: '2026-10-30', expiry: '2026-11-30' }));
    const r = await updateDtccFxVol(db, {
      backfill: true,
      today: TODAY,
      deps: {
        fetchDay: async (d) => (d === '2026-10-30' ? { trades: early, cancelled: [] } : null),
        fetchSpot: async () => new Map([['2026-10-30', 155]]),
      },
    });
    expect(r.written).toBe(0);
    expect(getMarketSeries(db, FX_VOL_SERIES).map((p) => p.value)).toEqual([8]);
  });

  test('拿不到汇率 → 整轮失败、不写不删', async () => {
    const db = setup();
    insertMarketSeries(db, [{ seriesId: FX_VOL_SERIES, obsDate: DAY, value: 8 }]);
    const r = await updateDtccFxVol(db, {
      backfill: true,
      today: TODAY,
      deps: { fetchDay: fetchDay(SIX), fetchSpot: async () => new Map() },
    });
    expect(r.failed[0]).toContain('USD/JPY 收盘');
    expect(getMarketSeries(db, FX_VOL_SERIES).map((p) => p.value)).toEqual([8]);
  });
});
