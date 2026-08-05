import type { Database } from 'bun:sqlite';
import type { JobStatus } from '../../shared/types';
import type { SecLag } from '../../shared/secCompanies';

// bun:sqlite 的具名参数值域(标量,非递归),与其 SQLQueryBindings 的 Record 分支一致。
type NamedParams = Record<string, string | bigint | NodeJS.TypedArray | number | boolean | null>;

export type Options25DeltaRow = {
  underlying: string;
  source: string; // 'moomoo' | 'deribit'(provenance,不进主键)
  snapshotDate: string;
  callIv: number;
  putIv: number;
  skew: number;
};

// QuoteRow / MacroRow:数据源 fetcher 的返回类型,保留备用(非期权抓取逻辑暂留)。
export type QuoteRow = {
  symbol: string;
  tradeDate: string; // 格式 'YYYY-MM-DD'
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  volume: number | null;
};

export type MacroRow = {
  seriesId: string;
  obsDate: string;
  value: number;
};

// ── market_series(VRP 输入:隐含 VIX/VXN/GVZ/OVX/DVOL + RV 现货 SPX/NDX/GLD/USO/BTC)──

export type MarketSeriesRow = { seriesId: string; obsDate: string; value: number };

/** 批量 upsert 骨架:空跳过、prepare 一次、同批共用一个 fetched_at、单事务逐行写。
 *  各表只提供 SQL 与「行 → 具名参数」绑定;重复的事务/时间戳样板收敛在此。 */
function bulkUpsert<T>(db: Database, sql: string, rows: T[], bind: (row: T, fetched: string) => NamedParams): void {
  if (rows.length === 0) return;
  const stmt = db.prepare<unknown, [NamedParams]>(sql);
  const fetched = new Date().toISOString();
  db.transaction((batch: T[]) => {
    for (const r of batch) stmt.run(bind(r, fetched)); // 逐行写库,副作用循环保留
  })(rows);
}

export function insertMarketSeries(db: Database, rows: MarketSeriesRow[]): void {
  bulkUpsert(
    db,
    `
    INSERT INTO market_series (series_id, obs_date, value, fetched_at)
    VALUES ($id, $date, $value, $fetched)
    ON CONFLICT(series_id, obs_date) DO UPDATE SET value=excluded.value, fetched_at=excluded.fetched_at
  `,
    rows,
    (r, f) => ({ $id: r.seriesId, $date: r.obsDate, $value: r.value, $fetched: f }),
  );
}

export function getMarketSeries(db: Database, seriesId: string): Array<{ date: string; value: number }> {
  return db
    .query(`
    SELECT obs_date AS date, value FROM market_series WHERE series_id = $id ORDER BY obs_date ASC
  `)
    .all({ $id: seriesId }) as Array<{ date: string; value: number }>;
}

export function getLatestMarketDate(db: Database, seriesId: string): string | null {
  const row = db.query(`SELECT MAX(obs_date) AS d FROM market_series WHERE series_id = $id`).get({ $id: seriesId }) as {
    d: string | null;
  };
  return row?.d ?? null;
}

// ── price_eod(标的日 OHLC:现货蜡烛图 + VRP 的 RV 腿来源)──────────────────────

export type PriceEodRow = {
  underlying: string;
  obsDate: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  source: string;
};

export function insertPriceEod(db: Database, rows: PriceEodRow[]): void {
  bulkUpsert(
    db,
    `
    INSERT INTO price_eod (underlying, obs_date, open, high, low, close, source, fetched_at)
    VALUES ($u, $d, $o, $h, $l, $c, $src, $f)
    ON CONFLICT(underlying, obs_date) DO UPDATE SET
      open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close,
      source=excluded.source, fetched_at=excluded.fetched_at
  `,
    rows,
    (r, f) => ({
      $u: r.underlying,
      $d: r.obsDate,
      $o: r.open,
      $h: r.high,
      $l: r.low,
      $c: r.close,
      $src: r.source,
      $f: f,
    }),
  );
}

