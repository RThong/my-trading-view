import { describe, expect, it } from 'bun:test';
import { americanIvDelta, americanPrice } from './optionPricing';

describe('american(CRR)', () => {
  it('不分红的美式 call = 欧式(不会提前行权):对上 Black-Scholes 闭式解', () => {
    // 闭式解用误差函数的级数逼近(测试里自带,免得被测函数自证)
    const erf = (x: number) => {
      const t = 1 / (1 + 0.3275911 * Math.abs(x));
      const y =
        1 -
        ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
          t *
          Math.exp(-x * x);
      return x >= 0 ? y : -y;
    };
    const cdf = (x: number) => (1 + erf(x / Math.SQRT2)) / 2;
    const [S, K, T, r, v] = [80, 82, 0.08, 0.04, 0.12];
    const d1 = (Math.log(S / K) + (r + (v * v) / 2) * T) / (v * Math.sqrt(T));
    const bs = S * cdf(d1) - K * Math.exp(-r * T) * cdf(d1 - v * Math.sqrt(T));

    expect(americanPrice({ S, K, T, r, q: 0, call: true }, v).price).toBeCloseTo(bs, 2);
  });

  it('反解 IV 回到原值;分红越高 call 越便宜(同价 → IV 越高)', () => {
    const inp = { S: 79.4, K: 81, T: 0.0767, r: 0.039, call: true };
    const px = americanPrice({ ...inp, q: 0.05 }, 0.12).price;
    expect(americanIvDelta(px, { ...inp, q: 0.05 })?.iv).toBeCloseTo(0.12, 3);
    expect(americanIvDelta(px, { ...inp, q: 0 })!.iv).toBeLessThan(0.12);
    const put = americanIvDelta(americanPrice({ ...inp, call: false, q: 0.05 }, 0.13).price, {
      ...inp,
      call: false,
      q: 0.05,
    });
    expect(put!.delta).toBeLessThan(0);
  });
});
