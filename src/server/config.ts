import { resolve } from 'node:path';

export const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');
export const DB_PATH = resolve(PROJECT_ROOT, 'data', 'mtv.db');

/** Earliest trade date we keep. Used by all backfill + filter logic. */
export const HISTORY_START_DATE = '2007-01-01';
/** Corresponding day count for API/frontend caps (~22y headroom). */
export const HISTORY_MAX_DAYS = 8000;

/** Symbols fetched from Yahoo (yahoo-finance2). */
export const QUOTE_SYMBOLS = [
  { symbol: '^GSPC',   label: 'S&P 500', group: 'index' as const },
  { symbol: 'QQQ',     label: 'QQQ',   group: 'index' as const },
  { symbol: 'IWM',     label: 'IWM',   group: 'index' as const },
  { symbol: 'GLD',     label: 'GLD',   group: 'asset' as const },
  { symbol: 'TLT',     label: 'TLT',   group: 'asset' as const },
  { symbol: 'BTC-USD', label: 'BTC',   group: 'asset' as const },
];

/**
 * Indices fetched directly from CBOE (cdn.cboe.com), which has full history
 * dating back to the 1990s or earlier. `cboeSymbol` is the URL token; we
 * store under `symbol` (with `^` prefix to stay consistent with the
 * Yahoo-style naming used elsewhere in the DB).
 */
export const CBOE_INDEX_SYMBOLS = [
  { symbol: '^VIX',    cboeSymbol: 'VIX',    label: 'VIX',   group: 'volatility' as const },
  { symbol: '^VIX9D',  cboeSymbol: 'VIX9D',  label: 'VIX9D', group: 'volatility' as const },
  { symbol: '^VIX3M',  cboeSymbol: 'VIX3M',  label: 'VIX3M', group: 'volatility' as const },
  { symbol: '^VIX6M',  cboeSymbol: 'VIX6M',  label: 'VIX6M', group: 'volatility' as const },
  { symbol: '^VIX1Y',  cboeSymbol: 'VIX1Y',  label: 'VIX1Y', group: 'volatility' as const },
  { symbol: '^VVIX',   cboeSymbol: 'VVIX',   label: 'VVIX',  group: 'volatility' as const },
  { symbol: '^SKEW',   cboeSymbol: 'SKEW',   label: 'SKEW',  group: 'volatility' as const },
  { symbol: '^RXM',    cboeSymbol: 'RXM',    label: 'RXM',   group: 'strategy'   as const },
];

// Underlyings to snapshot options for via moomoo; stored verbatim as the
// `underlying` key. SPY only for now, expand later.
export const OPTIONS_UNDERLYINGS = ['SPY'];

export const MACRO_SERIES = [
  { id: 'DGS10',     label: 'UST 10Y',  unit: '%' },
  { id: 'DGS2',      label: 'UST 2Y',   unit: '%' },
  { id: 'DGS3MO',    label: 'UST 3M',   unit: '%' },
  { id: 'DTWEXBGS',  label: 'USD Index (broad)', unit: 'index' },
];
