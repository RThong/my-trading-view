# my-trading-view

A personal, local-only options dashboard. Captures a daily 25-delta snapshot of
SPY / VIX (via moomoo OpenD) and BTC (via Deribit), stores it in SQLite, and
renders the call/put IV + skew history as React charts. Built to track 25Δ
skew that TradingView doesn't expose well.

> **Status:** Options-only. The earlier multi-panel build (quotes / macro /
> indices / volatility) has been stripped out; see git history if you need it.

## Tech stack

- **Runtime:** [Bun](https://bun.sh) (TypeScript end-to-end, no Node required)
- **Backend:** [Hono](https://hono.dev) on `Bun.serve` + `bun:sqlite`
- **Frontend:** React 19 + Vite + Tailwind CSS v4 + [Lightweight Charts](https://github.com/tradingview/lightweight-charts) v5
- **Data sources:** moomoo OpenD (local WebSocket, stocks/ETFs/indices) + [Deribit](https://docs.deribit.com) public REST (crypto)
- **Scheduling:** macOS `launchd` (daily job)

The end-to-end type safety from server routes to React components flows through
Hono's `hc<AppType>` typed client — there's no hand-written API client.

> **Options are snapshot-only.** The 25Δ series accumulates one point per
> trading day from first run forward — it cannot be backfilled (the 25Δ strike
> rolls daily, so a fixed contract's history can't reconstruct the series).

## Setup

```bash
git clone https://github.com/<your-user>/my-trading-view.git
cd my-trading-view
bun install

cp .env.example .env
$EDITOR .env                    # moomoo OpenD host/port/key (see AGENTS.md)

bun run db:migrate              # one-time
```

moomoo options require [OpenD](https://www.moomoo.com/download/OpenAPI) running
locally with WebSocket enabled (default `127.0.0.1:33333`). Deribit needs no key.
See [AGENTS.md](AGENTS.md) for data-source gotchas.

## Run the dashboard

```bash
bun run dev                     # Hono on :3000 + Vite on :5173 in one terminal
```

Open <http://localhost:5173>. Ctrl-C kills both. For separate logs:

```bash
bun run dev:server
bun run dev:web
```

## Collect data

```bash
bun run job:daily               # snapshots SPY/.VIX (moomoo) + BTC (Deribit)
```

OpenD must be running for the moomoo leg; if it's down, that job group fails and
the Deribit (crypto) group still runs. Each underlying is independent.

## Schedule the daily job (macOS)

```bash
./scripts/install-launchd.sh
```

Installs a `launchd` agent that runs `bun run job:daily` daily at 08:00 local
time. Logs go to `data/logs/`. Uninstall instructions are printed by the installer.

## Layout

```
src/
├── shared/types.ts          types shared between server and web
├── server/
│   ├── index.ts             Hono app, exports AppType
│   ├── routes/              health + options
│   ├── fetchers/            moomooOptions + deribitOptions (DI for tests)
│   ├── storage/             bun:sqlite schema, migrations, repository
│   └── jobs/                daily.ts (snapshot orchestrator) + optionsSnapshot.ts
└── web/
    ├── App.tsx              top-level layout (SPY / VIX / BTC tabs)
    ├── components/          Header, StatusLight, TabBar
    └── panels/OptionsPanel  parametrized by underlying
```

## Tabs

| Tab | Underlying | Source |
|---|---|---|
| SPY Options (25Δ) | `SPY` | moomoo OpenD |
| VIX Options (25Δ) | `.VIX` | moomoo OpenD |
| BTC Options (25Δ) | `BTC` | Deribit |

## License

[MIT](LICENSE)
