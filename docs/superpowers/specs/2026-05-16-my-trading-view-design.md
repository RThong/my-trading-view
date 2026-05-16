# my-trading-view — Design Spec

**Date**: 2026-05-16
**Status**: Phase 1 design approved (pending user re-review of this doc)
**Owner**: hong (personal use)

## 1. Goal & Scope

A personal, local-only market state dashboard. Pulls a curated set of indicators every day after the US close and renders them as a multi-panel web dashboard. Long-term unique value is the **SPY 25-delta one-month options** snapshot, which TradingView does not surface. Phase 1 ships the platform skeleton plus all the "easy" indicators; Phase 2 (separate spec) adds the options panel.

### Phase 1 — In scope

- Project skeleton (fetchers, storage, API, web all wired together)
- Daily EOD data collection from `yahoo-finance2` and FRED
- SQLite storage with ~6 months of initial history, growing daily
- Hono HTTP API exposing time-series JSON
- React dashboard with 4 chart panels (volatility / macro / indices / assets)
- macOS launchd job scheduling
- Job health indicator in the UI top bar

### Phase 1 — Out of scope (deferred to Phase 2)

- SPY option chain fetching
- Black-Scholes / Greeks computation
- 25-delta strike selection
- Options-related charts

### Out of scope entirely (YAGNI)

- Real-time / intraday quotes
- Order placement, brokerage integration
- Multi-user, authentication
- Public deployment, cloud hosting
- Sentiment indicators (Put/Call ratio, COT)
- Strategy backtesting
- Alerting / notifications

## 2. Indicators (Phase 1)

| Group | Items | Source |
|---|---|---|
| Volatility | `^VIX`, `^VIX9D`, `^VIX3M`, `^VVIX`, `^SKEW` | yahoo-finance2 |
| Indices | `^GSPC` (S&P 500), `QQQ`, `IWM` | yahoo-finance2 |
| Other assets | `GLD`, `TLT`, `BTC-USD` | yahoo-finance2 |
| Macro / rates | `DGS10`, `DGS2`, `DGS3MO`, `DTWEXBGS` (DXY proxy) | FRED |

History window: 6 months on first run, then daily incremental.

## 3. Tech Stack

```
Runtime:    Bun
Language:   TypeScript (frontend + backend)
DB:         bun:sqlite (built into Bun)
HTTP:       Hono (typed routes; hc client on the web side)
Frontend:   React 18 + Vite + Tailwind CSS + Lightweight Charts
Data libs:  yahoo-finance2 (npm), FRED via plain fetch
Scheduler:  macOS launchd
```

**Rationale**: User is a frontend developer. Unifying on TypeScript end-to-end removes language switching and lets backend route types flow to the frontend via Hono's `hc` client. Bun is chosen over Node for built-in SQLite, faster startup, and zero-config TS execution.

## 4. Project Layout

```
my-trading-view/
├── package.json
├── tsconfig.json
├── bunfig.toml
├── .env                            # FRED_API_KEY=...
├── data/
│   └── mtv.db                      # SQLite file
├── docs/superpowers/specs/         # design specs (this file lives here)
├── src/
│   ├── shared/
│   │   └── types.ts                # frontend/backend shared types
│   ├── server/
│   │   ├── index.ts                # Hono entry, exports AppType
│   │   ├── routes/
│   │   │   ├── quotes.ts
│   │   │   ├── macro.ts
│   │   │   ├── catalog.ts
│   │   │   └── health.ts
│   │   ├── fetchers/
│   │   │   ├── yahoo.ts
│   │   │   └── fred.ts
│   │   ├── storage/
│   │   │   ├── db.ts               # connection + migrations
│   │   │   ├── schema.sql
│   │   │   └── repository.ts
│   │   └── jobs/
│   │       └── daily.ts
│   └── web/
│       ├── index.html
│       ├── main.tsx
│       ├── App.tsx
│       ├── components/             # Header, ChartPanel, StatusLight
│       ├── panels/                 # VolatilityPanel, MacroPanel, IndicesPanel, AssetsPanel
│       ├── api/client.ts           # hc<AppType>(...)
│       ├── hooks/useChartData.ts
│       └── styles.css
├── launchd/
│   └── com.user.mtv.daily.plist
└── scripts/
    └── install-launchd.sh
```

