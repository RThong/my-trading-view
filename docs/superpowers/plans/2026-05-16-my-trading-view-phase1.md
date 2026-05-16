# my-trading-view Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a personal local market dashboard that pulls daily EOD data from Yahoo Finance and FRED, stores it in SQLite, exposes it via a Hono API, and renders it as a 4-panel React dashboard.

**Architecture:** Single-process monorepo on Bun runtime. Backend (`src/server/`) and frontend (`src/web/`) share the same `package.json` and `tsconfig.json`. Backend is Hono on `Bun.serve`, persisting to a local SQLite file via `bun:sqlite`. Frontend is React 19 + Vite, calling the backend through a type-safe `hc<AppType>` client. A daily `launchd` job invokes `bun run job:daily` to refresh data.

**Tech Stack:** Bun, TypeScript, Hono, bun:sqlite, React 19, Vite, Tailwind CSS v4, Lightweight Charts v5, yahoo-finance2, FRED REST API.

**Spec reference:** [docs/superpowers/specs/2026-05-16-my-trading-view-design.md](../specs/2026-05-16-my-trading-view-design.md)

---

## File Structure

```
my-trading-view/
├── package.json
├── tsconfig.json
├── bunfig.toml
├── vite.config.ts
├── .env.example
├── .gitignore                        # already exists
├── data/                             # gitignored
│   └── mtv.db                        # created at runtime
├── docs/                             # already exists
├── src/
│   ├── shared/
│   │   └── types.ts                  # shared API response types
│   ├── server/
│   │   ├── index.ts                  # Hono app entry, exports AppType
│   │   ├── config.ts                 # paths, env, catalog config
│   │   ├── routes/
│   │   │   ├── quotes.ts
│   │   │   ├── macro.ts
│   │   │   ├── catalog.ts
│   │   │   └── health.ts
│   │   ├── fetchers/
│   │   │   ├── yahoo.ts
│   │   │   ├── yahoo.test.ts
│   │   │   ├── fred.ts
│   │   │   └── fred.test.ts
│   │   ├── storage/
│   │   │   ├── db.ts                 # open DB + run migrations
│   │   │   ├── schema.sql
│   │   │   ├── repository.ts
│   │   │   └── repository.test.ts
│   │   └── jobs/
│   │       ├── daily.ts
│   │       └── daily.test.ts
│   └── web/
│       ├── index.html
│       ├── main.tsx
│       ├── App.tsx
│       ├── styles.css
│       ├── api/
│       │   └── client.ts             # hc<AppType>
│       ├── hooks/
│       │   └── useChartData.ts
│       ├── components/
│       │   ├── Header.tsx
│       │   ├── StatusLight.tsx
│       │   └── ChartPanel.tsx
│       └── panels/
│           ├── VolatilityPanel.tsx
│           ├── MacroPanel.tsx
│           ├── IndicesPanel.tsx
│           └── AssetsPanel.tsx
├── launchd/
│   └── com.user.mtv.daily.plist.template
└── scripts/
    └── install-launchd.sh
```

### File responsibility notes

- **`src/shared/types.ts`** — only types, imported by both server and web; no runtime code.
- **`src/server/storage/repository.ts`** — all SQL lives here; routes and jobs never write SQL directly.
- **`src/server/fetchers/*`** — pure HTTP/data fetch; no DB calls, no business logic beyond normalization.
- **`src/server/jobs/daily.ts`** — orchestrator only; composes fetchers + repository.
- **`src/web/components/ChartPanel.tsx`** — generic; each `panels/*Panel.tsx` is a thin config wrapper.

---

## Task Sequence

### Task 1: Project bootstrap (Bun + TS)

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `bunfig.toml`
- Create: `.env.example`
- Create: `README.md`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "my-trading-view",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev:server": "bun run --watch src/server/index.ts",
    "dev:web": "vite",
    "build:web": "vite build",
    "job:daily": "bun run src/server/jobs/daily.ts",
    "db:migrate": "bun run src/server/storage/db.ts migrate",
    "test": "bun test"
  },
  "dependencies": {
    "hono": "^4.6.0",
    "yahoo-finance2": "^2.13.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "lightweight-charts": "^5.0.0"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.0",
    "@tailwindcss/vite": "^4.0.0",
    "tailwindcss": "^4.0.0",
    "typescript": "^5.5.0",
    "vite": "^5.4.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ESNext", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "types": ["bun-types"],
    "baseUrl": ".",
    "paths": {
      "@shared/*": ["src/shared/*"],
      "@server/*": ["src/server/*"],
      "@web/*": ["src/web/*"]
    }
  },
  "include": ["src/**/*.ts", "src/**/*.tsx"]
}
```

- [ ] **Step 3: Create `bunfig.toml`**

```toml
[install]
exact = false

[test]
preload = []
```

- [ ] **Step 4: Create `.env.example`**

```
# Get a free API key at https://fred.stlouisfed.org/docs/api/api_key.html
FRED_API_KEY=
```

- [ ] **Step 5: Create minimal `README.md`**

```markdown
# my-trading-view

Personal local market dashboard. See `docs/superpowers/specs/` for the design.

## Setup

1. `bun install`
2. Copy `.env.example` to `.env` and fill in `FRED_API_KEY`
3. `bun run db:migrate`
4. `bun run job:daily` (runs once, populates initial 6 months)
5. `bun run dev:server` in one terminal, `bun run dev:web` in another
6. Open http://localhost:5173

## Daily refresh

See `launchd/` and `scripts/install-launchd.sh` for installing the daily job.
```

- [ ] **Step 6: Install dependencies**

Run: `bun install`
Expected: dependencies install without errors; `bun.lockb` created.

- [ ] **Step 7: Commit**

```bash
git add package.json tsconfig.json bunfig.toml .env.example README.md bun.lockb
git commit -m "chore: bootstrap Bun + TS project"
```

---

### Task 2: SQLite schema & migration runner

**Files:**
- Create: `src/server/storage/schema.sql`
- Create: `src/server/storage/db.ts`
- Create: `src/server/config.ts`

- [ ] **Step 1: Create `src/server/config.ts`**

```ts
import { resolve } from 'node:path';

export const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..', '..');
export const DB_PATH = resolve(PROJECT_ROOT, 'data', 'mtv.db');

export const QUOTE_SYMBOLS = [
  { symbol: '^VIX',    label: 'VIX',   group: 'volatility' as const },
  { symbol: '^VIX9D',  label: 'VIX9D', group: 'volatility' as const },
  { symbol: '^VIX3M',  label: 'VIX3M', group: 'volatility' as const },
  { symbol: '^VVIX',   label: 'VVIX',  group: 'volatility' as const },
  { symbol: '^SKEW',   label: 'SKEW',  group: 'volatility' as const },
  { symbol: '^GSPC',   label: 'S&P 500', group: 'index' as const },
  { symbol: 'QQQ',     label: 'QQQ',   group: 'index' as const },
  { symbol: 'IWM',     label: 'IWM',   group: 'index' as const },
  { symbol: 'GLD',     label: 'GLD',   group: 'asset' as const },
  { symbol: 'TLT',     label: 'TLT',   group: 'asset' as const },
  { symbol: 'BTC-USD', label: 'BTC',   group: 'asset' as const },
];

