import { describe, expect, it } from 'bun:test';
import { parseDtccZcis } from './dtccZcis';

const COLS = [
  'Dissemination Identifier',
  'Original Dissemination Identifier',
  'Action type',
  'Event type',
  'Execution Timestamp',
  'Effective Date',
  'Expiration Date',
  'Fixed rate-Leg 1',
  'Fixed rate-Leg 2',
  'UPI FISN',
  'UPI Underlier Name',
];
const BASE: Record<string, string> = {
  'Dissemination Identifier': '1',
  'Original Dissemination Identifier': '',
  'Action type': 'NEWT',
  'Event type': 'TRAD',
  'Execution Timestamp': '2026-11-12T15:00:00Z',
  'Effective Date': '2026-11-16',
  'Expiration Date': '2027-11-16',
  'Fixed rate-Leg 1': '0.02113',
  'Fixed rate-Leg 2': '',
  'UPI FISN': 'NA/Swap Infl Idx USD',
  'UPI Underlier Name': 'USA-CPI-U',
};
function row(o: Record<string, string> = {}) {
  return `"${COLS.map((c) => o[c] ?? BASE[c]).join('","')}"`;
}

describe('parseDtccZcis', () => {
  it('只收即期起息的 1Y / 2Y;老化合约 / 远期起息 / 非整年 / 生命周期事件 / 其它产品剔掉;利率可能在 Leg 2', () => {
    const csv = [
      `"${COLS.join('","')}"`,
      row(),
      // 2Y,固定利率填在 Leg 2
      row({
        'Dissemination Identifier': '2',
        'Expiration Date': '2028-11-16',
        'Fixed rate-Leg 1': '',
        'Fixed rate-Leg 2': '0.02261',
      }),
      // 干扰:老化合约(年初起息)/ 远期起息 / 18 个月 / MODI / OIS / 没有固定利率
      row({ 'Effective Date': '2026-01-01', 'Expiration Date': '2027-01-01', 'Fixed rate-Leg 1': '0.035' }),
      row({ 'Effective Date': '2027-01-15', 'Expiration Date': '2028-01-15' }),
      row({ 'Expiration Date': '2028-05-16' }),
      row({ 'Action type': 'MODI' }),
      row({ 'UPI FISN': 'NA/Swap OIS USD' }),
      row({ 'Fixed rate-Leg 1': '' }),
      row({ 'Action type': 'EROR', 'Event type': '', 'Original Dissemination Identifier': '9', 'UPI FISN': 'X' }),
      '',
    ].join('\n');

    const { trades, cancelled } = parseDtccZcis(csv);
    expect(cancelled).toEqual(['9']);
    expect(trades.map((t) => [t.id, t.tenor, t.date])).toEqual([
      ['1', '1Y', '2026-11-12'],
      ['2', '2Y', '2026-11-12'],
    ]);
    expect(trades[0].rate).toBeCloseTo(2.113, 9);
    expect(trades[1].rate).toBeCloseTo(2.261, 9);
  });

  it('表头缺列 → 抛错', () => {
    expect(() => parseDtccZcis('"Action type"')).toThrow('缺列');
  });
});
