import { describe, test, expect } from 'bun:test';
import { parseCboeIndexCsv } from './cboeIndex';

describe('parseCboeIndexCsv', () => {
  test('parses OHLC CSV (VIX style)', () => {
    const csv =
      'DATE,OPEN,HIGH,LOW,CLOSE\n' +
      '01/02/1990,17.240000,17.240000,17.240000,17.240000\n' +
      '01/03/1990,18.190000,18.190000,18.190000,18.190000\n';
    const rows = parseCboeIndexCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      tradeDate: '1990-01-02',
      open: 17.24, high: 17.24, low: 17.24, close: 17.24,
    });
    expect(rows[1].close).toBeCloseTo(18.19);
  });

  test('parses single-value CSV (SKEW / RXM style)', () => {
    const csv =
      'DATE,SKEW\n' +
      '01/02/1990,126.090000\n' +
      '01/03/1990,123.340000\n';
    const rows = parseCboeIndexCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      tradeDate: '1990-01-02',
      open: null, high: null, low: null, close: 126.09,
    });
  });

  test('skips malformed dates', () => {
    const csv =
      'DATE,SKEW\n' +
      '01/02/1990,126.090000\n' +
      'BAD-DATE,123.0\n' +
      '01/04/1990,124.0\n';
    const rows = parseCboeIndexCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.tradeDate)).toEqual(['1990-01-02', '1990-01-04']);
  });

  test('skips rows with non-numeric close', () => {
    const csv =
      'DATE,SKEW\n' +
      '01/02/1990,not-a-number\n' +
      '01/03/1990,123.45\n';
    const rows = parseCboeIndexCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].close).toBe(123.45);
  });

  test('handles CRLF line endings', () => {
    const csv = 'DATE,SKEW\r\n01/02/1990,126.09\r\n';
    expect(parseCboeIndexCsv(csv)).toHaveLength(1);
  });

  test('returns empty for malformed input', () => {
    expect(parseCboeIndexCsv('')).toEqual([]);
    expect(parseCboeIndexCsv('only one line')).toEqual([]);
  });
});
