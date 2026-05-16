import { describe, test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate } from './db';
import {
  insertQuotes,
  getQuotes,
  getLatestQuoteDate,
  type QuoteRow,
} from './repository';

function freshDb(): Database {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}

describe('repository: quote_eod', () => {
  let db: Database;
  beforeEach(() => { db = freshDb(); });

  test('insertQuotes then getQuotes returns ascending by date', () => {
    const rows: QuoteRow[] = [
      { symbol: 'TEST', tradeDate: '2026-05-10', open: 1, high: 2, low: 0.5, close: 1.5, volume: 1000 },
      { symbol: 'TEST', tradeDate: '2026-05-11', open: 1.5, high: 2.5, low: 1, close: 2, volume: 1100 },
    ];
    insertQuotes(db, rows, 'yahoo');
    const out = getQuotes(db, 'TEST', 30);
    expect(out).toHaveLength(2);
    expect(out[0].date).toBe('2026-05-10');
    expect(out[1].close).toBe(2);
  });

  test('insertQuotes is idempotent on (symbol, date)', () => {
    const row: QuoteRow = { symbol: 'TEST', tradeDate: '2026-05-10', open: 1, high: 2, low: 0.5, close: 1.5, volume: 1000 };
    insertQuotes(db, [row], 'yahoo');
    insertQuotes(db, [{ ...row, close: 99 }], 'yahoo');
    const out = getQuotes(db, 'TEST', 30);
    expect(out).toHaveLength(1);
    expect(out[0].close).toBe(99);
  });

  test('getLatestQuoteDate returns null when empty', () => {
    expect(getLatestQuoteDate(db, 'TEST')).toBeNull();
  });

  test('getLatestQuoteDate returns max date', () => {
    insertQuotes(db, [
      { symbol: 'TEST', tradeDate: '2026-05-10', open: 1, high: 2, low: 0.5, close: 1.5, volume: 1000 },
      { symbol: 'TEST', tradeDate: '2026-05-12', open: 1, high: 2, low: 0.5, close: 1.5, volume: 1000 },
      { symbol: 'TEST', tradeDate: '2026-05-11', open: 1, high: 2, low: 0.5, close: 1.5, volume: 1000 },
    ], 'yahoo');
    expect(getLatestQuoteDate(db, 'TEST')).toBe('2026-05-12');
  });
});
