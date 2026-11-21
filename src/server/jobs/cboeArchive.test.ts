import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from '../storage/db';
import { archiveRuns } from '../fetchers/snapshotArchive';
import type { OptionsChainClient } from '../fetchers/optionsChain';
import { archiveUsable, guardVixNightSession, ingestArchivedOptions } from './cboeArchive';

function chain(root: string, lastTrade: string) {
  const opt = (option: string, delta: number) => ({
    option,
    bid: 1,
    ask: 1.1,
    iv: 0.2,
    open_interest: 100,
    volume: 10,
    delta,
    gamma: 0,
    vega: 0,
    theta: 0,
    rho: 0,
    last_trade_price: 1,
    last_trade_time: lastTrade,
  });
  return {
    data: { current_price: 100, options: [opt(`${root}261211C00105000`, 0.25), opt(`${root}261211P00095000`, -0.25)] },
  };
}

function archive(runs: Record<string, Record<string, unknown>>) {
  const dir = mkdtempSync(join(tmpdir(), 'snap-'));
  Object.entries(runs).forEach(([run, files]) => {
    mkdirSync(join(dir, 'data', run), { recursive: true });
    Object.entries(files).forEach(([name, body]) => {
      writeFileSync(join(dir, 'data', run, `${name}.json.gz`), Bun.gzipSync(JSON.stringify(body)));
    });
  });
  return dir;
}

function setup() {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}
function rowsOf(db: Database) {
  return db.query('SELECT underlying, snapshot_date, put_iv FROM option_snapshot_25delta ORDER BY 1, 2').all();
}

describe('cboeArchive', () => {
  it('只收交易日 21:30 UTC ~ 次日 00:15 UTC 抓的存档', () => {
    expect(archiveUsable('2026-11-13', new Date('2026-11-13T21:29:00Z'))).toBe(false);
    expect(archiveUsable('2026-11-13', new Date('2026-11-13T22:00:00Z'))).toBe(true);
    expect(archiveUsable('2026-11-13', new Date('2026-11-13T23:30:00Z'))).toBe(true);
    expect(archiveUsable('2026-11-13', new Date('2026-11-14T00:15:00Z'))).toBe(false);
  });

  it('按存档写库并返回已覆盖的「键|交易日」;窗口外抓的(夜盘的 VIX、假日又抓到的上一交易日)不收', async () => {
    const dir = archive({
      '2026-11-13T2200Z': { SPY: chain('SPY', '2026-11-13T15:59:00') },
      // 次日 11:00 UTC 才抓到的 VIX(夜盘)→ 丢
      '2026-11-14T1100Z': { _VIX: chain('VIX', '2026-11-13T16:14:00') },
    });
    const db = setup();

    const covered = await ingestArchivedOptions(db, archiveRuns(dir), ['SPY', '.VIX'], (u) => `${u}@cboe`);

    expect([...covered]).toEqual(['SPY@cboe|2026-11-13']);
    expect(rowsOf(db)).toEqual([{ underlying: 'SPY@cboe', snapshot_date: '2026-11-13', put_iv: 20 }]);
  });

  it('交易日逐文件定;同一「标的|交易日」只认最早那份', async () => {
    const late = chain('SPY', '2026-11-13T15:59:00');
    late.data.options[1].iv = 0.3;
    const dir = archive({
      // 同一轮里 VIX 文件比 SPY 晚一天(滞后)→ 各写各的日期
      '2026-11-13T2200Z': { SPY: chain('SPY', '2026-11-13T15:59:00'), _VIX: chain('VIX', '2026-11-12T16:14:00') },
      // 同一天第二份 SPY → 不覆盖第一份
      '2026-11-13T2330Z': { SPY: late },
    });
    const db = setup();

    await ingestArchivedOptions(db, archiveRuns(dir), ['SPY', '.VIX'], (u) => u);

    // VIX 那份交易日是 11-12,而抓取时刻不在 11-12 的窗口里 → 不收
    expect(rowsOf(db)).toEqual([{ underlying: 'SPY', snapshot_date: '2026-11-13', put_iv: 20 }]);
  });
});

describe('guardVixNightSession', () => {
  const fetched: string[] = [];
  const client: OptionsChainClient = {
    fetchChain: async (u) => {
      fetched.push(u);
      return { underlyingSymbol: u, underlyingPrice: null, expirationDate: '2026-12-16', calls: [], puts: [] };
    },
    getTradingDate: async () => '2026-11-20',
  };
  const at = (iso: string) => guardVixNightSession(client, () => new Date(iso));

  it('收盘后、夜盘前照抓 VIX', async () => {
    fetched.length = 0;
    await at('2026-11-20T22:07:00Z').fetchChain('.VIX', 30);
    expect(fetched).toEqual(['.VIX']);
  });

  it('夜盘里(次日 JST 上午)不抓 VIX、抛错;其它标的照抓', async () => {
    fetched.length = 0;
    const g = at('2026-11-21T02:00:00Z');
    await expect(g.fetchChain('.VIX', 30)).rejects.toThrow('不抓');
    await g.fetchChain('QQQ', 30);
    expect(fetched).toEqual(['QQQ']);
  });
});
