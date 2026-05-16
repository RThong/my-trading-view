# my-trading-view

A personal, local-only market state dashboard. Pulls daily EOD data from Yahoo
Finance and FRED, stores it in SQLite, and renders a multi-panel React chart
view. Built to track indicators TradingView doesn't expose well (eventually
including SPY 25-delta one-month options — Phase 2).

> **Status:** Phase 1 complete. Skeleton + 4 chart panels (volatility, macro
> rates, indices, other assets). Phase 2 (options) is not yet planned out.

## Tech stack

- **Runtime:** [Bun](https://bun.sh) (TypeScript end-to-end, no Node required)
- **Backend:** [Hono](https://hono.dev) on `Bun.serve` + `bun:sqlite`
- **Frontend:** React 19 + Vite + Tailwind CSS v4 + [Lightweight Charts](https://github.com/tradingview/lightweight-charts) v5
- **Data sources:** [`yahoo-finance2`](https://github.com/gadicc/yahoo-finance2) (v3) and [FRED](https://fred.stlouisfed.org/docs/api/fred/) REST API
- **Scheduling:** macOS `launchd` (daily job)

The end-to-end type safety from server routes to React components flows through
Hono's `hc<AppType>` typed client — there's no hand-written API client.

## Setup

```bash
git clone https://github.com/<your-user>/my-trading-view.git
cd my-trading-view
bun install

# Grab a free FRED API key (30 seconds): https://fred.stlouisfed.org/docs/api/api_key.html
cp .env.example .env
$EDITOR .env                    # paste your key

bun run db:migrate              # one-time
bun run job:daily               # first run pulls ~6 months of history
```

## Run the dashboard

```bash
bun run dev                     # Hono on :3000 + Vite on :5173 in one terminal
```

Open <http://localhost:5173>. Ctrl-C kills both.

If you'd rather have separate terminals (clearer logs), run them individually:

```bash
bun run dev:server
bun run dev:web
```

## Schedule the daily job (macOS)

```bash
./scripts/install-launchd.sh
```

This installs a `launchd` agent that runs `bun run job:daily` every day at
08:00 local time. Logs go to `data/logs/`. Uninstall instructions are printed
by the installer.

## Layout

```
src/
├── shared/types.ts          types shared between server and web
├── server/
│   ├── index.ts             Hono app, exports AppType
│   ├── routes/              one route file per indicator family
│   ├── fetchers/            yahoo-finance2 + FRED, with DI for tests
│   ├── storage/             bun:sqlite schema, migrations, repository
│   └── jobs/daily.ts        nightly orchestrator
└── web/
    ├── App.tsx              top-level layout
    ├── components/          Header, StatusLight, generic ChartPanel
    ├── panels/              one file per panel (Volatility, Macro, …)
    └── api/client.ts        hc<AppType> typed client
```

## Indicators included (Phase 1)

| Group | Tickers |
|---|---|
| Volatility | `^VIX`, `^VIX9D`, `^VIX3M`, `^VVIX`, `^SKEW` |
| Indices | `^GSPC` (S&P 500), `QQQ`, `IWM` |
| Other assets | `GLD`, `TLT`, `BTC-USD` |
| Macro / rates | UST 10Y, 2Y, 3M; broad-trade USD index (FRED) |

## Design docs

- [Spec](docs/superpowers/specs/2026-05-16-my-trading-view-design.md)
- [Implementation plan](docs/superpowers/plans/2026-05-16-my-trading-view-phase1.md)

## License

[MIT](LICENSE)