export const MACRO_SERIES = [
  { id: 'DGS10',     label: 'UST 10Y',  unit: '%' },
  { id: 'DGS2',      label: 'UST 2Y',   unit: '%' },
  { id: 'DGS3MO',    label: 'UST 3M',   unit: '%' },
  { id: 'DTWEXBGS',  label: 'USD Index (broad)', unit: 'index' },
];
```

- [ ] **Step 2: Create `src/server/storage/schema.sql`**

```sql
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
```

- [ ] **Step 3: Create `src/server/storage/db.ts`**

```ts
import { Database } from 'bun:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DB_PATH } from '../config';

const CURRENT_SCHEMA_VERSION = 1;

export function openDb(path: string = DB_PATH): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

export function migrate(db: Database): void {
  const schemaPath = resolve(import.meta.dirname, 'schema.sql');
  const sql = readFileSync(schemaPath, 'utf-8');
  db.exec(sql);

  const row = db.query('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null };
  if ((row?.v ?? 0) < CURRENT_SCHEMA_VERSION) {
    db.run(
      'INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (?, ?)',
      [CURRENT_SCHEMA_VERSION, new Date().toISOString()],
    );
  }
}

// CLI entry: `bun run src/server/storage/db.ts migrate`
if (import.meta.main) {
  const cmd = process.argv[2];
  if (cmd === 'migrate') {
    const db = openDb();
    migrate(db);
    console.log(`Migrated DB at ${DB_PATH} to schema v${CURRENT_SCHEMA_VERSION}`);
    db.close();
  } else {
    console.error('Usage: bun run src/server/storage/db.ts migrate');
    process.exit(1);
  }
}
```

- [ ] **Step 4: Run migration to verify**

Run: `bun run db:migrate`
Expected output: `Migrated DB at /.../data/mtv.db to schema v1`
File `data/mtv.db` exists.

- [ ] **Step 5: Commit**

```bash
git add src/server/config.ts src/server/storage/
git commit -m "feat(storage): add SQLite schema and migration runner"
```

---

### Task 3: Repository — `quote_eod`

**Files:**
- Create: `src/server/storage/repository.ts`
- Create: `src/server/storage/repository.test.ts`

- [ ] **Step 1: Write failing test for quote insert + range query**

Create `src/server/storage/repository.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/server/storage/repository.test.ts`
Expected: FAIL — `repository.ts` does not exist.

- [ ] **Step 3: Implement `src/server/storage/repository.ts`**

```ts
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
```

Also create `src/shared/types.ts` (will be filled in fully in Task 8; for now just the types referenced):

```ts
export type QuoteBar = {
  date: string;
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
```

- [ ] **Step 4: Run tests to verify pass**

Run: `bun test src/server/storage/repository.test.ts`
Expected: all 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/server/storage/repository.ts src/server/storage/repository.test.ts src/shared/types.ts
git commit -m "feat(storage): quote_eod read/write repository"
```

---

### Task 4: Repository — `macro_series`

**Files:**
- Modify: `src/server/storage/repository.ts`
- Modify: `src/server/storage/repository.test.ts`

- [ ] **Step 1: Add failing tests for macro_series**

Append to `src/server/storage/repository.test.ts`:

```ts
import {
  insertMacro,
  getMacroSeries,
  getLatestMacroDate,
  type MacroRow,
} from './repository';

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
```

- [ ] **Step 2: Run test, verify failure**

Run: `bun test src/server/storage/repository.test.ts`
Expected: 3 new tests fail with import errors.

- [ ] **Step 3: Add `MacroRow` and three functions to `repository.ts`**

Append to `src/server/storage/repository.ts`:

```ts
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
```

- [ ] **Step 4: Run tests, verify pass**

Run: `bun test src/server/storage/repository.test.ts`
Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/server/storage/repository.ts src/server/storage/repository.test.ts
git commit -m "feat(storage): macro_series repository"
```

---

### Task 5: Repository — `job_run`

**Files:**
- Modify: `src/server/storage/repository.ts`
- Modify: `src/server/storage/repository.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `src/server/storage/repository.test.ts`:

```ts
import {
  startJobRun,
  finishJobRun,
  getJobHealth,
} from './repository';

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
```

- [ ] **Step 2: Run, verify fail**

Run: `bun test src/server/storage/repository.test.ts`
Expected: 2 new tests fail.

- [ ] **Step 3: Implement in `repository.ts`**

Append to `src/server/storage/repository.ts`:

```ts
import type { JobStatus } from '../../shared/types';

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

export function getJobHealth(db: Database): JobStatus[] {
  const rows = db.query(`
    SELECT job_name AS name, status, finished_at, error_message,
           (SELECT MAX(finished_at) FROM job_run jr2
            WHERE jr2.job_name = jr.job_name AND jr2.status = 'success') AS last_success_at
    FROM job_run jr
    WHERE finished_at = (SELECT MAX(finished_at) FROM job_run jr3 WHERE jr3.job_name = jr.job_name)
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
```

Also add `JobStatus` to `src/shared/types.ts`:

```ts
export type JobStatus = {
  name: string;
  status: 'success' | 'partial' | 'failed' | 'running';
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  error: string | null;
};

export type HealthResponse = {
  jobs: JobStatus[];
};

export type CatalogResponse = {
  quotes: Array<{ symbol: string; label: string; group: 'volatility' | 'index' | 'asset' }>;
  macro: Array<{ id: string; label: string; unit: string }>;
};
```

- [ ] **Step 4: Run tests, verify pass**

Run: `bun test src/server/storage/repository.test.ts`
Expected: 9 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/server/storage/repository.ts src/server/storage/repository.test.ts src/shared/types.ts
git commit -m "feat(storage): job_run repository and JobStatus type"
```

---

### Task 6: Yahoo Finance fetcher

**Files:**
- Create: `src/server/fetchers/yahoo.ts`
- Create: `src/server/fetchers/yahoo.test.ts`

The fetcher takes an injectable client so we can mock it in tests.

- [ ] **Step 1: Write failing test**

```ts
// src/server/fetchers/yahoo.test.ts
import { describe, test, expect } from 'bun:test';
import { createYahooFetcher, type YahooClient } from './yahoo';

describe('yahoo fetcher', () => {
  test('fetchDailyBars maps yahoo chart() output to QuoteRow shape', async () => {
    const mockClient: YahooClient = {
      chart: async (symbol, opts) => ({
        meta: { symbol, currency: 'USD' },
        quotes: [
          { date: new Date('2026-05-10T00:00:00Z'), open: 100, high: 102, low: 99, close: 101, volume: 1000 },
          { date: new Date('2026-05-11T00:00:00Z'), open: 101, high: 103, low: 100, close: 102, volume: 1100 },
        ],
      }),
    };
    const fetcher = createYahooFetcher(mockClient);
    const rows = await fetcher.fetchDailyBars('TEST', new Date('2026-05-01'));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      symbol: 'TEST',
      tradeDate: '2026-05-10',
      open: 100, high: 102, low: 99, close: 101, volume: 1000,
    });
  });

  test('fetchDailyBars handles missing OHLC fields', async () => {
    const mockClient: YahooClient = {
      chart: async () => ({
        meta: { symbol: 'TEST', currency: 'USD' },
        quotes: [{ date: new Date('2026-05-10T00:00:00Z'), open: null, high: null, low: null, close: 50, volume: null }],
      }),
    };
    const fetcher = createYahooFetcher(mockClient);
    const rows = await fetcher.fetchDailyBars('TEST', new Date('2026-05-01'));
    expect(rows[0]).toEqual({
      symbol: 'TEST',
      tradeDate: '2026-05-10',
      open: null, high: null, low: null, close: 50, volume: null,
    });
  });

  test('fetchDailyBars rejects rows with null close', async () => {
    const mockClient: YahooClient = {
      chart: async () => ({
        meta: { symbol: 'TEST', currency: 'USD' },
        quotes: [
          { date: new Date('2026-05-10T00:00:00Z'), open: 1, high: 2, low: 0, close: null, volume: 100 },
          { date: new Date('2026-05-11T00:00:00Z'), open: 1, high: 2, low: 0, close: 50, volume: 100 },
        ],
      }),
    };
    const fetcher = createYahooFetcher(mockClient);
    const rows = await fetcher.fetchDailyBars('TEST', new Date('2026-05-01'));
    expect(rows).toHaveLength(1);
    expect(rows[0].tradeDate).toBe('2026-05-11');
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `bun test src/server/fetchers/yahoo.test.ts`
Expected: 3 tests fail (module does not exist).

- [ ] **Step 3: Implement `src/server/fetchers/yahoo.ts`**

```ts
import YahooFinance from 'yahoo-finance2';
import type { QuoteRow } from '../storage/repository';

type YahooQuote = {
  date: Date;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
};

export type YahooClient = {
  chart: (symbol: string, opts: { period1: Date | string; period2?: Date | string; interval: '1d' })
    => Promise<{ meta: { symbol: string; currency?: string }; quotes: YahooQuote[] }>;
};

export function defaultYahooClient(): YahooClient {
  const instance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
  return {
    chart: (symbol, opts) => instance.chart(symbol, opts) as any,
  };
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function createYahooFetcher(client: YahooClient = defaultYahooClient()) {
  return {
    async fetchDailyBars(symbol: string, since: Date): Promise<QuoteRow[]> {
      const result = await client.chart(symbol, { period1: since, interval: '1d' });
      return result.quotes
        .filter(q => q.close !== null && q.close !== undefined)
        .map(q => ({
          symbol,
          tradeDate: toIsoDate(q.date),
          open: q.open ?? null,
          high: q.high ?? null,
          low: q.low ?? null,
          close: q.close as number,
          volume: q.volume ?? null,
        }));
    },
  };
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `bun test src/server/fetchers/yahoo.test.ts`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/server/fetchers/yahoo.ts src/server/fetchers/yahoo.test.ts
git commit -m "feat(fetchers): yahoo finance daily bars fetcher"
```

---

### Task 7: FRED fetcher

**Files:**
- Create: `src/server/fetchers/fred.ts`
- Create: `src/server/fetchers/fred.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// src/server/fetchers/fred.test.ts
import { describe, test, expect } from 'bun:test';
import { createFredFetcher } from './fred';

describe('fred fetcher', () => {
  test('fetchSeries parses observations into MacroRow shape', async () => {
    const fakeFetch: typeof fetch = async (input) => {
      const url = String(input);
      expect(url).toContain('series_id=DGS10');
      expect(url).toContain('api_key=test-key');
      return new Response(JSON.stringify({
        observations: [
          { date: '2026-05-10', value: '4.20' },
          { date: '2026-05-11', value: '4.25' },
          { date: '2026-05-12', value: '.' },  // FRED uses '.' for missing
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const fetcher = createFredFetcher({ apiKey: 'test-key', fetch: fakeFetch });
    const rows = await fetcher.fetchSeries('DGS10', '2026-05-01');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ seriesId: 'DGS10', obsDate: '2026-05-10', value: 4.20 });
    expect(rows[1].value).toBe(4.25);
  });

  test('fetchSeries throws on non-200', async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response('forbidden', { status: 403 });
    const fetcher = createFredFetcher({ apiKey: 'k', fetch: fakeFetch });
    await expect(fetcher.fetchSeries('DGS10', '2026-05-01')).rejects.toThrow(/FRED/);
  });

  test('fetchSeries throws on missing api key', () => {
    expect(() => createFredFetcher({ apiKey: '', fetch })).toThrow(/FRED_API_KEY/);
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `bun test src/server/fetchers/fred.test.ts`

- [ ] **Step 3: Implement `src/server/fetchers/fred.ts`**

```ts
import type { MacroRow } from '../storage/repository';

type FredOpts = {
  apiKey: string;
  fetch?: typeof fetch;
};

export function createFredFetcher(opts: FredOpts) {
  if (!opts.apiKey) {
    throw new Error('FRED_API_KEY is required');
  }
  const doFetch = opts.fetch ?? globalThis.fetch;
  const base = 'https://api.stlouisfed.org/fred/series/observations';

  return {
    async fetchSeries(seriesId: string, since: string): Promise<MacroRow[]> {
      const params = new URLSearchParams({
        series_id: seriesId,
        api_key: opts.apiKey,
        file_type: 'json',
        observation_start: since,
      });
      const res = await doFetch(`${base}?${params}`);
      if (!res.ok) {
        throw new Error(`FRED request failed for ${seriesId}: ${res.status} ${await res.text()}`);
      }
      const body = await res.json() as { observations: Array<{ date: string; value: string }> };
      return body.observations
        .filter(o => o.value !== '.' && o.value !== '')
        .map(o => ({
          seriesId,
          obsDate: o.date,
          value: Number(o.value),
        }));
    },
  };
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `bun test src/server/fetchers/fred.test.ts`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/server/fetchers/fred.ts src/server/fetchers/fred.test.ts
git commit -m "feat(fetchers): FRED API series fetcher"
```

---

### Task 8: Daily job orchestrator

**Files:**
- Create: `src/server/jobs/daily.ts`
- Create: `src/server/jobs/daily.test.ts`

The job is structured so the orchestration function takes injected fetchers and a DB; the CLI entry wires the real ones.

- [ ] **Step 1: Write failing test for orchestration**

```ts
// src/server/jobs/daily.test.ts
import { describe, test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate } from '../storage/db';
import { getQuotes, getMacroSeries, getJobHealth } from '../storage/repository';
import { runDailyJob } from './daily';

function freshDb(): Database {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}

describe('daily job', () => {
  let db: Database;
  beforeEach(() => { db = freshDb(); });

  test('writes quote rows for each requested symbol and records success', async () => {
    await runDailyJob({
      db,
      quoteSymbols: [{ symbol: 'AAA', label: 'A', group: 'index' }],
      macroSeries: [],
      yahoo: {
        fetchDailyBars: async (sym, since) => [
          { symbol: sym, tradeDate: '2026-05-10', open: 1, high: 2, low: 0, close: 1.5, volume: 100 },
        ],
      },
      fred: { fetchSeries: async () => [] },
      historyDays: 30,
    });

    expect(getQuotes(db, 'AAA', 30)).toHaveLength(1);
    const health = getJobHealth(db);
    expect(health.find(h => h.name === 'quotes')?.status).toBe('success');
  });

  test('partial: one symbol fails, others succeed, marked partial', async () => {
    const failingYahoo = {
      fetchDailyBars: async (sym: string) => {
        if (sym === 'BAD') throw new Error('rate limited');
        return [{ symbol: sym, tradeDate: '2026-05-10', open: 1, high: 2, low: 0, close: 1.5, volume: 100 }];
      },
    };
    await runDailyJob({
      db,
      quoteSymbols: [
        { symbol: 'GOOD', label: 'G', group: 'index' },
        { symbol: 'BAD', label: 'B', group: 'index' },
      ],
      macroSeries: [],
      yahoo: failingYahoo,
      fred: { fetchSeries: async () => [] },
      historyDays: 30,
    });

    expect(getQuotes(db, 'GOOD', 30)).toHaveLength(1);
    expect(getQuotes(db, 'BAD', 30)).toHaveLength(0);
    const health = getJobHealth(db).find(h => h.name === 'quotes')!;
    expect(health.status).toBe('partial');
    expect(health.error).toContain('BAD');
  });

  test('writes macro and records macro success independently', async () => {
    await runDailyJob({
      db,
      quoteSymbols: [],
      macroSeries: [{ id: 'DGS10', label: '10Y', unit: '%' }],
      yahoo: { fetchDailyBars: async () => [] },
      fred: {
        fetchSeries: async () => [{ seriesId: 'DGS10', obsDate: '2026-05-10', value: 4.2 }],
      },
      historyDays: 30,
    });

    expect(getMacroSeries(db, 'DGS10', 30)).toHaveLength(1);
    expect(getJobHealth(db).find(h => h.name === 'macro')?.status).toBe('success');
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `bun test src/server/jobs/daily.test.ts`

- [ ] **Step 3: Implement `src/server/jobs/daily.ts`**

```ts
import type { Database } from 'bun:sqlite';
import { openDb, migrate } from '../storage/db';
import {
  insertQuotes,
  insertMacro,
  getLatestQuoteDate,
  getLatestMacroDate,
  startJobRun,
  finishJobRun,
  type QuoteRow,
  type MacroRow,
} from '../storage/repository';
import { createYahooFetcher } from '../fetchers/yahoo';
import { createFredFetcher } from '../fetchers/fred';
import { QUOTE_SYMBOLS, MACRO_SERIES } from '../config';

type QuoteSymbol = { symbol: string; label: string; group: string };
type MacroSpec = { id: string; label: string; unit: string };

type RunDailyJobOpts = {
  db: Database;
  quoteSymbols: QuoteSymbol[];
  macroSeries: MacroSpec[];
  yahoo: { fetchDailyBars(symbol: string, since: Date): Promise<QuoteRow[]> };
  fred: { fetchSeries(seriesId: string, since: string): Promise<MacroRow[]> };
  historyDays: number;
};

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 86400_000);
}

export async function runDailyJob(opts: RunDailyJobOpts): Promise<void> {
  // ── quotes group ──
  if (opts.quoteSymbols.length > 0) {
    const runId = startJobRun(opts.db, 'quotes');
    const failures: string[] = [];
    let total = 0;
    for (const { symbol } of opts.quoteSymbols) {
      try {
        const latest = getLatestQuoteDate(opts.db, symbol);
        const since = latest ? new Date(latest + 'T00:00:00Z') : daysAgo(opts.historyDays);
        const rows = await opts.yahoo.fetchDailyBars(symbol, since);
        insertQuotes(opts.db, rows, 'yahoo');
        total += rows.length;
      } catch (err) {
        failures.push(`${symbol}: ${(err as Error).message}`);
      }
    }
    if (failures.length === 0) {
      finishJobRun(opts.db, runId, { status: 'success', recordsWritten: total });
    } else if (failures.length === opts.quoteSymbols.length) {
      finishJobRun(opts.db, runId, { status: 'failed', error: failures.join('; ') });
    } else {
      finishJobRun(opts.db, runId, { status: 'partial', recordsWritten: total, error: failures.join('; ') });
    }
  }

  // ── macro group ──
  if (opts.macroSeries.length > 0) {
    const runId = startJobRun(opts.db, 'macro');
    const failures: string[] = [];
    let total = 0;
    for (const { id } of opts.macroSeries) {
      try {
        const latest = getLatestMacroDate(opts.db, id);
        const since = latest ?? daysAgo(opts.historyDays).toISOString().slice(0, 10);
        const rows = await opts.fred.fetchSeries(id, since);
        insertMacro(opts.db, rows);
        total += rows.length;
      } catch (err) {
        failures.push(`${id}: ${(err as Error).message}`);
      }
    }
    if (failures.length === 0) {
      finishJobRun(opts.db, runId, { status: 'success', recordsWritten: total });
    } else if (failures.length === opts.macroSeries.length) {
      finishJobRun(opts.db, runId, { status: 'failed', error: failures.join('; ') });
    } else {
      finishJobRun(opts.db, runId, { status: 'partial', recordsWritten: total, error: failures.join('; ') });
    }
  }
}

// CLI entry
if (import.meta.main) {
  const db = openDb();
  migrate(db);
  const fredKey = process.env.FRED_API_KEY ?? '';
  await runDailyJob({
    db,
    quoteSymbols: QUOTE_SYMBOLS,
    macroSeries: MACRO_SERIES,
    yahoo: createYahooFetcher(),
    fred: createFredFetcher({ apiKey: fredKey }),
    historyDays: 180,
  });
  db.close();
  console.log('Daily job complete.');
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `bun test src/server/jobs/daily.test.ts`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/server/jobs/daily.ts src/server/jobs/daily.test.ts
git commit -m "feat(jobs): daily orchestrator with per-group status"
```

---

### Task 9: Hono server skeleton + `/api/health`

**Files:**
- Create: `src/server/index.ts`
- Create: `src/server/routes/health.ts`

- [ ] **Step 1: Create `src/server/routes/health.ts`**

```ts
import { Hono } from 'hono';
import { openDb } from '../storage/db';
import { getJobHealth } from '../storage/repository';
import type { HealthResponse } from '../../shared/types';

export const healthRoute = new Hono()
  .get('/', (c) => {
    const db = openDb();
    try {
      const jobs = getJobHealth(db);
      return c.json<HealthResponse>({ jobs });
    } finally {
      db.close();
    }
  });
```

- [ ] **Step 2: Create `src/server/index.ts`**

```ts
import { Hono } from 'hono';
import { healthRoute } from './routes/health';

const app = new Hono()
  .basePath('/api')
  .route('/health', healthRoute);

export type AppType = typeof app;
export default {
  port: 3000,
  fetch: app.fetch,
};
```

- [ ] **Step 3: Start server and curl /api/health**

In one terminal: `bun run dev:server`
In another: `curl -s http://localhost:3000/api/health | jq`
Expected: JSON `{"jobs":[]}` (empty because no jobs have run in a fresh DB; if you ran the daily job earlier, you'll see entries).

- [ ] **Step 4: Commit**

```bash
git add src/server/index.ts src/server/routes/health.ts
git commit -m "feat(api): Hono skeleton with /api/health"
```

---

### Task 10: `/api/quotes/:symbol`

**Files:**
- Create: `src/server/routes/quotes.ts`
- Modify: `src/server/index.ts`

- [ ] **Step 1: Create `src/server/routes/quotes.ts`**

```ts
import { Hono } from 'hono';
import { openDb } from '../storage/db';
import { getQuotes } from '../storage/repository';

export const quotesRoute = new Hono()
  .get('/:symbol', (c) => {
    const symbol = c.req.param('symbol');
    const daysStr = c.req.query('days') ?? '180';
    const days = Math.min(Math.max(Number(daysStr) || 180, 1), 1825);
    const db = openDb();
    try {
      const bars = getQuotes(db, symbol, days);
      return c.json(bars);
    } finally {
      db.close();
    }
  });
```

- [ ] **Step 2: Register route in `src/server/index.ts`**

Replace `src/server/index.ts` with:

```ts
import { Hono } from 'hono';
import { healthRoute } from './routes/health';
import { quotesRoute } from './routes/quotes';

const app = new Hono()
  .basePath('/api')
  .route('/health', healthRoute)
  .route('/quotes', quotesRoute);

export type AppType = typeof app;
export default {
  port: 3000,
  fetch: app.fetch,
};
```

- [ ] **Step 3: Manually verify**

If you haven't run the daily job: `bun run job:daily` (needs FRED_API_KEY for macro; quotes alone will work).
Then: `curl -s 'http://localhost:3000/api/quotes/%5EVIX?days=30' | jq '. | length'`
Expected: a number > 0 (number of VIX bars fetched).

- [ ] **Step 4: Commit**

```bash
git add src/server/routes/quotes.ts src/server/index.ts
git commit -m "feat(api): GET /api/quotes/:symbol"
```

---

### Task 11: `/api/macro/:seriesId`

**Files:**
- Create: `src/server/routes/macro.ts`
- Modify: `src/server/index.ts`

- [ ] **Step 1: Create `src/server/routes/macro.ts`**

```ts
import { Hono } from 'hono';
import { openDb } from '../storage/db';
import { getMacroSeries } from '../storage/repository';

export const macroRoute = new Hono()
  .get('/:seriesId', (c) => {
    const seriesId = c.req.param('seriesId');
    const daysStr = c.req.query('days') ?? '180';
    const days = Math.min(Math.max(Number(daysStr) || 180, 1), 1825);
    const db = openDb();
    try {
      const points = getMacroSeries(db, seriesId, days);
      return c.json(points);
    } finally {
      db.close();
    }
  });
```

- [ ] **Step 2: Register route**

Update `src/server/index.ts`:

```ts
import { Hono } from 'hono';
import { healthRoute } from './routes/health';
import { quotesRoute } from './routes/quotes';
import { macroRoute } from './routes/macro';

const app = new Hono()
  .basePath('/api')
  .route('/health', healthRoute)
  .route('/quotes', quotesRoute)
  .route('/macro', macroRoute);

export type AppType = typeof app;
export default {
  port: 3000,
  fetch: app.fetch,
};
```

- [ ] **Step 3: Manually verify**

`curl -s 'http://localhost:3000/api/macro/DGS10?days=30' | jq '. | length'`
Expected: a number > 0 if daily job has run with FRED key.

- [ ] **Step 4: Commit**

```bash
git add src/server/routes/macro.ts src/server/index.ts
git commit -m "feat(api): GET /api/macro/:seriesId"
```

---

### Task 12: `/api/catalog`

**Files:**
- Create: `src/server/routes/catalog.ts`
- Modify: `src/server/index.ts`

- [ ] **Step 1: Create `src/server/routes/catalog.ts`**

```ts
import { Hono } from 'hono';
import { QUOTE_SYMBOLS, MACRO_SERIES } from '../config';
import type { CatalogResponse } from '../../shared/types';

export const catalogRoute = new Hono()
  .get('/', (c) => {
    return c.json<CatalogResponse>({
      quotes: QUOTE_SYMBOLS.map(q => ({ symbol: q.symbol, label: q.label, group: q.group })),
      macro: MACRO_SERIES.map(m => ({ id: m.id, label: m.label, unit: m.unit })),
    });
  });
```

- [ ] **Step 2: Register**

Update `src/server/index.ts`:

```ts
import { Hono } from 'hono';
import { healthRoute } from './routes/health';
import { quotesRoute } from './routes/quotes';
import { macroRoute } from './routes/macro';
import { catalogRoute } from './routes/catalog';

const app = new Hono()
  .basePath('/api')
  .route('/health', healthRoute)
  .route('/quotes', quotesRoute)
  .route('/macro', macroRoute)
  .route('/catalog', catalogRoute);

export type AppType = typeof app;
export default {
  port: 3000,
  fetch: app.fetch,
};
```

- [ ] **Step 3: Verify**

`curl -s http://localhost:3000/api/catalog | jq`
Expected: JSON with `quotes` (11 items) and `macro` (4 items).

- [ ] **Step 4: Commit**

```bash
git add src/server/routes/catalog.ts src/server/index.ts
git commit -m "feat(api): GET /api/catalog"
```

---

### Task 13: Frontend bootstrap (Vite + React 19 + Tailwind v4)

**Files:**
- Create: `vite.config.ts`
- Create: `src/web/index.html`
- Create: `src/web/main.tsx`
- Create: `src/web/App.tsx`
- Create: `src/web/styles.css`

- [ ] **Step 1: Create `vite.config.ts`**

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  root: 'src/web',
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
  },
});
```

- [ ] **Step 2: Create `src/web/index.html`**

```html
<!DOCTYPE html>
<html lang="en" class="dark">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>My Trading View</title>
  </head>
  <body class="bg-neutral-950 text-neutral-100">
    <div id="root"></div>
    <script type="module" src="/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 3: Create `src/web/styles.css`**

```css
@import "tailwindcss";
```

- [ ] **Step 4: Create `src/web/main.tsx`**

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

- [ ] **Step 5: Create `src/web/App.tsx` (placeholder)**

```tsx
export function App() {
  return (
    <div className="min-h-screen p-8">
      <h1 className="text-2xl font-semibold">My Trading View</h1>
      <p className="mt-2 text-neutral-400">Bootstrap working. Panels coming next.</p>
    </div>
  );
}
```

- [ ] **Step 6: Run Vite dev server and verify**

Run: `bun run dev:web`
Open: http://localhost:5173
Expected: Dark page with "My Trading View" heading and subtitle. No console errors.

- [ ] **Step 7: Commit**

```bash
git add vite.config.ts src/web/
git commit -m "feat(web): Vite + React 19 + Tailwind v4 bootstrap"
```

---

### Task 14: Typed `hc` client + shared types reuse

**Files:**
- Create: `src/web/api/client.ts`

- [ ] **Step 1: Create `src/web/api/client.ts`**

```ts
import { hc } from 'hono/client';
import type { AppType } from '../../server';

// Vite dev proxies /api → http://localhost:3000; in production build the same path is served.
export const api = hc<AppType>('');
```

- [ ] **Step 2: Verify the type chain compiles**

Run: `bunx tsc --noEmit`
Expected: no errors. The `AppType` import flows through; if any route handler returns the wrong shape, this command would fail.

- [ ] **Step 3: Commit**

```bash
git add src/web/api/client.ts
git commit -m "feat(web): typed hc client wiring AppType from server"
```

---

### Task 15: `Header` and `StatusLight` components

**Files:**
- Create: `src/web/components/StatusLight.tsx`
- Create: `src/web/components/Header.tsx`
- Modify: `src/web/App.tsx`

- [ ] **Step 1: Create `src/web/components/StatusLight.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { JobStatus } from '../../shared/types';

type Tone = 'green' | 'yellow' | 'red' | 'gray';

function overallTone(jobs: JobStatus[]): Tone {
  if (jobs.length === 0) return 'gray';
  if (jobs.some(j => j.status === 'failed')) return 'red';
  if (jobs.some(j => j.status === 'partial')) return 'yellow';
  if (jobs.every(j => j.status === 'success')) return 'green';
  return 'gray';
}

const toneClass: Record<Tone, string> = {
  green: 'bg-emerald-500',
  yellow: 'bg-amber-500',
  red: 'bg-red-500',
  gray: 'bg-neutral-600',
};

export function StatusLight() {
  const [jobs, setJobs] = useState<JobStatus[]>([]);
  useEffect(() => {
    api.api.health.$get().then(r => r.json()).then(data => setJobs(data.jobs));
  }, []);

  const tone = overallTone(jobs);
  const title = jobs.length === 0
    ? 'No job runs recorded'
    : jobs.map(j => `${j.name}: ${j.status}${j.error ? ` (${j.error})` : ''}`).join(' | ');

  return (
    <span
      title={title}
      className={`inline-block h-3 w-3 rounded-full ${toneClass[tone]}`}
      aria-label={`Job health: ${tone}`}
    />
  );
}
```

- [ ] **Step 2: Create `src/web/components/Header.tsx`**

```tsx
import { StatusLight } from './StatusLight';

const RANGES = [
  { label: '90D',  days: 90 },
  { label: '180D', days: 180 },
  { label: '1Y',   days: 365 },
  { label: 'All',  days: 1825 },
];

type HeaderProps = {
  days: number;
  onDaysChange: (d: number) => void;
};

export function Header({ days, onDaysChange }: HeaderProps) {
  return (
    <header className="flex items-center gap-4 border-b border-neutral-800 px-6 py-3">
      <StatusLight />
      <h1 className="text-lg font-semibold">My Trading View</h1>
      <div className="ml-auto flex items-center gap-1">
        {RANGES.map(r => (
          <button
            key={r.label}
            onClick={() => onDaysChange(r.days)}
            className={
              'rounded px-3 py-1 text-sm ' +
              (r.days === days
                ? 'bg-neutral-700 text-white'
                : 'text-neutral-400 hover:text-white hover:bg-neutral-800')
            }
          >
            {r.label}
          </button>
        ))}
      </div>
    </header>
  );
}
```

- [ ] **Step 3: Update `src/web/App.tsx`**

```tsx
import { useState } from 'react';
import { Header } from './components/Header';

export function App() {
  const [days, setDays] = useState(180);
  return (
    <div className="min-h-screen">
      <Header days={days} onDaysChange={setDays} />
      <main className="grid grid-cols-1 gap-4 p-6 md:grid-cols-2">
        <div className="rounded border border-neutral-800 p-4">
          <h2 className="text-sm uppercase tracking-wider text-neutral-400">Volatility (placeholder)</h2>
          <p className="mt-2 text-neutral-500">days = {days}</p>
        </div>
        <div className="rounded border border-neutral-800 p-4">
          <h2 className="text-sm uppercase tracking-wider text-neutral-400">Macro (placeholder)</h2>
        </div>
        <div className="rounded border border-neutral-800 p-4">
          <h2 className="text-sm uppercase tracking-wider text-neutral-400">Indices (placeholder)</h2>
        </div>
        <div className="rounded border border-neutral-800 p-4">
          <h2 className="text-sm uppercase tracking-wider text-neutral-400">Other Assets (placeholder)</h2>
        </div>
      </main>
    </div>
  );
}
```

- [ ] **Step 4: Verify**

Both servers running. Open http://localhost:5173.
Expected: Header with status dot, title, and time-range buttons. Clicking buttons updates the visible "days = N" text. 2×2 placeholder grid below.

- [ ] **Step 5: Commit**

```bash
git add src/web/components/ src/web/App.tsx
git commit -m "feat(web): Header, StatusLight, and 2x2 placeholder grid"
```

---

### Task 16: Generic `ChartPanel` component

**Files:**
- Create: `src/web/components/ChartPanel.tsx`
- Create: `src/web/hooks/useChartData.ts`

- [ ] **Step 1: Create `src/web/hooks/useChartData.ts`**

```ts
import { useEffect, useState } from 'react';
import { api } from '../api/client';

export type LinePoint = { time: string; value: number };
export type SeriesData = { label: string; color: string; data: LinePoint[] };

type QuoteSeriesConfig = { source: 'quotes'; symbol: string; label: string; color: string };
type MacroSeriesConfig = { source: 'macro';  seriesId: string; label: string; color: string };
export type SeriesConfig = QuoteSeriesConfig | MacroSeriesConfig;

export function useChartData(configs: SeriesConfig[], days: number): {
  series: SeriesData[];
  loading: boolean;
  error: string | null;
} {
  const [series, setSeries] = useState<SeriesData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    Promise.all(configs.map(async (cfg) => {
      if (cfg.source === 'quotes') {
        const res = await api.api.quotes[':symbol'].$get({
          param: { symbol: cfg.symbol },
          query: { days: String(days) },
        });
        const bars = await res.json();
        return {
          label: cfg.label,
          color: cfg.color,
          data: bars.map(b => ({ time: b.date, value: b.close })),
        };
      } else {
        const res = await api.api.macro[':seriesId'].$get({
          param: { seriesId: cfg.seriesId },
          query: { days: String(days) },
        });
        const points = await res.json();
        return {
          label: cfg.label,
          color: cfg.color,
          data: points.map(p => ({ time: p.date, value: p.value })),
        };
      }
    }))
      .then(result => { if (!cancelled) setSeries(result); })
      .catch(e => { if (!cancelled) setError((e as Error).message); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [JSON.stringify(configs), days]);

  return { series, loading, error };
}
```

- [ ] **Step 2: Create `src/web/components/ChartPanel.tsx`**

```tsx
import { useEffect, useRef } from 'react';
import { createChart, LineSeries, type IChartApi, type ISeriesApi } from 'lightweight-charts';
import { useChartData, type SeriesConfig } from '../hooks/useChartData';

type Props = {
  title: string;
  configs: SeriesConfig[];
  days: number;
};

const CHART_OPTIONS = {
  layout: { background: { color: '#0a0a0a' }, textColor: '#a1a1aa' },
  grid: { vertLines: { color: '#1f1f1f' }, horzLines: { color: '#1f1f1f' } },
  rightPriceScale: { borderColor: '#262626' },
  timeScale: { borderColor: '#262626', timeVisible: false },
  autoSize: true,
};

export function ChartPanel({ title, configs, days }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<Map<string, ISeriesApi<'Line'>>>(new Map());
  const { series, loading, error } = useChartData(configs, days);

  useEffect(() => {
    if (!containerRef.current) return;
    chartRef.current = createChart(containerRef.current, CHART_OPTIONS);
    return () => {
      chartRef.current?.remove();
      chartRef.current = null;
      seriesRef.current.clear();
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    // remove series no longer present
    for (const [label, s] of seriesRef.current) {
      if (!series.find(x => x.label === label)) {
        chart.removeSeries(s);
        seriesRef.current.delete(label);
      }
    }
    // add/update series
    for (const s of series) {
      let line = seriesRef.current.get(s.label);
      if (!line) {
        line = chart.addSeries(LineSeries, { color: s.color, title: s.label, lineWidth: 2 });
        seriesRef.current.set(s.label, line);
      }
      line.setData(s.data);
    }
    chart.timeScale().fitContent();
  }, [series]);

  return (
    <section className="flex h-80 flex-col rounded border border-neutral-800 p-3">
      <header className="mb-2 flex items-center justify-between">
        <h2 className="text-sm uppercase tracking-wider text-neutral-400">{title}</h2>
        <div className="flex gap-2 text-xs">
          {configs.map(c => {
            const label = c.source === 'quotes' ? c.label : c.label;
            const color = c.color;
            return <span key={label} style={{ color }}>● {label}</span>;
          })}
        </div>
      </header>
      <div ref={containerRef} className="flex-1" />
      {loading && <p className="text-xs text-neutral-500">Loading…</p>}
      {error && <p className="text-xs text-red-400">Error: {error}</p>}
    </section>
  );
}
```

- [ ] **Step 3: Verify import compiles**

Run: `bunx tsc --noEmit`
Expected: no errors. Don't expect to see anything in the browser yet — `App.tsx` still has placeholders. Next tasks wire in real panels.

- [ ] **Step 4: Commit**

```bash
git add src/web/hooks/ src/web/components/ChartPanel.tsx
git commit -m "feat(web): generic ChartPanel + useChartData hook"
```

---

### Task 17: `VolatilityPanel`

**Files:**
- Create: `src/web/panels/VolatilityPanel.tsx`
- Modify: `src/web/App.tsx`

- [ ] **Step 1: Create `src/web/panels/VolatilityPanel.tsx`**

```tsx
import { ChartPanel } from '../components/ChartPanel';
import type { SeriesConfig } from '../hooks/useChartData';

const CONFIGS: SeriesConfig[] = [
  { source: 'quotes', symbol: '^VIX',   label: 'VIX',   color: '#f87171' },
  { source: 'quotes', symbol: '^VIX9D', label: 'VIX9D', color: '#fb923c' },
  { source: 'quotes', symbol: '^VIX3M', label: 'VIX3M', color: '#fbbf24' },
  { source: 'quotes', symbol: '^VVIX',  label: 'VVIX',  color: '#a78bfa' },
  { source: 'quotes', symbol: '^SKEW',  label: 'SKEW',  color: '#60a5fa' },
];

export function VolatilityPanel({ days }: { days: number }) {
  return <ChartPanel title="Volatility" configs={CONFIGS} days={days} />;
}
```

- [ ] **Step 2: Wire into `App.tsx`**

Replace the first placeholder block in `src/web/App.tsx`:

```tsx
import { useState } from 'react';
import { Header } from './components/Header';
import { VolatilityPanel } from './panels/VolatilityPanel';

export function App() {
  const [days, setDays] = useState(180);
  return (
    <div className="min-h-screen">
      <Header days={days} onDaysChange={setDays} />
      <main className="grid grid-cols-1 gap-4 p-6 md:grid-cols-2">
        <VolatilityPanel days={days} />
        <div className="rounded border border-neutral-800 p-4">
          <h2 className="text-sm uppercase tracking-wider text-neutral-400">Macro (placeholder)</h2>
        </div>
        <div className="rounded border border-neutral-800 p-4">
          <h2 className="text-sm uppercase tracking-wider text-neutral-400">Indices (placeholder)</h2>
        </div>
        <div className="rounded border border-neutral-800 p-4">
          <h2 className="text-sm uppercase tracking-wider text-neutral-400">Other Assets (placeholder)</h2>
        </div>
      </main>
    </div>
  );
}
```

- [ ] **Step 3: Verify in browser**

Make sure daily job has run with at least quotes (FRED key not needed for quotes-only run; you can comment out the macro group temporarily for testing).
Open http://localhost:5173.
Expected: Top-left panel renders a chart with 5 overlaid lines (VIX, VIX9D, VIX3M, VVIX, SKEW). Time-range buttons in header should refetch and rerender.

- [ ] **Step 4: Commit**

```bash
git add src/web/panels/VolatilityPanel.tsx src/web/App.tsx
git commit -m "feat(web): VolatilityPanel rendering VIX family"
```

---

### Task 18: `MacroPanel`

**Files:**
- Create: `src/web/panels/MacroPanel.tsx`
- Modify: `src/web/App.tsx`

- [ ] **Step 1: Create `src/web/panels/MacroPanel.tsx`**

```tsx
import { ChartPanel } from '../components/ChartPanel';
import type { SeriesConfig } from '../hooks/useChartData';

const CONFIGS: SeriesConfig[] = [
  { source: 'macro', seriesId: 'DGS10',    label: 'UST 10Y',  color: '#34d399' },
  { source: 'macro', seriesId: 'DGS2',     label: 'UST 2Y',   color: '#22d3ee' },
  { source: 'macro', seriesId: 'DGS3MO',   label: 'UST 3M',   color: '#a3e635' },
  { source: 'macro', seriesId: 'DTWEXBGS', label: 'USD Index', color: '#f59e0b' },
];

export function MacroPanel({ days }: { days: number }) {
  return <ChartPanel title="Macro / Rates" configs={CONFIGS} days={days} />;
}
```

- [ ] **Step 2: Wire into `App.tsx`**

Replace the second placeholder:

```tsx
import { MacroPanel } from './panels/MacroPanel';
// ...
<MacroPanel days={days} />
```

- [ ] **Step 3: Verify**

`bun run job:daily` must have completed at least once with `FRED_API_KEY` set in `.env`.
Browser shows 4 macro lines in top-right panel.

Caveat: DTWEXBGS is on a very different numeric scale (~120) compared to rates (~4–5%). The chart will visually compress the rates. This is acceptable for Phase 1; a future improvement is dual-axis scaling.

- [ ] **Step 4: Commit**

```bash
git add src/web/panels/MacroPanel.tsx src/web/App.tsx
git commit -m "feat(web): MacroPanel rendering FRED series"
```

---

### Task 19: `IndicesPanel`

**Files:**
- Create: `src/web/panels/IndicesPanel.tsx`
- Modify: `src/web/App.tsx`

- [ ] **Step 1: Create `src/web/panels/IndicesPanel.tsx`**

```tsx
import { ChartPanel } from '../components/ChartPanel';
import type { SeriesConfig } from '../hooks/useChartData';

const CONFIGS: SeriesConfig[] = [
  { source: 'quotes', symbol: '^GSPC', label: 'S&P 500', color: '#e5e5e5' },
  { source: 'quotes', symbol: 'QQQ',   label: 'QQQ',     color: '#a78bfa' },
  { source: 'quotes', symbol: 'IWM',   label: 'IWM',     color: '#f472b6' },
];

export function IndicesPanel({ days }: { days: number }) {
  return <ChartPanel title="Indices" configs={CONFIGS} days={days} />;
}
```

- [ ] **Step 2: Wire into `App.tsx`**

Replace the third placeholder:

```tsx
import { IndicesPanel } from './panels/IndicesPanel';
// ...
<IndicesPanel days={days} />
```

- [ ] **Step 3: Verify**

Browser: bottom-left panel shows SPX, QQQ, IWM lines.
Same scale caveat as macro — SPX is ~5000, QQQ is ~400, IWM is ~200. Acceptable for Phase 1.

- [ ] **Step 4: Commit**

```bash
git add src/web/panels/IndicesPanel.tsx src/web/App.tsx
git commit -m "feat(web): IndicesPanel"
```

---

### Task 20: `AssetsPanel`

**Files:**
- Create: `src/web/panels/AssetsPanel.tsx`
- Modify: `src/web/App.tsx`

- [ ] **Step 1: Create `src/web/panels/AssetsPanel.tsx`**

```tsx
import { ChartPanel } from '../components/ChartPanel';
import type { SeriesConfig } from '../hooks/useChartData';

const CONFIGS: SeriesConfig[] = [
  { source: 'quotes', symbol: 'GLD',     label: 'GLD', color: '#fbbf24' },
  { source: 'quotes', symbol: 'TLT',     label: 'TLT', color: '#60a5fa' },
  { source: 'quotes', symbol: 'BTC-USD', label: 'BTC', color: '#fb923c' },
];

export function AssetsPanel({ days }: { days: number }) {
  return <ChartPanel title="Other Assets" configs={CONFIGS} days={days} />;
}
```

- [ ] **Step 2: Wire into `App.tsx`**

Final `src/web/App.tsx`:

```tsx
import { useState } from 'react';
import { Header } from './components/Header';
import { VolatilityPanel } from './panels/VolatilityPanel';
import { MacroPanel } from './panels/MacroPanel';
import { IndicesPanel } from './panels/IndicesPanel';
import { AssetsPanel } from './panels/AssetsPanel';

export function App() {
  const [days, setDays] = useState(180);
  return (
    <div className="min-h-screen">
      <Header days={days} onDaysChange={setDays} />
      <main className="grid grid-cols-1 gap-4 p-6 md:grid-cols-2">
        <VolatilityPanel days={days} />
        <MacroPanel days={days} />
        <IndicesPanel days={days} />
        <AssetsPanel days={days} />
      </main>
    </div>
  );
}
```

- [ ] **Step 3: Verify full dashboard**

All 4 panels render with data. Time-range switching works for all panels. No console errors.

- [ ] **Step 4: Commit**

```bash
git add src/web/panels/AssetsPanel.tsx src/web/App.tsx
git commit -m "feat(web): AssetsPanel completing Phase 1 dashboard"
```

---

### Task 21: launchd daily job

**Files:**
- Create: `launchd/com.user.mtv.daily.plist.template`
- Create: `scripts/install-launchd.sh`

- [ ] **Step 1: Create plist template**

`launchd/com.user.mtv.daily.plist.template`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.user.mtv.daily</string>
  <key>ProgramArguments</key>
  <array>
    <string>__BUN_PATH__</string>
    <string>run</string>
    <string>job:daily</string>
  </array>
  <key>WorkingDirectory</key>
  <string>__PROJECT_ROOT__</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>__BUN_DIR__:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>8</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>__PROJECT_ROOT__/data/logs/daily.log</string>
  <key>StandardErrorPath</key>
  <string>__PROJECT_ROOT__/data/logs/daily.err.log</string>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
```

- [ ] **Step 2: Create installer script**

`scripts/install-launchd.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE="$PROJECT_ROOT/launchd/com.user.mtv.daily.plist.template"
TARGET="$HOME/Library/LaunchAgents/com.user.mtv.daily.plist"
BUN_PATH="$(command -v bun)"
if [[ -z "$BUN_PATH" ]]; then
  echo "bun not found in PATH" >&2; exit 1
fi
BUN_DIR="$(dirname "$BUN_PATH")"

mkdir -p "$PROJECT_ROOT/data/logs"
mkdir -p "$HOME/Library/LaunchAgents"

sed \
  -e "s|__BUN_PATH__|$BUN_PATH|g" \
  -e "s|__BUN_DIR__|$BUN_DIR|g" \
  -e "s|__PROJECT_ROOT__|$PROJECT_ROOT|g" \
  "$TEMPLATE" > "$TARGET"

launchctl unload "$TARGET" 2>/dev/null || true
launchctl load "$TARGET"

echo "Installed launchd job at $TARGET"
echo "Will run daily at 08:00 local time."
echo "To run immediately: launchctl start com.user.mtv.daily"
echo "To uninstall: launchctl unload $TARGET && rm $TARGET"
```

- [ ] **Step 3: Make executable**

Run: `chmod +x scripts/install-launchd.sh`

- [ ] **Step 4: Install and trigger once**

Run:
```bash
./scripts/install-launchd.sh
launchctl start com.user.mtv.daily
sleep 30
ls -la data/logs/
cat data/logs/daily.log
```
Expected: log file shows "Daily job complete." and exit code 0.

- [ ] **Step 5: Commit**

```bash
git add launchd/ scripts/
git commit -m "feat(ops): launchd plist template and installer"
```

---

### Task 22: End-to-end smoke test

**Files:** none (verification only)

- [ ] **Step 1: Clean slate run**

```bash
rm -f data/mtv.db
bun run db:migrate
bun run job:daily
```
Expected: no errors. `data/mtv.db` exists. `job_run` table has 2 rows (quotes, macro), both `success`.

- [ ] **Step 2: API smoke**

In one terminal: `bun run dev:server`
In another:
```bash
curl -s http://localhost:3000/api/health | jq '.jobs | length'      # expect: 2
curl -s http://localhost:3000/api/catalog | jq '.quotes | length'   # expect: 11
curl -s 'http://localhost:3000/api/quotes/%5EVIX?days=30' | jq '. | length'  # expect: >15
curl -s 'http://localhost:3000/api/macro/DGS10?days=30' | jq '. | length'    # expect: >15
```

- [ ] **Step 3: UI smoke**

`bun run dev:web` (other terminal). Open http://localhost:5173.

Manual checklist:
- [ ] Status light is green
- [ ] All 4 panels render lines (no blank charts)
- [ ] Clicking 90D / 180D / 1Y / All updates all panels
- [ ] No console errors
- [ ] Resizing the window resizes the charts

- [ ] **Step 4: Run full test suite**

Run: `bun test`
Expected: all tests pass (repository: 9, fetchers: 6, daily job: 3 = 18 tests minimum).

- [ ] **Step 5: Commit final tag**

```bash
git tag -a phase1-complete -m "Phase 1 dashboard working end-to-end"
```

---

## Self-Review Notes

This plan was checked against the spec on completion:

- **Goal & scope (§1)** → covered by Tasks 1–22.
- **Indicators (§2)** → tickers in `src/server/config.ts` (Task 2) cover all 11 quotes + 4 macro series.
- **Tech stack (§3)** → all libs pinned in Task 1 `package.json`.
- **Project layout (§4)** → file structure matches the spec exactly.
- **Storage schema (§5)** → Task 2's `schema.sql` matches the spec verbatim.
- **API endpoints (§6)** → Tasks 9–12 implement health, quotes, macro, catalog with shared types in Task 5.
- **Frontend layout (§7)** → Tasks 13–20 build the 2×2 grid with global time range.
- **Daily job (§8)** → Tasks 8 and 21 implement the orchestrator and launchd hookup.
- **Error handling (§9)** → Task 8's daily job covers per-group try/catch + partial status; StatusLight (Task 15) surfaces it in UI.
- **Testing (§10)** → unit tests for storage, fetchers, and daily job; UI verified manually per spec.
- **Phase 2 deferrals (§11)** → not in scope; the option tables are intentionally absent from `schema.sql` and will be added by a future migration.

No placeholders, every code block is complete, file paths are concrete throughout.
