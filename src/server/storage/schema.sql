-- 瘦身为"只剩期权"后,丢弃旧的行情/宏观表(本地库里可能还残留历史数据)。
-- IF EXISTS 保证幂等:首次 migrate 删除,之后为 no-op。
DROP TABLE IF EXISTS quote_eod;
DROP TABLE IF EXISTS macro_series;

-- VRP 计算的输入序列:VIX / ^GSPC / BTC-USD / DVOL(隐含腿 + 现货 RV 腿)。
-- 通用 (series_id, obs_date, value);RV、VRP 在读取时按窗口现算,不预存。
CREATE TABLE IF NOT EXISTS market_series (
    series_id   TEXT NOT NULL,
    obs_date    TEXT NOT NULL,
    value       REAL NOT NULL,
    fetched_at  TEXT NOT NULL,
    PRIMARY KEY (series_id, obs_date)
);
CREATE INDEX IF NOT EXISTS idx_market_series_date ON market_series(obs_date);

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

-- source:数据来源(moomoo / deribit)。普通列,作 provenance(记录实际跑的 fetcher),
-- 不进主键——今天一标的=一源,(underlying, snapshot_date) 已唯一。真要同标的多源
-- 交叉验证时,届时再做一次「source 进主键」的重建迁移。
CREATE TABLE IF NOT EXISTS option_snapshot_25delta (
    underlying       TEXT    NOT NULL,
    source           TEXT    NOT NULL,
    snapshot_date    TEXT    NOT NULL,
    call_iv          REAL    NOT NULL,
    put_iv           REAL    NOT NULL,
    skew             REAL    NOT NULL,
    fetched_at       TEXT    NOT NULL,
    PRIMARY KEY (underlying, snapshot_date)
);
CREATE INDEX IF NOT EXISTS idx_opt25_date ON option_snapshot_25delta(snapshot_date);

CREATE TABLE IF NOT EXISTS option_chain_raw (
    underlying       TEXT    NOT NULL,
    source           TEXT    NOT NULL,
    snapshot_date    TEXT    NOT NULL,
    expiry           TEXT    NOT NULL,
    underlying_price REAL,
    chain_json_gz    BLOB    NOT NULL,
    fetched_at       TEXT    NOT NULL,
    PRIMARY KEY (underlying, snapshot_date, expiry)
);
CREATE INDEX IF NOT EXISTS idx_opt_chain_date ON option_chain_raw(snapshot_date);
