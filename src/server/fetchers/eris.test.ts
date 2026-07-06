import { describe, expect, it } from 'bun:test';
import { parseErisParCoupon } from './eris';

const SAMPLE = `Symbol,EvaluationDate,FirstTradeDate,ErisPAIDate,EffectiveDate,CashFlowAlignmentDate,MaturityDate,NPV (A),FixedNPV,FloatingNPV,Coupon (%),FairCoupon (%),Nominal,Spread (Bps),Index
SOFR1D,07/02/2026,07/02/2026,07/02/2026,07/07/2026,07/08/2026,07/10/2026,0,0.01,-0.01,3.6357,3.6357215934,100,0,SOFRON Actual/360
SOFR3M,07/02/2026,07/02/2026,07/02/2026,07/07/2026,10/07/2026,10/09/2026,0,0.94,-0.94,3.7193,3.7193567517,100,0,SOFRON Actual/360
SOFR10Y,07/02/2026,07/02/2026,07/02/2026,07/07/2026,07/07/2036,07/09/2036,0,33.3,-33.3,4.0647,4.0647448168,100,0,SOFRON Actual/360`;

describe('parseErisParCoupon', () => {
  const c = parseErisParCoupon(SAMPLE);
  it('EvaluationDate 归一 YYYY-MM-DD', () => expect(c.date).toBe('2026-07-02'));
  it('Symbol 去 SOFR 前缀成 tenor', () => expect(c.points.map((p) => p.tenor)).toEqual(['1D', '3M', '10Y']));
  it('取 FairCoupon(%) 作 rate(已是百分点)', () => {
    expect(c.points.find((p) => p.tenor === '3M')!.rate).toBeCloseTo(3.7193568, 5);
    expect(c.points.find((p) => p.tenor === '10Y')!.rate).toBeCloseTo(4.0647448, 5);
  });
});
