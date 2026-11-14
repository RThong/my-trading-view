import { describe, expect, it } from 'bun:test';
import { onTheRunExpiry, parseDtccCdxTrades } from './dtccCdx';
import { cdsPriceToSpreadBp } from '../analytics/rateCurves';

const COLS = [
  'Dissemination Identifier',
  'Original Dissemination Identifier',
  'Action type',
  'Event type',
  'Execution Timestamp',
  'Expiration Date',
  'Fixed rate-Leg 1',
  'Spread-Leg 1',
  'Spread notation-Leg 1',
  'UPI FISN',
  'UPI Underlier Name',
];
const BASE: Record<string, string> = {
  'Dissemination Identifier': '1',
  'Original Dissemination Identifier': '',
  'Action type': 'NEWT',
  'Event type': 'TRAD',
  'Execution Timestamp': '2026-11-12T17:32:08Z',
  'Expiration Date': '2031-12-20',
  'Fixed rate-Leg 1': '0.01',
  'Spread-Leg 1': '0.005854453',
  'Spread notation-Leg 1': '3',
  'UPI FISN': 'NA/CDS Corp Idx',
  'UPI Underlier Name': 'CDX.NA.IG',
};
function row(o: Record<string, string> = {}) {
  return `"${COLS.map((c) => o[c] ?? BASE[c]).join('","')}"`;
}
const HY = { 'UPI Underlier Name': 'CDX.NA.HY', 'Fixed rate-Leg 1': '0.05' };

describe('parseDtccCdxTrades', () => {
  it('IG 小数利差 → 价;HY 两种写法(价 / 价 ÷ 10000)都认;干扰行剔掉', () => {
    const csv = [
      `"${COLS.join('","')}"`,
      row(),
      row({ ...HY, 'Dissemination Identifier': '2', 'Spread-Leg 1': '106.095', 'Spread notation-Leg 1': '1' }),
      row({ ...HY, 'Dissemination Identifier': '3', 'Spread-Leg 1': '0.01062466' }),
      // 干扰:非 on-the-run 到期 / 分层 / 生命周期事件 / 票息不对 / 欧洲 / 未知写法
      row({ 'Expiration Date': '2031-06-20' }),
      row({ 'UPI FISN': 'NA/CDS Corp Idx Tra' }),
      row({ 'Action type': 'MODI' }),
      row({ 'Fixed rate-Leg 1': '0.05' }),
      row({ 'UPI Underlier Name': 'ITRAXX EUROPE' }),
      row({ ...HY, 'Spread notation-Leg 1': '2' }),
      row({ 'Action type': 'EROR', 'Event type': '', 'Original Dissemination Identifier': '9' }),
      '',
    ].join('\n');

    const { trades, cancelled } = parseDtccCdxTrades(csv);
    expect(cancelled).toEqual(['9']);
    expect(trades.map((t) => [t.id, t.index, t.date])).toEqual([
      ['1', 'IG', '2026-11-12'],
      ['2', 'HY', '2026-11-12'],
      ['3', 'HY', '2026-11-12'],
    ]);
    // IG 换成价后再换回利差,来回无损
    expect(cdsPriceToSpreadBp(trades[0].price, 100)).toBeCloseTo(58.54453, 4);
    expect(trades[1].price).toBe(106.095);
    expect(trades[2].price).toBeCloseTo(106.2466, 6);
  });

  it('表头缺列 → 抛错', () => {
    expect(() => parseDtccCdxTrades('"Action type"')).toThrow('缺列');
  });
});

describe('onTheRunExpiry', () => {
  it('IG 3/20 换新;HY 晚一周,3/27 才换', () => {
    expect(onTheRunExpiry('IG', '2026-03-20')).toBe('2031-06-20');
    expect(onTheRunExpiry('HY', '2026-03-20')).toBe('2030-12-20');
    expect(onTheRunExpiry('HY', '2026-03-26')).toBe('2030-12-20');
    expect(onTheRunExpiry('HY', '2026-03-27')).toBe('2031-06-20');
    expect(onTheRunExpiry('HY', '2026-11-12')).toBe('2031-12-20');
  });
});
