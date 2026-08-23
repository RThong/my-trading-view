import { describe, test, expect } from 'bun:test';
import { fetchBitstampBtcDaily } from './bitstampBtcHistory';

const DAY = 86_400;
const ts = (date: string) => Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000);
const bar = (t: number) => ({
  timestamp: String(t),
  open: '100',
  high: '110',
  low: '90',
  close: '105',
});

/** 打桩 fetch:每页从 start 起连发 n 根日线;pageRows 决定第几页给几根(0 = 空页)。 */
function stubFetch(pageRows: number[]) {
  const real = globalThis.fetch;
  let page = 0;
  globalThis.fetch = (async (url: string | URL | Request) => {
    const start = Number(new URL(String(url)).searchParams.get('start'));
    const n = pageRows[page] ?? 0;
    page++;
    const ohlc = Array.from({ length: n }, (_, i) => bar(start + i * DAY));
    return new Response(JSON.stringify({ data: { pair: 'BTC/USD', ohlc } }), { status: 200 });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

describe('fetchBitstampBtcDaily', () => {
  test('拉全 → 返回升序 bar', async () => {
    const restore = stubFetch([10]);
    try {
      const bars = await fetchBitstampBtcDaily('2012-01-01', '2012-01-10');
      expect(bars).toHaveLength(10);
      expect(bars[0].date).toBe('2012-01-01');
      expect(bars.at(-1)?.date).toBe('2012-01-10');
      expect(bars[0].close).toBe(105);
    } finally {
      restore();
    }
  });

  // 核心不变式:带洞的结果绝不能返回给调用方 —— 它一落库,「补完了」的守卫就永久判 true。
  test('中间某页回空 → 抛,不返回带洞的结果', async () => {
    const restore = stubFetch([1000, 0, 1000]); // 第 2 页空 = 1000 天的洞
    try {
      await expect(fetchBitstampBtcDaily('2012-01-01', '2018-08-13')).rejects.toThrow(/没拉全/);
    } finally {
      restore();
    }
  });

  test('尾巴被截 → 抛', async () => {
    const restore = stubFetch([5]); // 只回 5 根,离请求的 end 还差得远
    try {
      await expect(fetchBitstampBtcDaily('2012-01-01', '2012-06-01')).rejects.toThrow(/没拉全/);
    } finally {
      restore();
    }
  });

  test('零价日被滤掉,且 1 天的洞不算没拉全', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: {
            ohlc: [
              bar(ts('2012-01-01')),
              { ...bar(ts('2012-01-02')), close: '0' }, // 零成交日:源回 0 价
              bar(ts('2012-01-03')),
            ],
          },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    try {
      const bars = await fetchBitstampBtcDaily('2012-01-01', '2012-01-03');
      expect(bars.map((b) => b.date)).toEqual(['2012-01-01', '2012-01-03']);
    } finally {
      globalThis.fetch = real;
    }
  });

  test('HTTP 非 2xx → 抛', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch;
    try {
      await expect(fetchBitstampBtcDaily('2012-01-01', '2012-01-03')).rejects.toThrow(/HTTP 503/);
    } finally {
      globalThis.fetch = real;
    }
  });
});