/** 现货蜡烛图用:OHLC bars,升序。 */
export function getPriceBars(
  db: Database,
  underlying: string,
): Array<{ date: string; open: number | null; high: number | null; low: number | null; close: number }> {
  return db
    .query(`
    SELECT obs_date AS date, open, high, low, close FROM price_eod WHERE underlying = $u ORDER BY obs_date ASC
  `)
    .all({ $u: underlying }) as Array<{
    date: string;
    open: number | null;
    high: number | null;
    low: number | null;
    close: number;
  }>;
}

export function getLatestPriceDate(db: Database, underlying: string): string | null {
  const row = db.query(`SELECT MAX(obs_date) AS d FROM price_eod WHERE underlying = $u`).get({ $u: underlying }) as {
    d: string | null;
  };
  return row?.d ?? null;
}

// ── job_run ───────────────────────────────────────────────────────────────────

export function startJobRun(db: Database, jobName: string): number {
  const result = db.run(`INSERT INTO job_run (job_name, started_at, status) VALUES (?, ?, 'running')`, [
    jobName,
    new Date().toISOString(),
  ]);
  return Number(result.lastInsertRowid);
}

export type FinishParams =
  | { status: 'success' | 'partial'; recordsWritten: number; error?: string }
  | { status: 'failed'; error: string; recordsWritten?: number };

export function finishJobRun(db: Database, runId: number, params: FinishParams): void {
  db.run(`UPDATE job_run SET finished_at = ?, status = ?, records_written = ?, error_message = ? WHERE run_id = ?`, [
    new Date().toISOString(),
    params.status,
    params.recordsWritten ?? null,
    params.error ?? null,
    runId,
  ]);
}

/**
 * 今天(本地日)已成功(status='success')的 job 名列表,去重。
 * 「当天 4 组全部成功就跳过后续运行」守卫用:started_at 存 UTC ISO,
 * 按 localtime 折算成本地日再和「今天」比较,只认 success(failed/partial 不算)。
 */
export function getTodaySucceededJobs(db: Database): string[] {
  const rows = db
    .query(
      `SELECT DISTINCT job_name FROM job_run
     WHERE status = 'success' AND date(started_at, 'localtime') = date('now', 'localtime')`,
    )
    .all() as Array<{ job_name: string }>;
  return rows.map((r) => r.job_name);
}

export function insertOptions25Delta(db: Database, rows: Options25DeltaRow[]): void {
  bulkUpsert(
    db,
    `
    INSERT INTO option_snapshot_25delta
      (underlying, source, snapshot_date, call_iv, put_iv, skew, fetched_at)
    VALUES ($u, $src, $d, $c, $p, $s, $f)
    ON CONFLICT(underlying, snapshot_date) DO UPDATE SET
      source=excluded.source, call_iv=excluded.call_iv, put_iv=excluded.put_iv, skew=excluded.skew,
      fetched_at=excluded.fetched_at
  `,
    rows,
    (r, f) => ({ $u: r.underlying, $src: r.source, $d: r.snapshotDate, $c: r.callIv, $p: r.putIv, $s: r.skew, $f: f }),
  );
}

export function getOptions25Delta(db: Database, underlying: string, days: number): Options25DeltaRow[] {
  const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);

  // 每 (underlying, snapshot_date) 唯一,source 只是 provenance,故按 underlying 取即可。
  const rows = db
    .query(`
    SELECT underlying, source, snapshot_date, call_iv, put_iv, skew
    FROM option_snapshot_25delta
    WHERE underlying = $u AND snapshot_date >= $since
    ORDER BY snapshot_date ASC
  `)
    .all({ $u: underlying, $since: since }) as Array<{
    underlying: string;
    source: string;
    snapshot_date: string;
    call_iv: number;
    put_iv: number;
    skew: number;
  }>;
  return rows.map((r) => ({
    underlying: r.underlying,
    source: r.source,
    snapshotDate: r.snapshot_date,
    callIv: r.call_iv,
    putIv: r.put_iv,
    skew: r.skew,
  }));
}

