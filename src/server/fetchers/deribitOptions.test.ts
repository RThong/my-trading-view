import { describe, test, expect } from 'bun:test';
import { defaultDeribitOptionsClient, isRetryableStatus } from './deribitOptions';

describe('defaultDeribitOptionsClient.getTradingDate', () => {
  test('返回当前 UTC 日(YYYY-MM-DD),不跳周末/假期', async () => {
    const client = defaultDeribitOptionsClient();
    const d = await client.getTradingDate!();
    expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('isRetryableStatus', () => {
  test('限流与服务端错误才重试', () => {
    for (const s of [429, 500, 502, 503, 504]) expect(isRetryableStatus(s)).toBe(true);
  });

  test('其余 4xx 是明确拒绝,不重试 —— 再打一次还是同样答复', () => {
    // 链是快照型不可回填,所以要重试;但对着 404 重试只是白等一次 1.5s。
    for (const s of [400, 401, 403, 404, 422]) expect(isRetryableStatus(s)).toBe(false);
  });
});

describe('重试的覆盖面(A3 的不变式)', () => {
  // 这条守的是「逐合约 ticker 那层除 429 外**不许**带重试」——否则 Deribit 抽风时上百次调用各加
  // 「1.5s + 一整轮 15s 超时」,单链墙钟翻倍(~300s → ~630s),而 crypto job 一天 5 个触发点、无互斥锁。
  // 只靠注释守不住,这里打桩 fetch 数调用次数。
  test('get_instruments 会重试,逐合约 ticker 只重试 429', async () => {
    const expiry = Date.now() + 30 * 86400_000;
    const inst = (name: string, type: 'call' | 'put') => ({
      instrument_name: name,
      strike: 60_000,
      option_type: type,
      expiration_timestamp: expiry,
    });
    const calls = new Map<string, number>();
    const bump = (k: string) => calls.set(k, (calls.get(k) ?? 0) + 1);
    const json = (result: unknown) => new Response(JSON.stringify({ result }), { status: 200 });

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = String(url);

      if (u.includes('get_instruments')) {
        bump('instruments');
        // 第一次瞬断,第二次成功 —— 验证这个单点调用带重试。
        if (calls.get('instruments') === 1) return new Response('boom', { status: 503 });
        return json([inst('BTC-A', 'call'), inst('BTC-B', 'put'), inst('BTC-C', 'call')]);
      }
      if (u.includes('instrument_name=BTC-A')) {
        bump('tickerA'); // 一直失败:若被重试,计数会 >1
        return new Response('boom', { status: 503 });
      }
      if (u.includes('instrument_name=BTC-B')) {
        bump('tickerB');
        return json({ mark_iv: 40, greeks: { delta: 0.25 }, open_interest: 1 });
      }
      if (u.includes('instrument_name=BTC-C')) {
        bump('tickerC'); // 前两次限流,第三次成功
        if ((calls.get('tickerC') ?? 0) <= 2) return new Response('slow down', { status: 429 });
        return json({ mark_iv: 45, greeks: { delta: 0.25 }, open_interest: 1 });
      }
      bump('index');
      return json({ index_price: 60_000 });
    }) as typeof fetch;

    try {
      const snap = await defaultDeribitOptionsClient({ retryDelayMs: 1 }).fetchChain('BTC', 30); // 重试间隔 1ms,别真等 1.5s

      expect(calls.get('instruments')).toBe(2); // 单点调用:重试一次后成功
      expect(calls.get('tickerA')).toBe(1); // 逐合约:失败也只打一次
      expect(calls.get('tickerC')).toBe(3); // 429:退避重试到成功
      expect(snap.puts).toHaveLength(1); // 5xx 那个合约被丢弃,整条链照旧返回
      expect(snap.calls.map((c) => c.contractSymbol)).toEqual(['BTC-C']);

      // 再等就超过整链时限:撞 429 的合约不再等、直接丢(首次退避 100ms > 剩余预算 50ms)
      calls.clear();
      const late = await defaultDeribitOptionsClient({ retryDelayMs: 100, tickerBudgetMs: 50 }).fetchChain('BTC', 30);
      expect(calls.get('tickerC')).toBe(1);
      expect(late.calls).toHaveLength(0);

      // 已过整链时限:还没开抓的合约一个都不打(Deribit 卡死时不再每个等满超时)
      calls.clear();
      const over = await defaultDeribitOptionsClient({ retryDelayMs: 1, tickerBudgetMs: -1 }).fetchChain('BTC', 30);
      expect(calls.has('tickerA') || calls.has('tickerB') || calls.has('tickerC')).toBe(false);
      expect(over.calls.length + over.puts.length).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
