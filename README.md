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
