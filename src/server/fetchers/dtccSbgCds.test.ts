import { describe, expect, it } from 'bun:test';
import { onTheRun5y, parseSbgTrades } from './dtccSbgCds';
import { cdsPriceToSpreadBp, JPY_CDS } from '../analytics/rateCurves';

const COLS = [
  'Dissemination Identifier',
  'Original Dissemination Identifier',
  'Action type',
  'Event type',
  'Execution Timestamp',
  'Expiration Date',
  'Notional amount-Leg 1',
  'Notional currency-Leg 1',
  'Fixed rate-Leg 1',
  'Other payment type',
  'Other payment amount',
  'Underlier ID-Leg 1',
  'UPI Underlier Name',
  'Underlying Asset Name',
];
function q(fs: string[]) {
  return `"${fs.join('","')}"`;
}
function row(o: Partial<Record<string, string>>) {
  return q(
    COLS.map(
      (c) =>
        o[c] ??
        {
          'Dissemination Identifier': '1',
          'Original Dissemination Identifier': '',
          'Action type': 'NEWT',
          'Event type': 'TRAD',
          'Execution Timestamp': '2026-11-12T00:34:29Z',
          'Expiration Date': '2031-12-20',
          'Notional amount-Leg 1': '500,000,000',
          'Notional currency-Leg 1': 'JPY',
          'Fixed rate-Leg 1': '0.01',
          'Other payment type': 'UFRO',
          'Other payment amount': '74503485.00000',
          'Underlier ID-Leg 1': 'JQCEFX',
          'UPI Underlier Name': 'BOND',
          'Underlying Asset Name': 'SoftBank Group Corp.',
        }[c]!,
    ),
  );
}

describe('onTheRun5y', () => {
  it('按 3/20、9/20 换新', () => {
    expect(onTheRun5y('2026-03-19')).toBe('2030-12-20');
    expect(onTheRun5y('2026-03-20')).toBe('2031-06-20');
    expect(onTheRun5y('2026-09-19')).toBe('2031-06-20');
    expect(onTheRun5y('2026-09-20')).toBe('2031-12-20');
    expect(onTheRun5y('2026-11-12')).toBe('2031-12-20');
  });
});

describe('parseSbgTrades', () => {
  it('前端费 / 名义本金 → 价,并剔除各类干扰行(真实样本的字段形态)', () => {
    const csv = [
      q(COLS),
      row({}),
      // 截上限的名义本金带 `+`;另一种标识(ISIN)也认
      row({
        'Notional amount-Leg 1': '793,675,990+',
        'Other payment amount': '118263852.74328',
        'Underlier ID-Leg 1': 'JP343610ANC5',
      }),
      // 干扰:更替 / 压缩(前端费是转让结算款) / 生命周期事件 / 美元计价 / 非 on-the-run 到期 / 无前端费 / 前端费 0 / 软银电信(另一家公司)
      row({ 'Event type': 'NOVA' }),
      row({ 'Event type': 'COMP' }),
      row({ 'Action type': 'MODI' }),
      // 撤销行:不论哪家公司,它指向的原成交 ID 都收进 cancelled
      row({
        'Action type': 'EROR',
        'Event type': '',
        'Original Dissemination Identifier': '99',
        'Underlier ID-Leg 1': 'X',
      }),
      row({ 'Notional currency-Leg 1': 'USD' }),
      row({ 'Expiration Date': '2031-06-20' }),
      row({ 'Other payment type': '' }),
      row({ 'Other payment amount': '0.00000' }),
      row({ 'Underlier ID-Leg 1': 'JQCFGG', 'Underlying Asset Name': 'SoftBank Corp.' }),
      '',
    ].join('\r\n');

    const { trades, cancelled } = parseSbgTrades(csv);
    expect(cancelled).toEqual(['99']);
    expect(trades.map((t) => t.date)).toEqual(['2026-11-12', '2026-11-12']);
    expect(trades[0].price).toBeCloseTo(100 - 14.9007, 3);
    expect(trades[1].price).toBeCloseTo(100 - 14.9008, 3);
  });

  it('旧版(2025-11 前)表头不带引号也认', () => {
    expect(parseSbgTrades([COLS.join(','), row({})].join('\n')).trades).toHaveLength(1);
  });

  it('表头缺列 → 抛错(改版要响亮)', () => {
    expect(() => parseSbgTrades(q(['Action type']))).toThrow('缺列');
  });
});

describe('日元口径换算', () => {
  it('前端费 14.9%(100bp 票息)约合 470bp;日元利率低 → 风险久期长 → 比按美元参数换算低约 25bp', () => {
    const jpy = cdsPriceToSpreadBp(85.1, 100, JPY_CDS);
    const usd = cdsPriceToSpreadBp(85.1);
    expect(jpy).toBeCloseTo(472, 0);
    expect(usd - jpy).toBeGreaterThan(15);
    expect(usd - jpy).toBeLessThan(40);
  });
});
