# my-trading-view

A personal, local-only markets dashboard, organized as **vertical perspectives**
(a left rail) × horizontal sub-tabs:

- **期权 (Options)** — daily 25Δ IV + skew snapshot of SPY / QQQ / VIX / TLT / GLD / USO
  (via moomoo OpenD) and BTC (via Deribit), stored in SQLite. Underlyings with a free
  volatility index (SPY/QQQ/GLD/USO/BTC) also get implied-vs-realized + VRP panes.
- **Regime perspectives** — macro/market *regime* indicators pulled on demand from
  FRED / CBOE / CNN / Yahoo / Eris / MOF+JPX / CFTC / Shiller: **信用 · 流动性 · 情绪 ·
  宏观 · 能源 · 利率 · 日本 · 信用曲线 · 通胀 · 估值**, plus a **特色指标 → 攻防** tab
  (NOBL/QQQ offense-defense regime via ZigZag). Series with a trailing distribution add
  P5/P95 bands, a current-percentile badge, and red/green shading of extreme periods.

The whole rail (视角) + its tabs live in one registry ([`src/web/perspectives.tsx`](src/web/perspectives.tsx));
each tab carries its own render factory. Built to track things TradingView doesn't expose
well (25Δ skew, a composite regime read, yield/OIS/JGB curves) in one local page.

## Tech stack

- **Runtime:** [Bun](https://bun.sh) (TypeScript end-to-end, no Node required)
- **Backend:** [Hono](https://hono.dev) on `Bun.serve` + `bun:sqlite`
- **Frontend:** React 19 + Vite + Tailwind CSS v4 + [Lightweight Charts](https://github.com/tradingview/lightweight-charts) v5
- **Tooling:** [Biome](https://biomejs.dev) for lint + format (Rust, no `typescript` dep → works with TS7, which typescript-eslint doesn't). `react-hooks/exhaustive-deps` is an **error**.
- **Data sources:**
  - moomoo OpenD (local WebSocket) — stock/ETF/index options
  - [Deribit](https://docs.deribit.com) public REST — crypto options + BTC spot + DVOL
  - CBOE public CSV — VIX/VXN/GVZ/OVX, COR1M/VIXEQ, VX1/VX3 futures, RXM (Risk Reversal) + SPX
  - [FRED](https://fred.stlouisfed.org/docs/api/api_key.html) — rates/TIPS · credit spread · net liquidity · repo · inflation (BEI · sticky CPI · wages) (needs a free API key)
  - Yahoo (`yahoo-finance2` v4) — DXY (`DX-Y.NYB`) · MOVE (`^MOVE`) · oil futures (`CL/BZ/HO/RB=F`) · USD-JPY · stock EOD fallback
  - Eris — SOFR OIS par curve · MOF + JPX — JGB yields / JGB VIX · CFTC — JPY net positioning · Shiller — CAPE · CNN — Fear & Greed
- **Scheduling:** macOS `launchd` (daily job, options + VRP + VX + Eris)

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
bun run job:daily               # options (moomoo) + VRP inputs + VX1/VX3 term + Eris SOFR OIS + trading calendar
bun run job:crypto              # BTC options + spot (Deribit) — separate, no OpenD needed
```

`job:daily` needs OpenD for the moomoo leg; if it's down that group fails and the others
still run. Each underlying is independent. **Most regime perspectives fetch live per
request** (FRED/Yahoo/CFTC/etc., cached 6h). Only the stored series — VIX/VXN, VX1/VX3,
Eris SOFR OIS, BTC — are read from the DB by the regime / yield-curve endpoints.

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
├── shared/                  types · stats · marketCatalog (标的元数据单一真相源;前后端派生)
├── server/
│   ├── index.ts             Hono app, exports AppType
│   ├── config.ts            option/price whitelists (derived from marketCatalog)
│   ├── routes/              health · options · vrp · price · regime · yieldCurve
│   ├── fetchers/            moomoo · deribit · cboe(Index/Vx) · fred · yahoo · eris · jpxJgbVix · mofJgb · cftcCot · capeShiller · cnnFearGreed
│   ├── analytics/           vrp · termStructure · regime · rateCurves (all pure, read-time compute)
│   ├── storage/             bun:sqlite schema, migrations, repository
│   └── jobs/                daily orchestrator + optionsSnapshot / vrpInputs / vxTermStructure / cryptoDaily / erisSnapshot / btcPrice / tradingCalendar
└── web/
    ├── App.tsx              shell only (vertical perspectives × horizontal tabs, keep-alive)
    ├── perspectives.tsx     tab registry — each tab carries its own render() (asset/regime/curve/history factories)
    ├── components/          Header · TabBar · StatusLight · InfoTip · DatePickerWithPresets
    ├── hooks/               interval · useStable · usePerspectiveNavigation
    ├── lib/                 chart · palette · zigzag
    └── panels/
        ├── chart/           shared multi-pane infra (paneChart.hooks/types + PaneChartView) — data-source-agnostic
        ├── asset/           options: AssetChart + hooks (25Δ + optional VRP)
        ├── regime/          regime: RegimeChart + REGIME_DIMS (self-contained PaneSpec[] → specs)
        ├── attackDefense/   NOBL/QQQ ratio + ZigZag offense/defense regimes
        └── rates/           yield-curve + tenor-history (YieldCurve* / TenorHistory* / shared yieldCurve+rateSpread hooks)
```

Each panel is a thin shell: **fetch model (data hook) → pure buildSpecs → shared pane infra**.
"Add an indicator/tab/underlying" = add one entry to its domain source-of-truth
(`REGIME_DIMS` / `PERSPECTIVES` / `MARKET_CATALOG`), nothing else moves.

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

**Regime perspectives** — indicator panes (`/api/regime`, fetch-on-demand + cached) and
curve/history panels (`/api/yield-curve`). Each perspective is one rail entry; some carry
several horizontal tabs:

| Perspective | Tabs / panes | Source |
|---|---|---|
| 信用 Credit | HY OAS credit spread | FRED |
| 流动性 Liquidity | net liquidity (WALCL−TGA−RRP) · reverse repo · repo usage · repo stress (IORB−SOFR) | FRED |
| 情绪 Sentiment | 波动率 (COR1M · VIXEQ · VIX · VXN · VX1−V3 term · RXM/SPX risk-reversal) · 情绪 (Fear&Greed) | CBOE / CNN |
| 宏观 Macro | growth/inflation/policy regime read | FRED |
| 能源 Energy | Brent−WTI spread · diesel crack (油市结构 / 物理紧张) | Yahoo |
| 利率 Rates | 收益曲线 · 期限走势 · SOFR OIS · OIS 走势 · 利率波动率 (MOVE) | FRED / Eris / Yahoo |
| 日本 Japan | 日元 (USD-JPY + CFTC 持仓) · JGB 收益曲线 · 期限走势 · 日债波动率 (JGB VIX) | Yahoo / CFTC / MOF / JPX |
| 信用曲线 Credit curve | 评级利差 · 期限结构 | FRED |
| 通胀 Inflation | 通胀预期 (BEI) · 通胀走势 · 通胀来源 (RBOB YoY 等) | FRED / Yahoo |
| 估值 Valuation | Shiller CAPE regime | Shiller |
| 特色指标 Featured | 攻防 — NOBL/QQQ offense-defense via ZigZag | Yahoo |

Series with a trailing distribution carry P5/P95 bands + a current-percentile badge, and
shade extreme periods red (risk end) / green (opportunity end) per each series' direction.

## License

[MIT](LICENSE)