### Module responsibilities

| Module | Does | Does NOT |
|---|---|---|
| `fetchers/` | Call external APIs, return normalized records | Touch DB, run business logic |
| `storage/` | SQLite read/write, schema migrations | Call external APIs, transform data |
| `routes/` | Map HTTP → repository reads, return JSON | Fetch from external sources |
| `jobs/daily.ts` | Orchestrate one daily run | Call external APIs directly (uses fetchers) |
| `web/panels/` | Render one chart family with shared time range | Know about backend storage |

## 5. Storage Schema

SQLite, single file at `data/mtv.db`. Long-format tables (one row per observation).

```sql
CREATE TABLE quote_eod (
    symbol         TEXT    NOT NULL,
    trade_date     DATE    NOT NULL,
    open           REAL,
    high           REAL,
    low            REAL,
    close          REAL    NOT NULL,
    volume         INTEGER,
    source         TEXT    NOT NULL,
    fetched_at     TIMESTAMP NOT NULL,
    PRIMARY KEY (symbol, trade_date)
);
CREATE INDEX idx_quote_date ON quote_eod(trade_date);

CREATE TABLE macro_series (
    series_id      TEXT    NOT NULL,
    obs_date       DATE    NOT NULL,
    value          REAL    NOT NULL,
    fetched_at     TIMESTAMP NOT NULL,
    PRIMARY KEY (series_id, obs_date)
);
CREATE INDEX idx_macro_date ON macro_series(obs_date);

CREATE TABLE job_run (
    run_id            INTEGER PRIMARY KEY AUTOINCREMENT,
    job_name          TEXT      NOT NULL,
    started_at        TIMESTAMP NOT NULL,
    finished_at       TIMESTAMP,
    status            TEXT      NOT NULL,   -- 'success' | 'partial' | 'failed'
    records_written   INTEGER,
    error_message     TEXT
);
CREATE INDEX idx_job_run_started ON job_run(started_at);

CREATE TABLE schema_version (
    version       INTEGER PRIMARY KEY,
    applied_at    TIMESTAMP NOT NULL
);
```

Phase 2 will add `option_snapshot_25delta` and `option_chain_raw` via a new migration.

### Storage size estimate (1 year)

- `quote_eod`: ~12 symbols × 365 rows ≈ 4.4K rows
- `macro_series`: 4 series × 365 rows ≈ 1.5K rows
- `job_run`: ~4 jobs × 365 days ≈ 1.5K rows
- Total << 5 MB. SQLite is comfortable.

## 6. API

Backend exports `AppType` from `src/server/index.ts`; frontend imports it as a type only via `hc<AppType>`. All endpoints are `GET` and return JSON.

```ts
// src/shared/types.ts
export type QuoteBar = {
  date: string;        // 'YYYY-MM-DD'
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  volume: number | null;
};

export type MacroPoint = {
  date: string;
  value: number;
};

export type JobStatus = {
  name: string;
  status: 'success' | 'partial' | 'failed';
  lastSuccessAt: string | null;
  lastRunAt: string | null;
  error: string | null;
};

export type HealthResponse = {
  jobs: JobStatus[];
};

export type CatalogResponse = {
  quotes: Array<{
    symbol: string;
    label: string;
    group: 'volatility' | 'index' | 'asset';
  }>;
  macro: Array<{
    id: string;
    label: string;
    unit: string;
  }>;
};
```

### Endpoints

| Method + Path | Returns |
|---|---|
| `GET /api/quotes/:symbol?days=180` | `QuoteBar[]` |
| `GET /api/macro/:seriesId?days=180` | `MacroPoint[]` |
| `GET /api/catalog` | `CatalogResponse` |
| `GET /api/health` | `HealthResponse` |

`days` defaults to 180, max 1825 (5 years).

The frontend's typed client wraps these:
```ts
// src/web/api/client.ts
import { hc } from 'hono/client';
import type { AppType } from '../../server';
export const api = hc<AppType>(import.meta.env.VITE_API_BASE ?? '');
```

## 7. Frontend Layout

Single page. Top bar with status light and global time-range selector; below it a 2×2 grid of chart panels. Phase 2 will add a 5th panel spanning a new row.

