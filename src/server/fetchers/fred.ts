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
