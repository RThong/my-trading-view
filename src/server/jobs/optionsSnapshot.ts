import type { Database } from 'bun:sqlite';
import { insertOptions25Delta, insertOptionChainRaw, type Options25DeltaRow, type OptionChainRawRow } from '../storage/repository';
import { callDelta } from '../analytics/greeks';
import type { OptionChainSnapshot, YahooOptionsClient } from '../fetchers/yahooOptions';
import { lastClosedTradingDate } from './tradingCalendar';

// NOTE: VIX option pricing here uses plain Black-Scholes with VIX *spot* as
// the underlying. Real VIX options are priced off VIX *futures*, so our 25Δ
// strike selection may be off by 1-2 strikes vs the "true" 25Δ. For the
// purpose of tracking IV trends this is acceptable.

const TARGET_DTE = 30;
const DEFAULT_RATE = 0.045;

export type Selection = {
  callIv: number;
  putIv: number;
  skew: number;
  callStrike: number;
  putStrike: number;
};

/** Picks 25-delta call & 25-delta put strikes from a chain. */
export function select25Delta(
  chain: OptionChainSnapshot,
  rate: number,
  todayMs: number = Date.now(),
): Selection {
  const expiryMs = new Date(chain.expirationDate + 'T16:00:00Z').getTime();
  const yearsToExpiry = Math.max((expiryMs - todayMs) / (365 * 86_400_000), 1 / 365);
  const spot = chain.underlyingPrice;

  // For each call strike, compute delta; pick min |delta − 0.25|.
  const callPick = pickClosest(chain.calls, (c) => {
    const d = callDelta({ spot, strike: c.strike, yearsToExpiry, iv: c.impliedVolatility, rate });
    return Math.abs(d - 0.25);
  });
  // For each put strike, put_delta ≈ −0.25 iff call_delta(same K) ≈ 0.75.
  const putPick = pickClosest(chain.puts, (p) => {
    const d = callDelta({ spot, strike: p.strike, yearsToExpiry, iv: p.impliedVolatility, rate });
    return Math.abs(d - 0.75);
  });

  return {
    callIv: callPick.impliedVolatility,
    putIv: putPick.impliedVolatility,
    skew: putPick.impliedVolatility - callPick.impliedVolatility,
    callStrike: callPick.strike,
    putStrike: putPick.strike,
  };
}

function pickClosest<T>(arr: T[], distance: (x: T) => number): T {
  if (arr.length === 0) throw new Error('empty array');
  let best = arr[0];
  let bestD = distance(best);
  for (let i = 1; i < arr.length; i++) {
    const d = distance(arr[i]);
    if (d < bestD) { best = arr[i]; bestD = d; }
  }
  return best;
}

type RunOpts = {
  db: Database;
  underlyings: Array<'SPX' | 'VIX'>;
  yahooOptions: YahooOptionsClient;
  riskFreeRate: number;
};

const TICKER: Record<'SPX' | 'VIX', string> = { SPX: '^SPX', VIX: '^VIX' };

export async function runOptionsSnapshot(opts: RunOpts): Promise<Options25DeltaRow[]> {
  // Yahoo's option chain serves the most recent close on weekends/after-hours,
  // so stamp the snapshot with the last *closed* US trading day rather than
  // wall-clock today. Idempotent under upsert: a weekend run and the actual
  // Friday-evening run will write to the same row.
  const today = lastClosedTradingDate();
  const rows: Options25DeltaRow[] = [];
  const rawRows: OptionChainRawRow[] = [];
  for (const u of opts.underlyings) {
    const chain = await opts.yahooOptions.fetchChain(TICKER[u], TARGET_DTE);
    const sel = select25Delta(chain, opts.riskFreeRate);

    // Scale convention must match seedMockOptions.ts:
    //   SPX mock stores values like 17.0 (17% IV) — so Yahoo's 0.17 must be * 100.
    //   VIX mock stores values like 0.32 (ratio scale) — Yahoo returns 0.x already,
    //   so no scaling needed. Note: real VIX IVs may be 0.7-1.2 range (70-120%),
    //   which will look different from the mock's 0.30-0.34 on the same chart.
    //   That's expected — real and mock series are different things.
    const scale = u === 'SPX' ? 100 : 1;
    rows.push({
      underlying: u,
      snapshotDate: today,
      callIv: sel.callIv * scale,
      putIv: sel.putIv * scale,
      skew: sel.skew * scale,
      isMock: false,
    });

    // Archive the full chain (gzipped) for future analyses (max pain, OI distribution, GEX, etc.)
    const chainJson = JSON.stringify({ calls: chain.calls, puts: chain.puts });
    const gz = Bun.gzipSync(new TextEncoder().encode(chainJson));
    rawRows.push({
      underlying: u,
      snapshotDate: today,
      expiry: chain.expirationDate,
      underlyingPrice: chain.underlyingPrice,
      chainJsonGz: gz,
    });
  }
  insertOptions25Delta(opts.db, rows);
  insertOptionChainRaw(opts.db, rawRows);
  return rows;
}

export const TICKERS = TICKER;
export { TARGET_DTE, DEFAULT_RATE };
