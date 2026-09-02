import { describe, expect, it } from 'bun:test';
import { toDailyAverages, fetchGpuIndexDaily } from './computableGpu';

describe('toDailyAverages', () => {
  it('按 UTC 日分组、取 value_usd_gpu_hr 的时间平均,按日期升序', () => {
    const points = [
      { observed_at: '2026-09-02T13:00:00.000Z', value_usd_gpu_hr: 3.6, status: 'ok' },
      { observed_at: '2026-09-02T12:45:00.000Z', value_usd_gpu_hr: 3.4, status: 'ok' },
      { observed_at: '2026-09-01T00:00:00.000Z', value_usd_gpu_hr: 3.0, status: 'ok' },
    ];
    expect(toDailyAverages(points)).toEqual([
      { date: '2026-09-01', value: 3.0 },
      { date: '2026-09-02', value: 3.5 },
    ]);
  });

  it('跳过非 ok 状态(如 no_print)与空值,不当 0 参与平均', () => {
    const points = [
      { observed_at: '2026-08-31T00:00:00.000Z', value_usd_gpu_hr: null, status: 'no_print' },
      { observed_at: '2026-08-31T01:00:00.000Z', value_usd_gpu_hr: 5.0, status: 'ok' },
    ];
    expect(toDailyAverages(points)).toEqual([{ date: '2026-08-31', value: 5.0 }]);
  });

  it('全部无有效观测的日子不出现在结果里(不产生空日 NaN)', () => {
    const points = [{ observed_at: '2026-08-30T00:00:00.000Z', value_usd_gpu_hr: null, status: 'no_print' }];
    expect(toDailyAverages(points)).toEqual([]);
  });
});

describe('fetchGpuIndexDaily', () => {
  it('跟着 next_cursor 翻页,拼完整段历史再聚合;拿到 null 就停', async () => {
    const page1 = {
      data: {
        values: [{ observed_at: '2026-09-02T00:00:00.000Z', value_usd_gpu_hr: 4.0, status: 'ok' }],
        next_cursor: 'CURSOR_1',
      },
    };
    const page2 = {
      data: {
        values: [{ observed_at: '2026-09-01T00:00:00.000Z', value_usd_gpu_hr: 2.0, status: 'ok' }],
        next_cursor: null,
      },
    };
    const calls: string[] = [];
    const fakeFetch = async (url: string) => {
      calls.push(url);
      const body = url.includes('cursor=') ? page2 : page1;
      return new Response(JSON.stringify(body), { status: 200 });
    };
    const rows = await fetchGpuIndexDaily('H100', fakeFetch as typeof fetch);
    expect(calls.length).toBe(2); // 第二页拿到 next_cursor=null 后不再发第三次请求
    expect(rows).toEqual([
      { date: '2026-09-01', value: 2.0 },
      { date: '2026-09-02', value: 4.0 },
    ]);
  });
});