```
┌─────────────────────────────────────────────────────────────┐
│ ● Status   My Trading View      [90D 180D 1Y All]  [Theme]  │
├──────────────────────────────────┬──────────────────────────┤
│ Volatility                       │ Macro / Rates            │
│ VIX  VIX9D  VIX3M  VVIX  SKEW    │ UST10Y  UST2Y  3M  DXY   │
├──────────────────────────────────┼──────────────────────────┤
│ Indices                          │ Other Assets             │
│ S&P 500  QQQ  IWM                │ GLD  TLT  BTC            │
└──────────────────────────────────┴──────────────────────────┘
```

### Behaviour

- Global `days` state in `App.tsx`, passed to all panels; changing the range refetches.
- Each panel renders one Lightweight Charts instance with multiple overlaid line series, one per symbol.
- Time axes are synchronized within a panel but not across panels (Phase 2 may revisit).
- Tooltip / crosshair: default Lightweight Charts behaviour.
- Dark theme by default; theme toggle is cosmetic in Phase 1.

### `ChartPanel` contract

```tsx
type ChartPanelProps = {
  title: string;
  series: Array<{ symbol: string; label: string; color: string }>;
  days: number;
  source: 'quotes' | 'macro';   // which API to hit
};
```

The panel owns the chart lifecycle (create on mount, destroy on unmount), data fetching, and loading/error states. Each themed panel (`VolatilityPanel`, etc.) is a thin wrapper that supplies the `series` config.

## 8. Daily Job

Single entry point: `bun run src/server/jobs/daily.ts`.

Sequence:
1. Open DB, ensure schema is migrated.
2. For each fetcher group (quotes, macro), call the fetcher with the list of symbols/series and last-known dates from the DB.
3. Fetcher returns new rows since the last stored date (incremental). On first run, pulls 6 months.
4. Write rows in a single transaction per group.
5. Append a row to `job_run` per group with status and record count.

Failure isolation: each group runs in its own try/catch. A failure in one group does not block the others.

### Scheduling

macOS `launchd` plist at `~/Library/LaunchAgents/com.user.mtv.daily.plist`:

- Trigger: `StartCalendarInterval` at 08:00 JST daily (US market closes ~05:00–07:00 JST depending on DST; 08:00 leaves margin).
- Behaviour during sleep: `launchd` runs missed jobs on wake by default.
- Logs: stdout/stderr redirected to `data/logs/daily-YYYYMMDD.log`.

Installer: `scripts/install-launchd.sh` copies the plist into `~/Library/LaunchAgents` and runs `launchctl bootstrap gui/$UID ...`.

## 9. Error Handling

- **External fetch failures**: each fetcher retries 3× with exponential backoff (1s → 2s → 4s). Final failure is logged and the group's `job_run` row is marked `failed` with the error.
- **Partial fetches**: if a group fetches some but not all symbols, the group is marked `partial` and the error message lists which symbols failed.
- **DB write failures**: transactions roll back; the group is marked `failed`. DB is never left in an inconsistent state.
- **Schema migrations**: applied on every job and server start; idempotent.
- **UI surfacing**: `Header` polls `GET /api/health` on mount and renders a green/yellow/red light. Tooltip on hover shows per-group status.

Backfill: a job that ran with `failed` or `partial` status is retried automatically on the next day's run (the fetcher checks last-known date per symbol, so any gap gets filled).

## 10. Testing

- **Unit tests**: only for pure functions in `analytics/` (Phase 2) and any non-trivial transformations in `storage/repository.ts`. Skip for trivial CRUD.
- **Integration tests**: one end-to-end test that runs the daily job against recorded fixtures (network responses cached locally) and asserts the DB has expected rows.
- **No E2E browser tests**: overkill for personal use.

Test runner: Bun's built-in `bun test`.

## 11. Open Questions for Phase 2

Deferred to the Phase 2 spec:
- Whether to make `target_delta` and `target_dte` configurable or hardcoded.
- Whether to fetch SPX option chain in addition to SPY (data quality vs. completeness trade-off).
- Whether to also persist all strikes (not just the 25Δ pick) in case future analyses need the full chain — likely yes via `option_chain_raw`.
- Risk-free rate source for Black-Scholes: use `DGS3MO` from FRED already pulled in Phase 1.
