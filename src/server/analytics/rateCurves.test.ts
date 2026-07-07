import { describe, expect, it } from 'bun:test';
import { ERIS_OIS_TENORS, CREDIT_RATING, CREDIT_TERM } from './rateCurves';

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
