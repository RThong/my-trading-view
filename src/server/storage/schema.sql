-- 瘦身为"只剩期权"后,丢弃旧的行情/宏观表(本地库里可能还残留历史数据)。
-- IF EXISTS 保证幂等:首次 migrate 删除,之后为 no-op。
DROP TABLE IF EXISTS quote_eod;
DROP TABLE IF EXISTS macro_series;

-- 波动率指数序列(VRP 的隐含腿):VIX/VXN/GVZ/OVX/DVOL。单值 (series_id, obs_date, value)。
-- 标的现货价不再放这(已挪到 price_eod);RV/VRP 读取时按窗口现算,不预存。
CREATE TABLE IF NOT EXISTS market_series (
    series_id   TEXT NOT NULL,
    obs_date    TEXT NOT NULL,
    value       REAL NOT NULL,
    fetched_at  TEXT NOT NULL,
    PRIMARY KEY (series_id, obs_date)
);
CREATE INDEX IF NOT EXISTS idx_market_series_date ON market_series(obs_date);

-- 标的日 OHLC:各 tab 的现货(SPY/QQQ/GLD/USO/TLT/BTC/VIX)。供前端现货蜡烛图,
-- 同时作 VRP 的 RV 腿来源(读 close)。source 记实际 fetcher(moomoo/deribit/yahoo/cboe)。
CREATE TABLE IF NOT EXISTS price_eod (
    underlying  TEXT NOT NULL,
    obs_date    TEXT NOT NULL,
    open        REAL,
    high        REAL,
    low         REAL,
    close       REAL NOT NULL,
    source      TEXT NOT NULL,
    fetched_at  TEXT NOT NULL,
    PRIMARY KEY (underlying, obs_date)
);
CREATE INDEX IF NOT EXISTS idx_price_eod_date ON price_eod(obs_date);

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

-- SEC XBRL 单季财务事实(AI 链基本面锚)。存**单季已差分值**而非原始 YTD 累计:
-- 差分/去重/tag 选择都是有损判断,把判断结果落库并带上 tag_used/accn/filed 三个溯源列,
-- 出错时能直接看出是哪个 tag、哪次申报进来的。派生量(TTM 毛利率/capex/FCF)另写 market_series。
-- 季频、滞后 4~8 周、会因重述回改 —— 只 upsert 不删,重述后同主键覆盖。
CREATE TABLE IF NOT EXISTS sec_fundamentals (
    ticker       TEXT NOT NULL,
    period_end   TEXT NOT NULL,      -- YYYY-MM-DD,财报期末
    concept      TEXT NOT NULL,      -- revenue | cogs | ocf | capex
    value        REAL NOT NULL,      -- 单季值(已差分),USD
    tag_used     TEXT NOT NULL,      -- 实际命中的 us-gaap tag
    form         TEXT NOT NULL,      -- 10-Q / 10-K
    accn         TEXT NOT NULL,      -- 申报号
    filed        TEXT NOT NULL,      -- 申报日,用于判重述
    fiscal_q     TEXT,               -- 日历季度,如 2026Q1
    fetched_at   TEXT NOT NULL,
    PRIMARY KEY (ticker, period_end, concept)
);
CREATE INDEX IF NOT EXISTS idx_sec_fundamentals_ticker ON sec_fundamentals(ticker);
