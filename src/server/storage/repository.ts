import type { Database } from 'bun:sqlite';
import type { QuoteBar, MacroPoint } from '../../shared/types';

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

// ── macro_series ─────────────────────────────────────────────────────────────

export type MacroRow = {
  seriesId: string;
  obsDate: string;
  value: number;
};

export function insertMacro(db: Database, rows: MacroRow[]): void {
  if (rows.length === 0) return;
  const stmt = db.prepare(`
    INSERT INTO macro_series (series_id, obs_date, value, fetched_at)
    VALUES ($id, $date, $value, $fetched)
    ON CONFLICT(series_id, obs_date) DO UPDATE SET
      value=excluded.value, fetched_at=excluded.fetched_at
  `);
  const fetched = new Date().toISOString();
  const tx = db.transaction((batch: MacroRow[]) => {
    for (const r of batch) {
      stmt.run({ $id: r.seriesId, $date: r.obsDate, $value: r.value, $fetched: fetched });
    }
  });
  tx(rows);
}

export function getMacroSeries(db: Database, seriesId: string, days: number): MacroPoint[] {
  const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  return db.query(`
    SELECT obs_date AS date, value
    FROM macro_series
    WHERE series_id = $id AND obs_date >= $since
    ORDER BY obs_date ASC
  `).all({ $id: seriesId, $since: since }) as MacroPoint[];
}

export function getLatestMacroDate(db: Database, seriesId: string): string | null {
  const row = db.query(`
    SELECT MAX(obs_date) AS d FROM macro_series WHERE series_id = $id
  `).get({ $id: seriesId }) as { d: string | null };
  return row?.d ?? null;
}
