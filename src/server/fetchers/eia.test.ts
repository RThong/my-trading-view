import { describe, test, expect } from 'bun:test';
import { createEiaFetcher, weeksToFetch } from './eia';
import { HISTORY_START_DATE, SEASONAL_BASELINE_YEARS } from '../config';

const body = (data: Array<{ period: string; value: number | null }>) =>
  new Response(JSON.stringify({ response: { data } }), { status: 200 });

describe('eia fetcher', () => {
  test('fetchWeekly 拼 PET.{id}.W、带 length、翻成升序、丢 null', async () => {
    let seen = '';
    const fakeFetch = async (url: string) => {
      seen = url;
      return body([
        { period: '2026-09-04', value: 106274 },
        { period: '2026-08-28', value: null },
        { period: '2026-08-21', value: 103391 },
      ]);
    };

    const rows = await createEiaFetcher({ apiKey: 'k', fetch: fakeFetch }).fetchWeekly('WDISTUS1');

    expect(seen).toContain('/v2/seriesid/PET.WDISTUS1.W?');
    expect(seen).toContain('api_key=k');
    expect(seen).toContain('length='); // 不传就是整条 1982 起的历史
    expect(rows).toEqual([
      { date: '2026-08-21', value: 103391 },
      { date: '2026-09-04', value: 106274 },
    ]);
  });

  test('value 是数字字符串也收(不按类型过滤,按值解析)', async () => {
    const fetcher = createEiaFetcher({
      apiKey: 'k',
      fetch: async () =>
        body([
          { period: '2026-09-04', value: '106274' as unknown as number },
          { period: '2026-08-28', value: '' as unknown as number },
          { period: '2026-08-21', value: 103391 },
        ]),
    });

    // 按 typeof === 'number' 过滤的话,第一行会被悄悄丢掉。
    expect(await fetcher.fetchWeekly('WDISTUS1')).toEqual([
      { date: '2026-08-21', value: 103391 },
      { date: '2026-09-04', value: 106274 },
    ]);
  });

  test('源给了行但一行都解析不出来 → 抛错,不返回空数组', async () => {
    // 静默返回 [] 的话,调用方 catch→null,最终只表现为那一格 unavailable,与网络失败无法区分。
    const fetcher = createEiaFetcher({
      apiKey: 'k',
      fetch: async () => body([{ period: '2026-09-04', value: 'n/a' as unknown as number }]),
    });
    await expect(fetcher.fetchWeekly('WDISTUS1')).rejects.toThrow(/全部解析失败/);
  });

  test('源本来就给了空数组 → 返回空,不抛错', async () => {
    const fetcher = createEiaFetcher({ apiKey: 'k', fetch: async () => body([]) });
    expect(await fetcher.fetchWeekly('WDISTUS1')).toEqual([]);
  });

  test('非 200 抛错', async () => {
    const fetcher = createEiaFetcher({ apiKey: 'k', fetch: async () => new Response('nope', { status: 404 }) });
    await expect(fetcher.fetchWeekly('WDISTUS1')).rejects.toThrow(/EIA request failed/);
  });

  test('200 但无 response.data 也抛错(EIA 的错误体是 200 + error 字段)', async () => {
    const fetcher = createEiaFetcher({
      apiKey: 'k',
      fetch: async () => new Response(JSON.stringify({ error: 'Series ID is not valid.' }), { status: 200 }),
    });
    await expect(fetcher.fetchWeekly('NOPE')).rejects.toThrow(/Series ID is not valid/);
  });

  test('缺 key 抛错', async () => {
    await expect(createEiaFetcher({ apiKey: '' }).fetchWeekly('WDISTUS1')).rejects.toThrow(/EIA_API_KEY/);
  });
});

test('weeksToFetch:窗口必须盖住「展示起点再往前垫基准期年数」,且随时间自动跟进', () => {
  // 不能只断言 URL 里有 `length=` —— 任何数值都满足,等于没测。
  //
  // ⚠️ 但本条也**不**覆盖「把 HISTORY_START_DATE 改小」:测试用同样两个常量重算 needed,
  // 两边同步移动,对任何取值都恒真。它真正咬合的是**实现里漏掉垫基准期那一步** ——
  // 去掉 `from.setFullYear(… - SEASONAL_BASELINE_YEARS)` 这条会 fail(已实测)。
  const earliestNeeded = new Date(HISTORY_START_DATE);
  earliestNeeded.setFullYear(earliestNeeded.getFullYear() - SEASONAL_BASELINE_YEARS);
  const needed = (Date.now() - earliestNeeded.getTime()) / (7 * 86_400_000);

  expect(weeksToFetch()).toBeGreaterThanOrEqual(needed);
  // 也别拉过头:EIA 全历史从 1982 起,拉满是 674 KB × 6 条。留的头应在一年以内。
  expect(weeksToFetch()).toBeLessThan(needed + 52);
});

test('fetchWeekly:URL 里的 length 就是算出来的那个数,不是常数', async () => {
  let seen = '';
  const fetcher = createEiaFetcher({
    apiKey: 'k',
    fetch: async (url: string) => {
      seen = url;
      return body([{ period: '2026-09-04', value: 1 }]);
    },
  });
  await fetcher.fetchWeekly('WDISTUS1');

  expect(new URL(seen).searchParams.get('length')).toBe(String(weeksToFetch()));
});
