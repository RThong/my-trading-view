CREATE TABLE IF NOT EXISTS quote_eod (
    symbol         TEXT    NOT NULL,
    trade_date     TEXT    NOT NULL,
    open           REAL,
    high           REAL,
    low            REAL,
    close          REAL    NOT NULL,
    volume         INTEGER,
    source         TEXT    NOT NULL,
    fetched_at     TEXT    NOT NULL,
    PRIMARY KEY (symbol, trade_date)
);
CREATE INDEX IF NOT EXISTS idx_quote_date ON quote_eod(trade_date);

CREATE TABLE IF NOT EXISTS macro_series (
    series_id      TEXT    NOT NULL,
    obs_date       TEXT    NOT NULL,
    value          REAL    NOT NULL,
    fetched_at     TEXT    NOT NULL,
    PRIMARY KEY (series_id, obs_date)
);
CREATE INDEX IF NOT EXISTS idx_macro_date ON macro_series(obs_date);

CREATE TABLE IF NOT EXISTS job_run (
    run_id            INTEGER PRIMARY KEY AUTOINCREMENT,
    job_name          TEXT      NOT NULL,
    started_at        TEXT      NOT NULL,
    finished_at       TEXT,
    status            TEXT      NOT NULL,
    records_written   INTEGER,
    error_message     TEXT
);
CREATE INDEX IF NOT EXISTS idx_job_run_started ON job_run(started_at);

CREATE TABLE IF NOT EXISTS schema_version (
    version       INTEGER PRIMARY KEY,
    applied_at    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS option_snapshot_25delta (
    underlying       TEXT    NOT NULL,
    snapshot_date    TEXT    NOT NULL,
    call_iv          REAL    NOT NULL,
    put_iv           REAL    NOT NULL,
    skew             REAL    NOT NULL,
    is_mock          INTEGER NOT NULL DEFAULT 0,
    fetched_at       TEXT    NOT NULL,
    PRIMARY KEY (underlying, snapshot_date)
);
CREATE INDEX IF NOT EXISTS idx_opt25_date ON option_snapshot_25delta(snapshot_date);

CREATE TABLE IF NOT EXISTS option_chain_raw (
    underlying       TEXT    NOT NULL,
    snapshot_date    TEXT    NOT NULL,
    expiry           TEXT    NOT NULL,
    underlying_price REAL,
    chain_json_gz    BLOB    NOT NULL,
    fetched_at       TEXT    NOT NULL,
    PRIMARY KEY (underlying, snapshot_date, expiry)
);
CREATE INDEX IF NOT EXISTS idx_opt_chain_date ON option_chain_raw(snapshot_date);
