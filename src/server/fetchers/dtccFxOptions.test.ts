import { describe, expect, test } from 'bun:test';
import { parseDtccFxOptions } from './dtccFxOptions';

const COLS = [
  'Dissemination Identifier',
  'Original Dissemination Identifier',
  'Action type',
  'Event type',
  'Execution Timestamp',
  'Expiration Date',
  'Call currency',
  'Call amount',
  'Put currency',
  'Put amount',
  'Option Premium Amount',
  'Option Premium Currency',
  'Strike Price',
  'Strike price currency/currency pair',
  'UPI FISN',
];
function line(v: Record<string, string>) {
  return COLS.map((c) => `"${v[c] ?? ''}"`).join(',');
}
const call = {
  'Dissemination Identifier': '1',
  'Action type': 'NEWT',
  'Event type': 'TRAD',
  'Execution Timestamp': '2026-11-13T02:51:13Z',
  'Expiration Date': '2026-12-15',
  'Call currency': 'USD',
  'Call amount': '10000000',
  'Put currency': 'JPY',
  'Put amount': '1530000000',
  'Option Premium Amount': '22,220',
  'Option Premium Currency': 'USD',
  'Strike Price': '153',
  'Strike price currency/currency pair': 'USD/JPY',
  'UPI FISN': 'NA/O Van Call JPY USD',
};

describe('parseDtccFxOptions', () => {
  test('看涨 / 看跌认方向、千分位期权费、撤销行收 ID', () => {
    const csv = [
      COLS.map((c) => `"${c}"`).join(','),
      line(call),
      line({
        ...call,
        'Dissemination Identifier': '2',
        'Call currency': 'JPY',
        'Call amount': '380000000',
        'Put currency': 'USD',
        'Put amount': '3000000',
        'UPI FISN': 'NA/O Van Put JPY USD',
      }),
      line({ 'Action type': 'EROR', 'Original Dissemination Identifier': '9' }),
    ].join('\n');
    const d = parseDtccFxOptions(csv);
    expect(d.trades.map((t) => [t.id, t.call, t.usdNotional, t.premium])).toEqual([
      ['1', true, 10_000_000, 22_220],
      ['2', false, 3_000_000, 22_220],
    ]);
    expect(d.cancelled).toEqual(['9']);
  });

  test('障碍期权 / 非 NEWT / 名义封顶「+」/ 别的货币对 → 不收;缺列抛错', () => {
    const csv = [
      COLS.map((c) => `"${c}"`).join(','),
      line({ ...call, 'UPI FISN': 'NA/O Bar Call JPY USD' }),
      line({ ...call, 'Action type': 'TERM', 'Event type': 'EXER' }),
      line({ ...call, 'Call amount': '150000000+' }),
      line({ ...call, 'Strike price currency/currency pair': 'EUR/JPY' }),
    ].join('\n');
    expect(parseDtccFxOptions(csv).trades).toEqual([]);
    expect(() => parseDtccFxOptions('"Dissemination Identifier"\n')).toThrow('缺列');
  });
});
