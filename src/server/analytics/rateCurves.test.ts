import { describe, expect, it } from 'bun:test';
import { ffLabel, toPercent, impliedFedRate, OIS_TENORS, FF_CONTRACTS } from './rateCurves';

describe('rateCurves 纯转换', () => {
  it('OIS 小数转百分点', () => expect(toPercent(0.039389)).toBeCloseTo(3.9389, 4));
  it('FF 价格转隐含利率', () => expect(impliedFedRate(96.315)).toBeCloseTo(3.685, 3));
  it('FF 合约 n 标成"月数在前"', () => { expect(ffLabel(2)).toBe('+1m'); expect(ffLabel(13)).toBe('+12m'); });
  it('OIS 期限映射到 Pensford symbol', () =>
    expect(OIS_TENORS.find((t) => t.tenor === '5Y')?.symbol).toBe('SOFRSWAP Y5'));
  it('FF 合约从 2 起', () => expect(FF_CONTRACTS[0]).toBe(2));
});
