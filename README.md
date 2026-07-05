# my-trading-view

A personal, local-only markets dashboard, organized as **vertical perspectives**
(a left rail) × horizontal sub-tabs:

- **期权 (Options)** — daily 25Δ IV + skew snapshot of SPY / QQQ / VIX / TLT / GLD / USO
  (via moomoo OpenD) and BTC (via Deribit), stored in SQLite. Underlyings with a free
  volatility index (SPY/QQQ/GLD/USO/BTC) also get implied-vs-realized + VRP panes.
- **信用 / 流动性 / 情绪 (Credit / Liquidity / Sentiment)** — macro *regime* indicators
  pulled on demand from FRED / CBOE / CNN (see below). The sentiment view adds trailing
  P5/P95 percentile bands, a current-percentile badge, and red/green background shading of
  extreme periods.

Built to track things TradingView doesn't expose well (25Δ skew, a composite regime read)
in one local page.

## Tech stack

- **Runtime:** [Bun](https://bun.sh) (TypeScript end-to-end, no Node required)
- **Backend:** [Hono](https://hono.dev) on `Bun.serve` + `bun:sqlite`
- **Frontend:** React 19 + Vite + Tailwind CSS v4 + [Lightweight Charts](https://github.com/tradingview/lightweight-charts) v5
- **Data sources:**
  - moomoo OpenD (local WebSocket) — stock/ETF/index options
  - [Deribit](https://docs.deribit.com) public REST — crypto options + BTC spot
  - CBOE public CSV — VIX/VXN/GVZ/OVX, COR1M/VIXEQ, VX1/VX3 futures, RXM (PutWrite) + SPX
  - [FRED](https://fred.stlouisfed.org/docs/api/api_key.html) — credit spread, net liquidity, repo (needs a free API key)
  - CNN — Fear & Greed index
  - Yahoo — price fallback
- **Scheduling:** macOS `launchd` (daily job, options + VRP + VX only)

The end-to-end type safety from server routes to React components flows through
Hono's `hc<AppType>` typed client — there's no hand-written API client.

> **Options are snapshot-only.** The 25Δ series accumulates one point per trading day
> from first run forward — it cannot be backfilled (the 25Δ strike rolls daily).
> **Regime indicators are the opposite** — all historical series, so `/api/regime`
> pulls them on demand (zero storage) and caches the response in memory for 6h.

## Setup

```bash
git clone https://github.com/<your-user>/my-trading-view.git
cd my-trading-view
bun install

cp .env.example .env
$EDITOR .env                    # moomoo OpenD host/port/key + FRED_API_KEY (free)

bun run db:migrate              # one-time
```

moomoo options require [OpenD](https://www.moomoo.com/download/OpenAPI) running locally
with WebSocket enabled (default `127.0.0.1:33333`). Deribit needs no key. The regime views
need `FRED_API_KEY` (free); CBOE/CNN need nothing. See [AGENTS.md](AGENTS.md) for gotchas.

## Run the dashboard

```bash
bun run dev                     # Hono on :3000 + Vite on :5173 in one terminal
```

Open <http://localhost:5173>. Ctrl-C kills both. For separate logs: `bun run dev:server` / `bun run dev:web`.

## Collect data

```bash
bun run job:daily               # options (moomoo) + VRP inputs + VX1/VX3 term structure
bun run job:crypto              # BTC options + spot (Deribit) — separate, no OpenD needed
```

`job:daily` needs OpenD for the moomoo leg; if it's down that group fails and the others
still run. Each underlying is independent. **The regime views (credit/liquidity/sentiment)
need no job** — they fetch live per request. Only VIX/VXN and VX1/VX3 (maintained by
`job:daily`) are read from the DB by the regime endpoint.

## Schedule the daily job (macOS)

Two hand-managed `launchd` agents (plists in `~/Library/LaunchAgents`, not in git):

- `com.mtv.daily` — stocks via OpenD, Tue–Sat at 10/13/16/19/22 local.
- `com.mtv.crypto` — BTC via Deribit (no OpenD), every day at the same hours.

Each runs 5×/day; the job's "succeed once, then skip" guard stops after the first all-green
run. Logs in `data/logs/`. After editing a plist, reload with
`launchctl bootout gui/$(id -u)/<label>` then `bootstrap gui/$(id -u) <plist>`.
Check recent runs with `./scripts/cron.sh history`.

## Layout

```
src/
├── shared/types.ts          types shared between server and web
├── server/
│   ├── index.ts             Hono app, exports AppType
│   ├── routes/              health · options · vrp · price · regime
│   ├── fetchers/            moomoo · deribit · cboeIndex · cboeVx · fred · cnnFearGreed · yahoo
│   ├── analytics/           vrp · termStructure · regime (all pure, read-time compute)
│   ├── storage/             bun:sqlite schema, migrations, repository
│   └── jobs/                daily.ts orchestrator + optionsSnapshot / vrpInputs / vxTermStructure / cryptoDaily
└── web/
    ├── App.tsx              vertical perspectives (期权/信用/流动性/情绪) × horizontal tabs, keep-alive
    ├── components/          Header, StatusLight, TabBar (horizontal + vertical variants)
    ├── lib/                 chart helpers + stats (percentile)
    └── panels/
        ├── PaneChartView    shared multi-pane chart shell (toolbar + crosshair legend)
        ├── AssetChart       options: per-underlying panes (25Δ + optional VRP)
        └── RegimeChart      regime: per-dimension panes (bands / signed histogram)
```

## Perspectives

**期权 (Options)** — horizontal tabs per underlying; each shows spot candles + 25Δ call/put
IV + skew, plus implied-vs-realized + VRP where a free vol index exists:

| Tab | Underlying | Source | VRP (implied / realized) |
|---|---|---|---|
| SPY | `SPY`  | moomoo OpenD | VIX / SPX |
| QQQ | `QQQ`  | moomoo OpenD | VXN / NDX |
| VIX | `.VIX` | moomoo OpenD | — |
| TLT | `TLT`  | moomoo OpenD | — |
| GLD | `GLD`  | moomoo OpenD | GVZ / GLD |
| USO | `USO`  | moomoo OpenD | OVX / USO |
| BTC | `BTC`  | Deribit | DVOL / BTC |

**Regime** — one pane per indicator, served by `/api/regime` (fetch-on-demand, cached):

| Perspective | Panes | Source |
|---|---|---|
| 信用 Credit | HY OAS credit spread | FRED |
| 流动性 Liquidity | net liquidity (WALCL−TGA−RRP) · reverse repo · repo usage · repo stress (IORB−SOFR) | FRED |
| 情绪 Sentiment | Fear&Greed · COR1M · VIXEQ · VIX · VXN · VX1−V3 term structure · RXM/SPX (PutWrite vs SPX) | CNN / CBOE / DB |

Sentiment panes carry P5/P95 percentile bands + a current-percentile badge, and shade
extreme periods red (risk end) / green (opportunity end) per each series' direction.

## License

[MIT](LICENSE)
