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
