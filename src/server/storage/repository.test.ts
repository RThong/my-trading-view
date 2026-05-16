import { describe, test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate } from './db';
import {
  insertQuotes,
  getQuotes,
  getLatestQuoteDate,
  insertMacro,
  getMacroSeries,
  getLatestMacroDate,
  startJobRun,
  finishJobRun,
  getJobHealth,
  type QuoteRow,
  type MacroRow,
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

describe('repository: macro_series', () => {
  let db: Database;
  beforeEach(() => { db = freshDb(); });

  test('insertMacro then getMacroSeries returns ascending', () => {
    const rows: MacroRow[] = [
      { seriesId: 'DGS10', obsDate: '2026-05-10', value: 4.20 },
      { seriesId: 'DGS10', obsDate: '2026-05-11', value: 4.25 },
    ];
    insertMacro(db, rows);
    const out = getMacroSeries(db, 'DGS10', 30);
    expect(out).toHaveLength(2);
    expect(out[0].value).toBe(4.20);
  });

  test('insertMacro is idempotent', () => {
    insertMacro(db, [{ seriesId: 'DGS10', obsDate: '2026-05-10', value: 4.20 }]);
    insertMacro(db, [{ seriesId: 'DGS10', obsDate: '2026-05-10', value: 4.99 }]);
    const out = getMacroSeries(db, 'DGS10', 30);
    expect(out).toHaveLength(1);
    expect(out[0].value).toBe(4.99);
  });

  test('getLatestMacroDate returns null when empty', () => {
    expect(getLatestMacroDate(db, 'DGS10')).toBeNull();
  });
});

describe('repository: job_run', () => {
  let db: Database;
  beforeEach(() => { db = freshDb(); });

  test('startJobRun returns id, finishJobRun marks success', () => {
    const id = startJobRun(db, 'quotes');
    finishJobRun(db, id, { status: 'success', recordsWritten: 42 });
    const health = getJobHealth(db);
    const quotes = health.find(j => j.name === 'quotes')!;
    expect(quotes.status).toBe('success');
    expect(quotes.error).toBeNull();
    expect(quotes.lastSuccessAt).not.toBeNull();
  });

  test('failed run does not update lastSuccessAt', () => {
    const id1 = startJobRun(db, 'quotes');
    finishJobRun(db, id1, { status: 'success', recordsWritten: 10 });
    const successAt = getJobHealth(db).find(j => j.name === 'quotes')!.lastSuccessAt;

    const id2 = startJobRun(db, 'quotes');
    finishJobRun(db, id2, { status: 'failed', error: 'boom' });

    const after = getJobHealth(db).find(j => j.name === 'quotes')!;
    expect(after.status).toBe('failed');
    expect(after.error).toBe('boom');
    expect(after.lastSuccessAt).toBe(successAt);
  });
});
