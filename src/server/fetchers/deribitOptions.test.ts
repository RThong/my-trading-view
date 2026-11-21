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

describe('fetchChain(批量 book summary)', () => {
  const at = Date.parse('2026-11-21T00:00:00Z');
  const exp = Date.parse('2026-12-25T08:00:00Z'); // 离 at + 30 天最近
  const inst = (name: string, strike: number, type: 'call' | 'put', e = exp) => ({
    instrument_name: name,
    strike,
    option_type: type,
    expiration_timestamp: e,
  });
  const json = (result: unknown) => new Response(JSON.stringify({ result }), { status: 200 });

  test('一次 summary 拿全链:自算 delta、缺 IV / 缺远期价 / 不在 summary 的合约丢掉、只取选中到期日;单点调用瞬断重试一次', async () => {
    const calls = new Map<string, number>();
    const bump = (k: string) => {
      calls.set(k, (calls.get(k) ?? 0) + 1);
      return calls.get(k)!;
    };
    const fetch = async (url: string) => {
      if (url.includes('get_instruments')) {
        if (bump('instruments') === 1) return new Response('boom', { status: 502 });
        return json([
          inst('BTC-25DEC26-70000-C', 70_000, 'call'),
          inst('BTC-25DEC26-60000-P', 60_000, 'put'),
          inst('BTC-25DEC26-80000-C', 80_000, 'call'), // summary 里 mark_iv 缺 → 丢
          inst('BTC-25DEC26-90000-C', 90_000, 'call'), // summary 里没有 → 丢
          inst('BTC-25DEC26-50000-P', 50_000, 'put'), // summary 里缺远期价 → 丢
          inst('BTC-26MAR27-60000-P', 60_000, 'put', Date.parse('2027-03-26T08:00:00Z')), // 远月 → 不进链
        ]);
      }
      if (url.includes('get_book_summary_by_currency')) {
        // 第一次瞬断,第二次成功 —— 单点调用带重试
        if (bump('summary') === 1) return new Response('boom', { status: 503 });
        return json([
          { instrument_name: 'BTC-25DEC26-70000-C', mark_iv: 45, underlying_price: 64_000, open_interest: 3 },
          { instrument_name: 'BTC-25DEC26-60000-P', mark_iv: 50, underlying_price: 64_000, bid_price: 0.01 },
          { instrument_name: 'BTC-25DEC26-80000-C', underlying_price: 64_000 },
          { instrument_name: 'BTC-25DEC26-50000-P', mark_iv: 60 },
          { instrument_name: 'BTC-26MAR27-60000-P', mark_iv: 48, underlying_price: 65_000 },
        ]);
      }
      return json({ index_price: 63_000 });
    };

    const snap = await defaultDeribitOptionsClient({ fetch, now: () => new Date(at), retryDelayMs: 1 }).fetchChain(
      'BTC',
      30,
    );

    expect(calls.get('instruments')).toBe(2);
    expect(calls.get('summary')).toBe(2);
    expect(snap.expirationDate).toBe('2026-12-25');
    expect(snap.underlyingPrice).toBe(63_000);
    expect(snap.calls.map((c) => c.contractSymbol)).toEqual(['BTC-25DEC26-70000-C']);
    expect(snap.puts.map((c) => c.contractSymbol)).toEqual(['BTC-25DEC26-60000-P']);
    expect(snap.calls[0].impliedVolatility).toBe(0.45);
    expect(snap.calls[0].openInterest).toBe(3);
    expect(snap.puts[0].bid).toBe(0.01);
    // 远期 64000、约 35 天:70000 call 与 60000 put 都在 25Δ 附近,符号对
    expect(snap.calls[0].delta!).toBeGreaterThan(0.2);
    expect(snap.calls[0].delta!).toBeLessThan(0.35);
    expect(snap.puts[0].delta!).toBeLessThan(-0.2);
    expect(snap.puts[0].delta!).toBeGreaterThan(-0.35);
  });

  test('现货一直失败 → spot 为 null、链照旧;已到期(到期时间早于抓取时刻)的合约不算 delta、丢掉', async () => {
    const past = at - 3_600_000; // 1 小时前已到期,但 instruments 里还挂着
    const fetch = async (url: string) => {
      if (url.includes('get_instruments'))
        return json([inst('BTC-20NOV26-60000-C', 60_000, 'call', past), inst('BTC-25DEC26-70000-C', 70_000, 'call')]);
      if (url.includes('get_book_summary_by_currency'))
        return json([
          { instrument_name: 'BTC-20NOV26-60000-C', mark_iv: 40, underlying_price: 64_000 },
          { instrument_name: 'BTC-25DEC26-70000-C', mark_iv: 45, underlying_price: 64_000 },
        ]);
      return new Response('down', { status: 503 });
    };

    // targetDte = 0:到期日选最近的,即已到期那个 → 唯一的合约被丢,链为空
    const client = defaultDeribitOptionsClient({ fetch, now: () => new Date(at), retryDelayMs: 1 });
    const expired = await client.fetchChain('BTC', 0);
    expect(expired.calls).toHaveLength(0);
    expect(expired.underlyingPrice).toBeNull();

    const snap = await client.fetchChain('BTC', 30);
    expect(snap.calls.map((c) => c.contractSymbol)).toEqual(['BTC-25DEC26-70000-C']);
    expect(snap.underlyingPrice).toBeNull();
  });
});
