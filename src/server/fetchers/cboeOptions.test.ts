import { describe, expect, it } from 'bun:test';
import { cboeSymbol, createCboeOptionsClient, lastTradeDay, parseCboeChain } from './cboeOptions';

function opt(option: string, o: Partial<Record<string, number | string | null>> = {}) {
  return {
    option,
    bid: 1,
    ask: 1.1,
    iv: 0.2,
    open_interest: 100,
    volume: 10,
    delta: 0.25,
    gamma: 0.01,
    vega: 0.1,
    theta: -0.01,
    rho: 0.01,
    last_trade_price: 1.05,
    last_trade_time: '2026-11-13T15:59:00',
    ...o,
  };
}

const CHAIN = {
  current_price: 100,
  options: [
    opt('SPY261211C00105000', { delta: 0.25 }),
    opt('SPY261211P00095000', { delta: -0.25, iv: 0.25 }),
    opt('SPY261218C00105000'),
    opt('SPY270115C00105000', { last_trade_time: '2026-11-13T16:14:59' }),
    opt('SPY270115P00095000', { delta: -0.25 }),
    opt('B1SPY261113C00710000'), // 已到期 / 调整过的怪代码,解析不出 → 丢
  ],
};

function client(data = CHAIN, now = '2026-11-14T03:00:00Z') {
  const urls: string[] = [];
  const c = createCboeOptionsClient({
    now: () => new Date(now),
    fetch: (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ data }), { status: 200 });
    }) as never,
  });
  return { c, urls };
}

describe('cboeOptions', () => {
  it('指数前加下划线', () => {
    expect(cboeSymbol('.VIX')).toBe('_VIX');
    expect(cboeSymbol('SPY')).toBe('SPY');
  });

  it('解析 OCC 代码:到期日 / 类型 / 行权价;认不出的代码丢掉;价内按现价判', () => {
    const p = parseCboeChain(CHAIN);
    expect(p).toHaveLength(5);
    expect(p[0]).toMatchObject({ expiry: '2026-12-11', type: 'C' });
    expect(p[0].contract).toMatchObject({ strike: 105, impliedVolatility: 0.2, inTheMoney: false, openInterest: 100 });
    expect(p[1].contract.inTheMoney).toBe(false); // 95 put,现价 100 → 价外
  });

  it('快照交易日 = 最后一笔成交的日期(认假日,不自己推日历)', () => {
    expect(lastTradeDay(CHAIN)).toBe('2026-11-13');
  });

  it('第一档取目标 DTE ±10 天内最近的到期日;同一标的整轮只下载一次', async () => {
    const { c, urls } = client();
    // 2026-11-14 + 30 天 = 12-14:12-11(差 3 天)比 12-18(差 4 天)近
    const chain = await c.fetchChain('SPY', 30);
    expect(chain.expirationDate).toBe('2026-12-11');
    expect(chain.calls.map((x) => x.strike)).toEqual([105]);
    expect(chain.puts.map((x) => x.strike)).toEqual([95]);
    expect(await c.getTradingDate?.()).toBe('2026-11-13');
    expect(urls).toHaveLength(1);
  });

  it('目标窗口内没有到期日 → 报错(不悄悄挑一个离得很远的)', async () => {
    const { c } = client({ current_price: 100, options: [opt('SPY270115C00105000')] });
    await expect(c.fetchChain('SPY', 30)).rejects.toThrow('没有到期日');
  });

  it('第二档:第一个 DTE ≥ 60 的标准月度(ETF = 第三个周五)', async () => {
    const { c } = client();
    const m = await c.fetchMonthlyChain?.('SPY', 60, null);
    expect(m?.expirationDate).toBe('2027-01-15');
  });

  it('第二档遇假日提前一天跌破 minDte(Good Friday 那个月)→ 改取下一个月度', async () => {
    // 2025-02-17 + 60 天 = 04-18(Good Friday 休市,实际 04-17 到期,只有 59 天)→ 取 05-16
    const data = { current_price: 100, options: [opt('SPY250417C00105000'), opt('SPY250516C00105000')] };
    // 早上和美东傍晚之后(日本时间 21 / 22 点那两次)都要选对
    for (const at of ['2025-02-17T03:00:00Z', '2025-02-17T13:00:00Z']) {
      const { c } = client(data, at);
      expect((await c.fetchMonthlyChain?.('SPY', 60, null))?.expirationDate).toBe('2025-05-16');
    }
  });

  it('第一档窗口按日历日期框:目标日 +10 天那天的到期照样算进来(同 moomoo)', async () => {
    // 03:00Z 起算,30 + 10 = 40 天后是 12-24;那天 16:00Z 到期比「整 40 天」多 13 小时,按时刻比会被误排除
    const data = { current_price: 100, options: [opt('SPY261224C00105000')] };
    const { c } = client(data, '2026-11-14T03:00:00Z');
    expect((await c.fetchChain('SPY', 30)).expirationDate).toBe('2026-12-24');
  });
});
