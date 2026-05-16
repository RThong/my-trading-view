import { describe, test, expect } from 'bun:test';
import { createFredFetcher } from './fred';

describe('fred fetcher', () => {
  test('fetchSeries parses observations into MacroRow shape', async () => {
    const fakeFetch =async (input: string) => {
      const url = String(input);
      expect(url).toContain('series_id=DGS10');
      expect(url).toContain('api_key=test-key');
      return new Response(JSON.stringify({
        observations: [
          { date: '2026-05-10', value: '4.20' },
          { date: '2026-05-11', value: '4.25' },
          { date: '2026-05-12', value: '.' },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const fetcher = createFredFetcher({ apiKey: 'test-key', fetch: fakeFetch });
    const rows = await fetcher.fetchSeries('DGS10', '2026-05-01');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ seriesId: 'DGS10', obsDate: '2026-05-10', value: 4.20 });
    expect(rows[1].value).toBe(4.25);
  });

  test('fetchSeries throws on non-200', async () => {
    const fakeFetch =async () =>
      new Response('forbidden', { status: 403 });
    const fetcher = createFredFetcher({ apiKey: 'k', fetch: fakeFetch });
    await expect(fetcher.fetchSeries('DGS10', '2026-05-01')).rejects.toThrow(/FRED/);
  });

  test('fetchSeries throws on missing api key', async () => {
    const fetcher = createFredFetcher({ apiKey: '', fetch });
    await expect(fetcher.fetchSeries('DGS10', '2026-05-01')).rejects.toThrow(/FRED_API_KEY/);
  });
});
