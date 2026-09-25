import type { MacroRow } from '../storage/repository';
import { fetchWithTimeout } from './http';

type FetchFn = (url: string) => Promise<Response>;

type FredOpts = {
  apiKey: string;
  fetch?: FetchFn;
};

type Observation = { date: string; value: string; realtime_start: string };

export function createFredFetcher(opts: FredOpts) {
  const doFetch = opts.fetch ?? fetchWithTimeout;
  const base = 'https://api.stlouisfed.org/fred/series/observations';

  async function observations(seriesId: string, extra: Record<string, string>): Promise<Observation[]> {
    if (!opts.apiKey) {
      throw new Error('FRED_API_KEY is required');
    }

    const params = new URLSearchParams({ series_id: seriesId, api_key: opts.apiKey, file_type: 'json', ...extra });

    const res = await doFetch(`${base}?${params}`);
    if (!res.ok) {
      throw new Error(`FRED request failed for ${seriesId}: ${res.status} ${await res.text()}`);
    }

    const body = (await res.json()) as { observations: Observation[] };
    // '.' = 该期无值(如 2025-10 的 CPI 因停摆从未发布)
    return body.observations.filter((o) => o.value !== '.' && o.value !== '');
  }

  return {
    async fetchSeries(seriesId: string, since: string): Promise<MacroRow[]> {
      const rows = await observations(seriesId, { observation_start: since });
      return rows.map((o) => ({ seriesId, obsDate: o.date, value: Number(o.value) }));
    },

    /**
     * 每个观测期的**首发日**(ALFRED `output_type=4` = Initial Release Only:每期只留第一次出现的那个 vintage,
     * 其 realtime_start 就是发布日)。
     *
     * 为什么不用 `series/vintagedates`:那个接口还会带回只改历史、不发新月份的 vintage ——
     * CPI 每年 2 月初单独发季调因子修订(2023-02-10、2024-02-09…),PCE 有随 GDP 年度修订出的
     * (2025-12-23)。它们不是例行发布日,混进来会把利率跳变错归因给「通胀数据」。
     * 按首发取,这类 vintage 天然不会出现,不用再写规则过滤。
     *
     * 只返回日期,不返回首发值(我们不做 first print / 意外差)。
     */
    async fetchFirstReleaseDates(seriesId: string, since: string): Promise<{ obsDate: string; releaseDate: string }[]> {
      const rows = await observations(seriesId, {
        observation_start: since,
        realtime_start: '1776-07-04',
        realtime_end: '9999-12-31',
        output_type: '4',
      });
      return rows.map((o) => ({ obsDate: o.date, releaseDate: o.realtime_start }));
    },
  };
}
