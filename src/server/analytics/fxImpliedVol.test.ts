import { describe, expect, test } from 'bun:test';
import type { FxOptionTrade } from '../fetchers/dtccFxOptions';
import { dailyAtmVol, gkPrice, impliedVol } from './fxImpliedVol';

const base = { spot: 155, strike: 155, years: 30 / 365, rd: 0.0075, rf: 0.04 };

describe('Garman-Kohlhagen', () => {
  test('按价格反推回原来的波动率;看涨看跌满足平价', () => {
    const c = gkPrice({ ...base, vol: 0.09, call: true });
    const p = gkPrice({ ...base, vol: 0.09, call: false });
    expect(impliedVol(c, { ...base, call: true })).toBeCloseTo(0.09, 6);
    expect(impliedVol(p, { ...base, call: false })).toBeCloseTo(0.09, 6);
    // C − P = e^{−rf·T}·S − e^{−rd·T}·K
    const parity = base.spot * Math.exp(-base.rf * base.years) - base.strike * Math.exp(-base.rd * base.years);
    expect(c - p).toBeCloseTo(parity, 6);
  });

  test('价格低于内在价值 / 高得离谱 → null', () => {
    expect(impliedVol(0, { ...base, call: true })).toBeNull();
    expect(impliedVol(1000, { ...base, call: true })).toBeNull();
  });
});

describe('dailyAtmVol', () => {
  // 按 9% 波动率生成的成交;期权费用美元计(占美元名义的比例 × 名义)
  function trade(id: string, call: boolean, strike: number, extra: Partial<FxOptionTrade> = {}): FxOptionTrade {
    const price = gkPrice({ ...base, strike, vol: 0.09, call });
    return {
      id,
      date: '2026-11-13',
      expiry: '2026-12-13',
      call,
      strike,
      usdNotional: 10_000_000,
      premium: (price / base.spot) * 10_000_000,
      premiumCcy: 'USD',
      ...extra,
    };
  }
  const spot = new Map([['2026-11-13', 155]]);
  const rate = () => 0.04;

  test('看涨看跌各 3 笔 → 反推回 9%;到期太远 / 离平值太远 / 日元计期权费都照规则处理', () => {
    const ts = [
      trade('c1', true, 155),
      trade('c2', true, 154),
      trade('c3', true, 156),
      trade('p1', false, 155),
      trade('p2', false, 154),
      trade('p3', false, 156),
      trade('far', true, 155, { expiry: '2027-03-13', premium: 1 }), // 4 个月到期,不收
      trade('otm', false, 140, { premium: 1 }), // 离平值约 10%,不收
    ];
    expect(dailyAtmVol(ts, spot, rate)).toEqual([{ date: '2026-11-13', value: expect.closeTo(9, 4) }]);

    const yen = ts.slice(0, 6).map((t) => ({ ...t, premium: t.premium * 155, premiumCcy: 'JPY' as const }));
    expect(dailyAtmVol(yen, spot, rate)[0].value).toBeCloseTo(9, 4);
  });

  test('汇率估偏时看涨看跌一正一反,平均后仍接近真值', () => {
    const ts = ['c1', 'c2', 'c3', 'p1', 'p2', 'p3'].map((id) => trade(id, id.startsWith('c'), 155));
    const off = dailyAtmVol(ts, new Map([['2026-11-13', 155.4]]), rate)[0].value;
    expect(Math.abs(off - 9)).toBeLessThan(0.3);
  });

  test('单边不够 3 笔 / 没有收盘价 → 不出点', () => {
    const ts = [trade('c1', true, 155), trade('c2', true, 155), trade('p1', false, 155), trade('p2', false, 155)];
    expect(dailyAtmVol(ts, spot, rate)).toEqual([]);
    const full = ['c1', 'c2', 'c3', 'p1', 'p2', 'p3'].map((id) => trade(id, id.startsWith('c'), 155));
    expect(dailyAtmVol(full, new Map(), rate)).toEqual([]);
  });
});
