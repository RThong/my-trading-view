import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate } from '../storage/db';
import { getOptions25Delta } from '../storage/repository';
import { runOptionsSnapshot } from '../jobs/optionsSnapshot';
import { defaultMoomooOptionsClient } from './moomooOptions';

const EXPIRY = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10);

const contract = (code: string, strikePrice: number) => ({
  basic: { security: { code } },
  optionExData: { strikePrice },
});

/**
 * 假 ws:hang 里的标的的期权链请求永不返回;其余回一条只有 25Δ 一对合约的最小链。
 * 窗口 ≤2 天的查询视为第二档(月度),到期日回窗口末日;合约代码带到期日,快照按代码认到期日。
 */
function fakeWs(hang: Set<string>, disconnects: string[], calls: string[] = []) {
  let owner = '';
  return {
    stop() {},
    websock: { close: () => disconnects.push(owner) },
    GetOptionChain: ({ c2s }: any) => {
      owner = c2s.owner.code;
      calls.push(`chain:${owner}`);
      if (hang.has(owner)) return new Promise(() => {});
      const monthly = new Date(c2s.endTime).getTime() - new Date(c2s.beginTime).getTime() <= 2 * 86400_000;
      const expiry = monthly ? c2s.endTime : EXPIRY;
      return Promise.resolve({
        s2c: {
          optionChain: [
            {
              strikeTime: expiry,
              option: [{ call: contract(`${owner}C@${expiry}`, 110), put: contract(`${owner}P@${expiry}`, 90) }],
            },
          ],
        },
      });
    },
    GetSecuritySnapshot: ({ c2s }: any) =>
      Promise.resolve({
        s2c: {
          snapshotList: c2s.securityList.map(({ code }: any) => {
            calls.push(`snap:${code}`);
            const [, side, expiry] = code.match(/(C|P)@(.+)$/) ?? [];
            return {
              basic: { security: { code }, curPrice: 100 },
              optionExData: {
                strikeTime: expiry ?? EXPIRY,
                impliedVolatility: side === 'C' ? 20 : 25,
                delta: side === 'C' ? 0.25 : -0.25,
              },
            };
          }),
        },
      }),
  };
}

describe('moomoo 期权客户端 + runOptionsSnapshot', () => {
  test('某标的请求永不返回:超时、断开连接,其它标的照常落库', async () => {
    const db = new Database(':memory:');
    migrate(db);
    const disconnects: string[] = [];
    const noGate = async () => {};
    const client = defaultMoomooOptionsClient({
      cfg: () => ({ host: 'x', port: 0, key: 'k' }),
      conn: { connect: async () => fakeWs(new Set(['QQQ']), disconnects), timeoutMs: 30 },
      chainGate: noGate,
      snapshotGate: noGate,
    });

    const { rows, failures } = await runOptionsSnapshot({
      db,
      source: 'moomoo',
      underlyings: ['SPY', 'QQQ', 'TLT'],
      client: { fetchChain: client.fetchChain },
      secondExpiry: [],
    });

    expect(rows.map((r) => r.underlying)).toEqual(['SPY', 'TLT']);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('QQQ');
    expect(failures[0]).toContain('timeout');
    expect(disconnects).toEqual(['SPY', 'QQQ', 'TLT']);
    expect(getOptions25Delta(db, 'TLT', 3650)[0].skew).toBeCloseTo(5, 8);
  });

  test('第二档:另存一份月度到期的原始链,复用现货,25Δ 仍只一行', async () => {
    const db = new Database(':memory:');
    migrate(db);
    const calls: string[] = [];
    const noGate = async () => {};
    const client = defaultMoomooOptionsClient({
      cfg: () => ({ host: 'x', port: 0, key: 'k' }),
      conn: { connect: async () => fakeWs(new Set(), [], calls), timeoutMs: 30 },
      chainGate: noGate,
      snapshotGate: noGate,
    });

    const { rows, failures } = await runOptionsSnapshot({
      db,
      source: 'moomoo',
      underlyings: ['GLD', 'SPY'],
      client,
      secondExpiry: ['GLD'],
    });

    expect(failures).toEqual([]);
    expect(rows).toHaveLength(2);
    const raw = db
      .query(`SELECT underlying, expiry, underlying_price AS px FROM option_chain_raw ORDER BY 1, 2`)
      .all() as {
      underlying: string;
      expiry: string;
      px: number;
    }[];
    expect(raw.map((r) => r.underlying)).toEqual(['GLD', 'GLD', 'SPY']);
    const [near, far] = raw;
    expect(far.expiry > near.expiry).toBe(true);
    expect(new Date(far.expiry).getUTCDay()).toBe(5); // 第三个周五
    expect(far.px).toBe(100);
    // 现货快照只打一次(第二档复用)。
    expect(calls.filter((c) => c === 'snap:GLD')).toHaveLength(1);
  });

  test('第二档失败:第一档照常落库,失败记进 failures(整组 partial → 当天重跑)', async () => {
    const db = new Database(':memory:');
    migrate(db);
    const { rows, failures } = await runOptionsSnapshot({
      db,
      source: 'moomoo',
      underlyings: ['GLD'],
      secondExpiry: ['GLD'],
      client: {
        fetchChain: defaultMoomooOptionsClient({
          cfg: () => ({ host: 'x', port: 0, key: 'k' }),
          conn: { connect: async () => fakeWs(new Set(), []), timeoutMs: 30 },
          chainGate: async () => {},
          snapshotGate: async () => {},
        }).fetchChain,
        fetchMonthlyChain: async () => {
          throw new Error('boom');
        },
      },
    });

    expect(rows).toHaveLength(1);
    expect(failures).toEqual(['GLD 第二档: boom']);
  });

  test('.VIX 第二档:窗口里周二周三都有到期时取周二(假日提前的月度),ETF 取周五', async () => {
    // 两天都回一份到期:VIX 的周三那份此时是 VIXW 周度;ETF 的周四那份是日度 / 周度。
    const twoDayWs = () => ({
      stop() {},
      websock: { close() {} },
      GetOptionChain: ({ c2s }: any) =>
        Promise.resolve({
          s2c: {
            optionChain: [c2s.beginTime, c2s.endTime].map((d: string) => ({
              strikeTime: d,
              option: [{ call: contract(`C@${d}`, 110), put: contract(`P@${d}`, 90) }],
            })),
          },
        }),
      GetSecuritySnapshot: ({ c2s }: any) =>
        Promise.resolve({
          s2c: {
            snapshotList: c2s.securityList.map(({ code }: any) => ({
              basic: { security: { code } },
              optionExData: { strikeTime: code.split('@')[1], impliedVolatility: 20, delta: 0.25 },
            })),
          },
        }),
    });
    const client = defaultMoomooOptionsClient({
      cfg: () => ({ host: 'x', port: 0, key: 'k' }),
      conn: { connect: async () => twoDayWs(), timeoutMs: 30 },
      chainGate: async () => {},
      snapshotGate: async () => {},
    });

    const vix = await client.fetchMonthlyChain!('.VIX', 60, null);
    const gld = await client.fetchMonthlyChain!('GLD', 60, 100);
    expect(new Date(vix.expirationDate).getUTCDay()).toBe(2);
    expect(new Date(gld.expirationDate).getUTCDay()).toBe(5);
  });
});
