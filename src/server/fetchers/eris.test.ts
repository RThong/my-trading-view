import { describe, expect, it } from 'bun:test';
import { parseErisParCoupon, fetchErisForDate, parseErisHistorical } from './eris';

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

const resp = (status: number, body = '') => new Response(body, { status });
describe('fetchErisForDate', () => {
  it('两处都 404 → null(非交易日)', async () => {
    expect(await fetchErisForDate('2026-07-04', async () => resp(404))).toBeNull();
  });
  it('archives 404 → 回退 root 命中并解析', async () => {
    let n = 0;
    const f = async () => (n++ === 0 ? resp(404) : resp(200, SAMPLE));
    expect((await fetchErisForDate('2026-07-02', f))?.points.length).toBe(3);
  });
  it('非 404 错误(500)→ 抛出,不静默当非交易日', async () => {
    expect(fetchErisForDate('2026-07-02', async () => resp(500))).rejects.toThrow();
  });
});

const WIDE = `Evaluation Date,SOFR1W,SOFR3M,SOFR10Y
2026-07-02,3.638,3.719,4.065
2026-07-01,3.634,3.739,4.067`;

describe('parseErisHistorical(宽表全历史)', () => {
  const rows = parseErisHistorical(WIDE);
  it('每行一个 curve', () => expect(rows.length).toBe(2));
  it('date 直接取(已是 YYYY-MM-DD)', () => expect(rows[0].date).toBe('2026-07-02'));
  it('列头去 SOFR 前缀成 tenor + 取值', () => {
    expect(rows[0].points.find((p) => p.tenor === '3M')!.rate).toBeCloseTo(3.719, 3);
    expect(rows[1].points.find((p) => p.tenor === '10Y')!.rate).toBeCloseTo(4.067, 3);
  });
});
