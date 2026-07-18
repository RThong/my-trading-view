import { describe, expect, it } from 'bun:test';
import { ERIS_OIS_TENORS, CREDIT_RATING, CREDIT_TERM, computeBeiCurve } from './rateCurves';

describe('rateCurves 纯转换', () => {
  it('Eris OIS 期限表含短端到长端', () => {
    expect(ERIS_OIS_TENORS[0]).toBe('1D');
    expect(ERIS_OIS_TENORS).toContain('3M');
    expect(ERIS_OIS_TENORS).toContain('12M');
    expect(ERIS_OIS_TENORS.at(-1)).toBe('50Y');
    expect(ERIS_OIS_TENORS.length).toBe(24);
  });
  it('信用评级梯队 AAA→CCC 映射到 ICE BofA series', () => {
    expect(CREDIT_RATING.map((c) => c.tenor)).toEqual(['AAA', 'AA', 'A', 'BBB', 'BB', 'B', 'CCC']);
    expect(CREDIT_RATING.find((c) => c.tenor === 'CCC')!.series).toBe('BAMLH0A3HYC');
  });
  it('IG 信用期限结构映射', () => {
    expect(CREDIT_TERM[0]).toEqual({ tenor: '1-3Y', series: 'BAMLC1A0C13Y' });
    expect(CREDIT_TERM.at(-1)!.tenor).toBe('15Y+');
    expect(CREDIT_TERM.at(-1)!.series).toBe('BAMLC8A0C15PY');
  });
});

describe('computeBeiCurve(BEI = 名义 − TIPS 实际)', () => {
  it('各档按日对齐相减,tenors 保序', () => {
    const { tenors, series, unavailable } = computeBeiCurve([
      {
        tenor: '5Y',
        nominal: [
          { date: '2018-01-02', value: 4.0 },
          { date: '2018-01-03', value: 4.1 },
        ],
        real: [
          { date: '2018-01-02', value: 2.0 },
          { date: '2018-01-03', value: 2.1 },
        ],
      },
    ]);
    expect(tenors).toEqual(['5Y']);
    expect(unavailable).toEqual([]);
    expect(series['5Y'].map((p) => p.date)).toEqual(['2018-01-02', '2018-01-03']);
    expect(series['5Y'][0].value).toBeCloseTo(2.0, 10);
    expect(series['5Y'][1].value).toBeCloseTo(2.0, 10);
  });

  it('某腿缺(null 或空)→ 该档进 unavailable,不入 series', () => {
    const { series, unavailable } = computeBeiCurve([
      { tenor: '5Y', nominal: [{ date: '2018-01-02', value: 4.0 }], real: [{ date: '2018-01-02', value: 2.0 }] },
      { tenor: '10Y', nominal: [{ date: '2018-01-02', value: 4.5 }], real: null },
      { tenor: '30Y', nominal: [], real: [{ date: '2018-01-02', value: 2.5 }] },
    ]);
    expect(Object.keys(series)).toEqual(['5Y']);
    expect(unavailable).toEqual(['10Y', '30Y']);
  });
});
