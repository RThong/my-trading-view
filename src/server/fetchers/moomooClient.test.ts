import { describe, test, expect } from 'bun:test';
import { rateGate, withConnection, withDeadline } from './moomooClient';

const CFG = { host: 'x', port: 0, key: 'k' };

/** 假 ws:请求永不 settle(模拟 qot 会话悬空),记录断开次数。 */
function hangingWs() {
  const ws = {
    stopped: 0,
    closed: 0,
    stop() {
      ws.stopped++;
    },
    websock: {
      close() {
        ws.closed++;
      },
    },
    GetOptionChain: () => new Promise(() => {}),
  };
  return ws;
}

describe('withConnection', () => {
  test('请求永不返回 → 按截止时间 reject,且连接被断开', async () => {
    const ws = hangingWs();
    const t0 = Date.now();
    const p = withConnection(CFG, (w) => w.GetOptionChain({}), { connect: async () => ws, timeoutMs: 30 });

    await expect(p).rejects.toThrow('GetOptionChain timeout');
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(ws.stopped).toBe(1);
    expect(ws.closed).toBe(1);
  });

  test('小写方法(stop / start 等 SDK 自身方法)不套截止时间', async () => {
    const ws = { ...hangingWs(), ping: () => 'pong' };
    const r = await withConnection(CFG, async (w) => w.ping(), { connect: async () => ws, timeoutMs: 30 });
    expect(r).toBe('pong');
  });
});

describe('withDeadline', () => {
  test('先到的结果胜出', async () => {
    expect(await withDeadline(Promise.resolve(1), 50, 'x')).toBe(1);
  });
});

describe('rateGate', () => {
  test('并发调用按最小间隔排开', async () => {
    const gate = rateGate(40);
    const t0 = Date.now();
    const at: number[] = [];
    await Promise.all(
      [0, 1, 2].map(async () => {
        await gate();
        at.push(Date.now() - t0);
      }),
    );

    expect(at[0]).toBeLessThan(30);
    expect(at[2]).toBeGreaterThanOrEqual(75);
  });
});