export type OptionChainRawRow = {
  underlying: string;
  source: string; // 'moomoo' | 'deribit'
  snapshotDate: string;
  expiry: string;
  underlyingPrice: number | null;
  chainJsonGz: Uint8Array;
};

export function insertOptionChainRaw(db: Database, rows: OptionChainRawRow[]): void {
  bulkUpsert(
    db,
    `
    INSERT INTO option_chain_raw
      (underlying, source, snapshot_date, expiry, underlying_price, chain_json_gz, fetched_at)
    VALUES ($u, $src, $d, $e, $price, $gz, $f)
    ON CONFLICT(underlying, snapshot_date, expiry) DO UPDATE SET
      source           = excluded.source,
      underlying_price = excluded.underlying_price,
      chain_json_gz    = excluded.chain_json_gz,
      fetched_at       = excluded.fetched_at
  `,
    rows,
    (r, f) => ({
      $u: r.underlying,
      $src: r.source,
      $d: r.snapshotDate,
      $e: r.expiry,
      $price: r.underlyingPrice,
      $gz: r.chainJsonGz,
      $f: f,
    }),
  );
}

// ── sec_fundamentals(SEC XBRL 单季财务事实)─────────────────────────────────

export type SecFundamentalRow = {
  ticker: string;
  periodEnd: string;
  concept: string; // 'revenue' | 'cogs' | 'ocf' | 'capex'
  value: number; // 单季值(已差分),USD
  tagUsed: string;
  form: string;
  accn: string;
  filed: string;
  fiscalQ: string;
};

export function insertSecFundamentals(db: Database, rows: SecFundamentalRow[]): void {
  bulkUpsert(
    db,
    `
    INSERT INTO sec_fundamentals
      (ticker, period_end, concept, value, tag_used, form, accn, filed, fiscal_q, fetched_at)
    VALUES ($t, $pe, $c, $v, $tag, $form, $accn, $filed, $fq, $f)
    ON CONFLICT(ticker, period_end, concept) DO UPDATE SET
      value=excluded.value, tag_used=excluded.tag_used, form=excluded.form, accn=excluded.accn,
      filed=excluded.filed, fiscal_q=excluded.fiscal_q, fetched_at=excluded.fetched_at
  `,
    rows,
    (r, f) => ({
      $t: r.ticker,
      $pe: r.periodEnd,
      $c: r.concept,
      $v: r.value,
      $tag: r.tagUsed,
      $form: r.form,
      $accn: r.accn,
      $filed: r.filed,
      $fq: r.fiscalQ,
      $f: f,
    }),
  );
}

export function getSecFundamentals(db: Database, ticker: string): SecFundamentalRow[] {
  const rows = db
    .query(`
    SELECT ticker, period_end, concept, value, tag_used, form, accn, filed, fiscal_q
    FROM sec_fundamentals WHERE ticker = $t ORDER BY period_end ASC
  `)
    .all({ $t: ticker }) as Array<{
    ticker: string;
    period_end: string;
    concept: string;
    value: number;
    tag_used: string;
    form: string;
    accn: string;
    filed: string;
    fiscal_q: string;
  }>;

  return rows.map((r) => ({
    ticker: r.ticker,
    periodEnd: r.period_end,
    concept: r.concept,
    value: r.value,
    tagUsed: r.tag_used,
    form: r.form,
    accn: r.accn,
    filed: r.filed,
    fiscalQ: r.fiscal_q,
  }));
}

/** 按前缀取一族序列(SEC 派生量比对用:算出来的和库里的一致就整轮不写)。
 *  前缀里的 `_` / `%` 会被 LIKE 当通配符,故统一转义后再匹配。 */
