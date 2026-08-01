import { describe, expect, it } from 'bun:test';
import { fetchMoveSeries, mergeMove, metaPoint } from './moveIndex';

describe('metaPoint', () => {
  it('取 meta 当日点(Date 与 epoch 秒都认)', () => {
    const at = Date.parse('2026-07-31T20:00:00Z');

    expect(metaPoint({ regularMarketPrice: 83.02, regularMarketTime: new Date(at) })).toEqual({
      date: '2026-07-31',
      value: 83.02,
      at,
    });
    // epoch 秒同样认(单位换算过来是同一瞬间)
    expect(metaPoint({ regularMarketPrice: 83.02, regularMarketTime: at / 1000 })).toEqual({
      date: '2026-07-31',
      value: 83.02,
      at,
    });
  });

  it('日期按 ET 日截,不按 UTC 日(晚到的戳不能被挪到次日)', () => {
    const at = Date.parse('2026-08-01T00:30:00Z'); // 7/31 20:30 ET

    expect(metaPoint({ regularMarketPrice: 83.02, regularMarketTime: new Date(at) })?.date).toBe('2026-07-31');
  });

  it('缺价或缺时间戳 → null', () => {
    expect(metaPoint({ regularMarketTime: new Date('2026-07-31T20:00:00Z') })).toBeNull();
    expect(metaPoint({ regularMarketPrice: 83.02 })).toBeNull();
    expect(metaPoint({ regularMarketPrice: Number.NaN, regularMarketTime: 1785528000 })).toBeNull();
  });

  it('价 ≤0 → null(schema 里该字段 required,源缺值时更可能填 0 占位;MOVE 取不到 0)', () => {
    const at = new Date('2026-07-31T20:00:00Z');

    expect(metaPoint({ regularMarketPrice: 0, regularMarketTime: at })).toBeNull();
    expect(metaPoint({ regularMarketPrice: -1, regularMarketTime: at })).toBeNull();
  });

  it('时间戳是垃圾值 → null,不写 1970 也不抛', () => {
    const bad = [0, -1, Number.NaN, Number.POSITIVE_INFINITY, new Date('nonsense')];

    bad.forEach((regularMarketTime) => {
      expect(metaPoint({ regularMarketPrice: 83.02, regularMarketTime })).toBeNull();
    });
  });

  it('远期时间戳 → null(单位若变成毫秒会算出公元五万年,落库无法删)', () => {
    const now = new Date('2026-07-31T20:00:00Z').getTime();

    expect(metaPoint({ regularMarketPrice: 83.02, regularMarketTime: 1785528000000 }, now)).toBeNull();
    // 边界内(今天)照常通过
    expect(metaPoint({ regularMarketPrice: 83.02, regularMarketTime: 1785528000 }, now)).toEqual({
      date: '2026-07-31',
      value: 83.02,
      at: 1785528000000,
    });
  });
});

describe('mergeMove', () => {
  it('同日 Yahoo 覆盖补丁,其余并集升序', () => {
    const bars = [
      { date: '2026-07-17', value: 70.88 },
      { date: '2026-07-20', value: 72.0 }, // 源自愈:该日 Yahoo 有值了
    ];
    const patch = [
      { date: '2026-07-20', value: 71.5 }, // 旧补丁,应被盖掉
      { date: '2026-07-31', value: 83.02 },
    ];

    expect(mergeMove(bars, patch)).toEqual([
      { date: '2026-07-17', value: 70.88 },
      { date: '2026-07-20', value: 72.0 },
      { date: '2026-07-31', value: 83.02 },
    ]);
  });
});

describe('fetchMoveSeries', () => {
  // 复刻线上故障:日线 7/20 起全 null,meta 仍有当日值。
  const brokenChart = {
    meta: { regularMarketPrice: 83.02, regularMarketTime: new Date('2026-07-31T20:00:00Z') },
    quotes: [
      { date: new Date('2026-07-17T20:00:00Z'), close: 70.88 },
      { date: new Date('2026-07-20T20:00:00Z'), close: null },
      { date: new Date('2026-07-31T20:00:00Z'), close: null },
    ],
  };

  it('日线断供时用 meta 补出当天', async () => {
    const { points, meta } = await fetchMoveSeries(new Date('2026-07-01'), async () => brokenChart);

    expect(points).toEqual([
      { date: '2026-07-17', value: 70.88 },
      { date: '2026-07-31', value: 83.02 },
    ]);
    expect(meta).toEqual({ date: '2026-07-31', value: 83.02, at: Date.parse('2026-07-31T20:00:00Z') });
  });

  it('meta 也缺 → 只剩非空日线,meta 回 null 供调用方判失败', async () => {
    const { points, meta } = await fetchMoveSeries(new Date('2026-07-01'), async () => ({
      ...brokenChart,
      meta: {},
    }));

    expect(points).toEqual([{ date: '2026-07-17', value: 70.88 }]);
    expect(meta).toBeNull();
  });
});
