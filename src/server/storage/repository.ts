import type { Database } from 'bun:sqlite';
import type { QuoteBar, MacroPoint, JobStatus } from '../../shared/types';

export type Options25DeltaRow = {
  underlying: string;
  snapshotDate: string;
  callIv: number;
  putIv: number;
  skew: number;
  isMock: boolean;
};

export type QuoteRow = {
  symbol: string;
  tradeDate: string;     // 格式 'YYYY-MM-DD'
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

// ── job_run ───────────────────────────────────────────────────────────────────

export function startJobRun(db: Database, jobName: string): number {
  const result = db.run(
    `INSERT INTO job_run (job_name, started_at, status) VALUES (?, ?, 'running')`,
    [jobName, new Date().toISOString()],
  );
  return Number(result.lastInsertRowid);
}

type FinishParams =
  | { status: 'success' | 'partial'; recordsWritten: number; error?: string }
  | { status: 'failed'; error: string; recordsWritten?: number };

export function finishJobRun(db: Database, runId: number, params: FinishParams): void {
  db.run(
    `UPDATE job_run SET finished_at = ?, status = ?, records_written = ?, error_message = ? WHERE run_id = ?`,
    [
      new Date().toISOString(),
      params.status,
      params.recordsWritten ?? null,
      params.error ?? null,
      runId,
    ],
  );
}

export function insertOptions25Delta(db: Database, rows: Options25DeltaRow[]): void {
  if (rows.length === 0) return;
  const stmt = db.prepare(`
    INSERT INTO option_snapshot_25delta
      (underlying, snapshot_date, call_iv, put_iv, skew, is_mock, fetched_at)
    VALUES ($u, $d, $c, $p, $s, $m, $f)
    ON CONFLICT(underlying, snapshot_date) DO UPDATE SET
      call_iv=excluded.call_iv, put_iv=excluded.put_iv, skew=excluded.skew,
      is_mock=excluded.is_mock, fetched_at=excluded.fetched_at
  `);
  const fetched = new Date().toISOString();
  const tx = db.transaction((batch: Options25DeltaRow[]) => {
    for (const r of batch) {
      stmt.run({
        $u: r.underlying,
        $d: r.snapshotDate,
        $c: r.callIv,
        $p: r.putIv,
        $s: r.skew,
        $m: r.isMock ? 1 : 0,
        $f: fetched,
      });
    }
  });
  tx(rows);
}

export function getOptions25Delta(
  db: Database,
  underlying: string,
  days: number,
): Options25DeltaRow[] {
  const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  const rows = db.query(`
    SELECT underlying, snapshot_date, call_iv, put_iv, skew, is_mock
    FROM option_snapshot_25delta
    WHERE underlying = $u AND snapshot_date >= $since
    ORDER BY snapshot_date ASC
  `).all({ $u: underlying, $since: since }) as Array<{
    underlying: string;
    snapshot_date: string;
    call_iv: number;
    put_iv: number;
    skew: number;
    is_mock: number;
  }>;
  return rows.map(r => ({
    underlying: r.underlying,
    snapshotDate: r.snapshot_date,
    callIv: r.call_iv,
    putIv: r.put_iv,
    skew: r.skew,
    isMock: r.is_mock === 1,
  }));
}

export type OptionChainRawRow = {
  underlying: string;
  snapshotDate: string;
  expiry: string;
  underlyingPrice: number | null;
  chainJsonGz: Uint8Array;
};

export function insertOptionChainRaw(db: Database, rows: OptionChainRawRow[]): void {
  if (rows.length === 0) return;
  const stmt = db.prepare(`
    INSERT INTO option_chain_raw
      (underlying, snapshot_date, expiry, underlying_price, chain_json_gz, fetched_at)
    VALUES ($u, $d, $e, $price, $gz, $f)
    ON CONFLICT(underlying, snapshot_date, expiry) DO UPDATE SET
      underlying_price = excluded.underlying_price,
      chain_json_gz    = excluded.chain_json_gz,
      fetched_at       = excluded.fetched_at
  `);
  const fetched = new Date().toISOString();
  const tx = db.transaction((batch: OptionChainRawRow[]) => {
    for (const r of batch) {
      stmt.run({
        $u: r.underlying,
        $d: r.snapshotDate,
        $e: r.expiry,
        $price: r.underlyingPrice,
        $gz: r.chainJsonGz,
        $f: fetched,
      });
    }
  });
  tx(rows);
}

export function getJobHealth(db: Database): JobStatus[] {
  const rows = db.query(`
    SELECT job_name AS name, status, finished_at, error_message,
           (SELECT MAX(finished_at) FROM job_run jr2
            WHERE jr2.job_name = jr.job_name AND jr2.status = 'success') AS last_success_at
    FROM job_run jr
    WHERE run_id = (SELECT MAX(run_id) FROM job_run jr3 WHERE jr3.job_name = jr.job_name AND jr3.finished_at IS NOT NULL)
    ORDER BY name
  `).all() as Array<{
    name: string;
    status: 'success' | 'partial' | 'failed' | 'running';
    finished_at: string | null;
    error_message: string | null;
    last_success_at: string | null;
  }>;

  return rows.map(r => ({
    name: r.name,
    status: r.status as JobStatus['status'],
    lastRunAt: r.finished_at,
    lastSuccessAt: r.last_success_at,
    error: r.error_message,
  }));
}
