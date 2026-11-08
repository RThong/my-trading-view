import { describe, expect, test } from 'bun:test';
import { INDICATORS, periodsOf } from './indicatorDefs';
import { ema, rsi } from './indicators';

const pts = Array.from({ length: 400 }, (_, i) => ({
  time: new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10),
  value: 100 + 10 * Math.sin(i / 9) + i * 0.1,
}));
const ctx = { daily: true, autoYear: false };

describe('内置指标表', () => {
  test('画哪几样与算出几组一一对应(EMA / 布林带 / MACD / RSI)', () => {
    for (const id of ['ema', 'bb', 'macd', 'rsi'] as const) {
      const ps = periodsOf(id, undefined);
      expect(INDICATORS[id].compute(pts, ps, ctx)).toHaveLength(INDICATORS[id].plots(ps).length);
    }
  });

  test('EMA / RSI 的周期:缺省用 moomoo 那组,写了就照写的;结果与 indicators 同口径', () => {
    expect(periodsOf('ema', undefined)).toEqual([5, 20, 50, 144, 169, 200]);
    expect(periodsOf('rsi', undefined)).toEqual([6, 12, 24]);
    expect(periodsOf('ema', [10, 30])).toEqual([10, 30]);
    const closes = pts.map((p) => ({ time: p.time, close: p.value }));
    expect(INDICATORS.ema.compute(pts, [10, 30], ctx)).toEqual([ema(closes, 10), ema(closes, 30)]);
    expect(INDICATORS.rsi.compute(pts, [6], ctx)).toEqual([rsi(closes, 6)]);
  });

  test('365 年线:7×24 资产的默认那组自动带上、只在日线上有数;自定义周期不自动加,自己写了 365 就照画', () => {
    expect(periodsOf('ema', undefined, true)).toEqual([5, 20, 50, 144, 169, 200, 365]);
    expect(periodsOf('ema', undefined, false)).toEqual([5, 20, 50, 144, 169, 200]);
    expect(periodsOf('ema', [10, 30], true)).toEqual([10, 30]);
    expect(INDICATORS.ema.plots([5, 365]).map((p) => p.key)).toEqual(['ema5', 'ema365']);
    expect(INDICATORS.ema.compute(pts, [5, 365], { daily: false, autoYear: true })[1]).toEqual([]);
    expect(INDICATORS.ema.compute(pts, [5, 365], { daily: false, autoYear: false })[1].length).toBeGreaterThan(0);
    expect(INDICATORS.ema.compute(pts, [5, 365], { daily: true, autoYear: true })[1].length).toBeGreaterThan(0);
  });

  test('布林带:跨数量级(>100 倍)的在对数价上算,下轨不贴 0 / 不变负;MACD 柱画成正绿负红柱', () => {
    const wild = pts.map((p, i) => ({ time: p.time, value: 1.05 ** (i / 2) }));
    const lower3 = INDICATORS.bb.compute(wild, [], ctx)[3];
    expect(lower3.every((p) => p.value > 0)).toBe(true);
    expect(INDICATORS.macd.plots([])[0]).toMatchObject({ key: 'hist', kind: 'signed' });
    expect(INDICATORS.bb.plots([]).find((p) => p.fillTo)?.fillTo?.key).toBe('lower');
    // 穿 0 的线(VRP、skew、利差):正值之比再大也不取对数,不出 NaN
    const crossing = pts.map((p, i) => ({ time: p.time, value: i % 50 === 0 ? 0.0003 : Math.sin(i / 7) * 20 }));
    const bands = INDICATORS.bb.compute(crossing, [], ctx);
    expect(bands.every((b) => b.every((p) => Number.isFinite(p.value)))).toBe(true);
    expect(bands[3].some((p) => p.value < 0)).toBe(true); // 穿 0 的线负值是真的,照留
    // 全正的价格线(VIX 这种急涨急跌):下轨算成负价的点滤掉,不把价格轴拉到 0 以下
    const spiky = pts.map((p, i) => ({ time: p.time, value: i % 40 === 20 ? 80 : 12 }));
    const priceBands = INDICATORS.bb.compute(spiky, [], ctx);
    expect(priceBands.every((b) => b.every((p) => p.value > 0))).toBe(true);
    expect(priceBands[3].length).toBeLessThan(priceBands[0].length);
  });
});
