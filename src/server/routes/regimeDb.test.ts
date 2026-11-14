import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate } from '../storage/db';
import { insertMarketSeries } from '../storage/repository';
import { cdxSpreadPct } from './regimeDb';
import { cdsSpreadToPrice } from '../analytics/rateCurves';

test('cdxSpreadPct:ICE 为准,只接 ICE 第一天之前的 DTCC 段;价反解成利差 %;无解的点丢掉', () => {
  const db = new Database(':memory:');
  migrate(db);
  insertMarketSeries(db, [
    { seriesId: 'DTCC_CDX_IG', obsDate: '2026-11-10', value: cdsSpreadToPrice(55, 100) },
    { seriesId: 'DTCC_CDX_IG', obsDate: '2026-11-11', value: 30 }, // 价 ≤ 回收价:无解 → 丢
    { seriesId: 'DTCC_CDX_IG', obsDate: '2026-11-12', value: cdsSpreadToPrice(99, 100) }, // ICE 已有 → 不用
    { seriesId: 'ICE_CDX_IG', obsDate: '2026-11-12', value: cdsSpreadToPrice(58, 100) },
    { seriesId: 'ICE_CDX_IG', obsDate: '2026-11-13', value: cdsSpreadToPrice(60, 100) },
  ]);

  const out = cdxSpreadPct(db, 'IG', 100);

  expect(out.map((p) => p.date)).toEqual(['2026-11-10', '2026-11-12', '2026-11-13']);
  expect(out.map((p) => +p.value.toFixed(6))).toEqual([0.55, 0.58, 0.6]);
});
