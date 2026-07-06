import { describe, expect, it } from 'bun:test';
import { ffLabel, impliedFedRate, ERIS_OIS_TENORS, FF_CONTRACTS } from './rateCurves';

describe('rateCurves 纯转换', () => {
  it('FF 价格转隐含利率', () => expect(impliedFedRate(96.315)).toBeCloseTo(3.685, 3));
  it('FF 合约 n 标成"月数在前"', () => { expect(ffLabel(2)).toBe('+1m'); expect(ffLabel(13)).toBe('+12m'); });
  it('FF 合约从 2 起', () => expect(FF_CONTRACTS[0]).toBe(2));
  it('FF 合约到 25 共 24 个', () => { expect(FF_CONTRACTS.length).toBe(24); expect(FF_CONTRACTS.at(-1)).toBe(25); });
  it('Eris OIS 期限表含短端到长端', () => {
    expect(ERIS_OIS_TENORS[0]).toBe('1D');
    expect(ERIS_OIS_TENORS).toContain('3M');
    expect(ERIS_OIS_TENORS).toContain('12M');
    expect(ERIS_OIS_TENORS.at(-1)).toBe('50Y');
    expect(ERIS_OIS_TENORS.length).toBe(24);
  });
});
