import { resolve } from 'node:path';

export const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');
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
