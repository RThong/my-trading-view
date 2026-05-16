import type { Database } from 'bun:sqlite';
import type { QuoteBar } from '../../shared/types';

export type QuoteRow = {
  symbol: string;
  tradeDate: string;     // 'YYYY-MM-DD'
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  volume: number | null;
};

export function insertQuotes(db: Database, rows: QuoteRow[], source: string): void {
  if (rows.length === 0) return;
  const stmt = db.prepare(`
    INSERT INTO quote_eod (symbol, trade_date, open, high, low, close, volume, source, fetched_at)
    VALUES ($symbol, $date, $open, $high, $low, $close, $volume, $source, $fetched)
    ON CONFLICT(symbol, trade_date) DO UPDATE SET
      open=excluded.open, high=excluded.high, low=excluded.low,
      close=excluded.close, volume=excluded.volume,
      source=excluded.source, fetched_at=excluded.fetched_at
  `);
  const fetched = new Date().toISOString();
  const tx = db.transaction((batch: QuoteRow[]) => {
    for (const r of batch) {
      stmt.run({
        $symbol: r.symbol,
        $date: r.tradeDate,
        $open: r.open,
        $high: r.high,
        $low: r.low,
        $close: r.close,
        $volume: r.volume,
        $source: source,
        $fetched: fetched,
      });
    }
  });
  tx(rows);
}

export function getQuotes(db: Database, symbol: string, days: number): QuoteBar[] {
  const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  const rows = db.query(`
    SELECT trade_date AS date, open, high, low, close, volume
    FROM quote_eod
    WHERE symbol = $symbol AND trade_date >= $since
    ORDER BY trade_date ASC
  `).all({ $symbol: symbol, $since: since }) as QuoteBar[];
  return rows;
}

export function getLatestQuoteDate(db: Database, symbol: string): string | null {
  const row = db.query(`
    SELECT MAX(trade_date) AS d FROM quote_eod WHERE symbol = $symbol
  `).get({ $symbol: symbol }) as { d: string | null };
  return row?.d ?? null;
}