export function getMarketSeriesByPrefix(db: Database, prefix: string): MarketSeriesRow[] {
  const escaped = prefix.replace(/[\\_%]/g, (ch) => `\\${ch}`);
  const rows = db
    .query(`
    SELECT series_id, obs_date, value FROM market_series
    WHERE series_id LIKE $p ESCAPE '\\' ORDER BY series_id, obs_date
  `)
    .all({ $p: `${escaped}%` }) as Array<{ series_id: string; obs_date: string; value: number }>;

  return rows.map((r) => ({ seriesId: r.series_id, obsDate: r.obs_date, value: r.value }));
}

/** 本地已知的最新申报日;与 SEC submissions 比对,决定要不要拉几 MB 的 companyfacts。 */
export function getLatestSecFiled(db: Database, ticker: string): string | null {
  const row = db.query(`SELECT MAX(filed) AS d FROM sec_fundamentals WHERE ticker = $t`).get({ $t: ticker }) as {
    d: string | null;
  };
  return row?.d ?? null;
}

export function putSecWatermark(db: Database, ticker: string, remoteFiled: string): void {
  db.run(
    `INSERT INTO sec_watermark (ticker, remote_filed, checked_at) VALUES (?, ?, ?)
     ON CONFLICT(ticker) DO UPDATE SET remote_filed = excluded.remote_filed, checked_at = excluded.checked_at`,
    [ticker, remoteFiled, new Date().toISOString()],
  );
}

/**
 * 远端已有更新申报、但我们库里还没有那一期的公司。用 filed 比而非 period_end 比 ——
 * 各家财年季末天然错开,期末日期差不构成判据(见 schema.sql 的 sec_watermark 注释)。
 * 只返回落后的那几家:没落后的不需要在面板上说什么。
 */
export function getSecLag(db: Database): SecLag[] {
  const rows = db
    .query(`
    SELECT w.ticker, w.remote_filed, MAX(f.filed) AS local_filed, MAX(f.period_end) AS latest_period_end
    FROM sec_watermark w LEFT JOIN sec_fundamentals f ON f.ticker = w.ticker
    GROUP BY w.ticker
    HAVING local_filed IS NULL OR w.remote_filed > local_filed
    ORDER BY w.ticker
  `)
    .all() as Array<{
    ticker: string;
    remote_filed: string;
    local_filed: string | null;
    latest_period_end: string | null;
  }>;

  return rows.map((r) => ({
    ticker: r.ticker,
    remoteFiled: r.remote_filed,
    localFiled: r.local_filed,
    latestPeriodEnd: r.latest_period_end,
  }));
}

export function getJobHealth(db: Database): JobStatus[] {
  // 取每个 job 的「最新一条」run —— 不再过滤 finished_at IS NOT NULL,
  // 否则正在 running(含卡死)的最新 run 会被隐藏,状态灯还亮着上次的 success。
  // last_success_at 仍单独取最近一次 success,保留「上次绿是什么时候」。
  const rows = db
    .query(`
    SELECT job_name AS name, status, finished_at, error_message,
           (SELECT MAX(finished_at) FROM job_run jr2
            WHERE jr2.job_name = jr.job_name AND jr2.status = 'success') AS last_success_at
    FROM job_run jr
    WHERE run_id = (SELECT MAX(run_id) FROM job_run jr3 WHERE jr3.job_name = jr.job_name)
    ORDER BY name
  `)
    .all() as Array<{
    name: string;
    status: 'success' | 'partial' | 'failed' | 'running';
    finished_at: string | null;
    error_message: string | null;
    last_success_at: string | null;
  }>;

  return rows.map((r) => ({
    name: r.name,
    status: r.status as JobStatus['status'],
    lastRunAt: r.finished_at,
    lastSuccessAt: r.last_success_at,
    error: r.error_message,
  }));
}
