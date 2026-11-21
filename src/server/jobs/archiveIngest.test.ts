// Deribit / MOVE 存档写库(CBOE 期权的在 cboeArchive.test.ts)
import { describe, expect, it, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from '../storage/db';
import { getMarketSeries } from '../storage/repository';
import { archiveRuns } from '../fetchers/snapshotArchive';
import { deribitArchiveUsable, ingestArchivedDeribit } from './deribitArchive';
import { ingestArchivedMove } from './moveSnapshot';

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

/** fetch.sh 存的形状:开抓时刻 + 三类原始响应(带 `{ result }` 外壳)。到期日 2026-12-18 离 11-18 + 30 天最近。
 *  远期 64000、30 天左右:70000 call 与 60000 put 的 Black-76 delta 约 ±0.25。 */
function deribitChain(fetchedAt: string, putIv: number) {
  const exp = Date.parse('2026-12-18T08:00:00Z');
  const inst = (name: string, type: 'call' | 'put') => ({
    instrument_name: name,
    strike: type === 'call' ? 70_000 : 60_000,
    option_type: type,
    expiration_timestamp: exp,
  });
  const book = (name: string, iv: number) => ({
    instrument_name: name,
    mark_iv: iv,
    underlying_price: 64_000,
    open_interest: 1,
  });

  return {
    fetchedAt: Date.parse(fetchedAt),
    instruments: {
      result: [
        inst('BTC-18DEC26-70000-C', 'call'),
        inst('BTC-18DEC26-60000-P', 'put'),
        // 远月的不该进链
        { ...inst('BTC-26MAR27-60000-P', 'put'), expiration_timestamp: Date.parse('2027-03-26T08:00:00Z') },
      ],
    },
    index: { result: { index_price: 64_000 } },
    summary: {
      result: [book('BTC-18DEC26-70000-C', 40), book('BTC-18DEC26-60000-P', putIv), book('BTC-26MAR27-60000-P', 99)],
    },
  };
}

describe('deribitArchive', () => {
  it('只收 UTC 21:30 之后抓的(定时那两轮)', () => {
    expect(deribitArchiveUsable(new Date('2026-11-18T21:29:00Z'))).toBe(false);
    expect(deribitArchiveUsable(new Date('2026-11-18T22:07:00Z'))).toBe(true);
    expect(deribitArchiveUsable(new Date('2026-11-18T23:59:00Z'))).toBe(true);
  });

  it('重放存档写库:按存档里的抓取时刻打戳、记 fetched_at,同一天只认最早那份,白天推送触发那轮不收', async () => {
    const dir = archive({
      '2026-11-18T0231Z': { 'deribit-BTC': deribitChain('2026-11-18T02:30:00Z', 70) }, // 白天 → 不收
      '2026-11-18T2208Z': { 'deribit-BTC': deribitChain('2026-11-18T22:07:30Z', 50) },
      '2026-11-18T2318Z': { 'deribit-BTC': deribitChain('2026-11-18T23:17:30Z', 60) }, // 同日第二份 → 不收
      // 开抓在 11-19 23:58、整轮跨过零点才结束:按开抓时刻算 11-19,不按目录名
      '2026-11-20T0001Z': { 'deribit-BTC': deribitChain('2026-11-19T23:58:00Z', 60) },
      '2026-11-20T2207Z': { 'deribit-BTC': { tickers: [] } }, // 不带 fetchedAt 的旧格式 → 不收
      // 逐合约 ticker 格式(11-21 前,没有 summary):早已写过库 → 跳过
      '2026-11-20T2210Z': {
        'deribit-BTC': { ...deribitChain('2026-11-20T22:09:00Z', 80), summary: undefined, tickers: [] },
      },
    });
    const db = setup();

    // 旧 ticker 格式要「跳过」而不是「重放失败」:失败也不写库,但会打 warn —— 靠 warn 区分两者
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const covered = await ingestArchivedDeribit(db, archiveRuns(dir), ['BTC']);
    const warned = warn.mock.calls.length; // mockRestore 会清掉调用记录,先取出来
    warn.mockRestore();
    expect(warned).toBe(0);

    expect([...covered]).toEqual(['BTC|2026-11-18', 'BTC|2026-11-19']);
    expect(db.query('SELECT snapshot_date, put_iv, fetched_at FROM option_snapshot_25delta ORDER BY 1').all()).toEqual([
      { snapshot_date: '2026-11-18', put_iv: 50, fetched_at: '2026-11-18T22:07:30.000Z' },
      { snapshot_date: '2026-11-19', put_iv: 60, fetched_at: '2026-11-19T23:58:00.000Z' },
    ]);
    expect(db.query('SELECT DISTINCT expiry FROM option_chain_raw').all()).toEqual([{ expiry: '2026-12-18' }]);
  });
});

describe('ingestArchivedMove', () => {
  const chart = (price: number, at: string) => ({
    chart: { result: [{ meta: { regularMarketPrice: price, regularMarketTime: Date.parse(at) / 1000 } }] },
  });

  it('只写抓取时已收盘的 meta,日期按 ET 日', () => {
    const dir = archive({
      // 17:07 ET 抓、meta 16:34 ET → 写 11-17
      '2026-11-17T2207Z': { move: chart(101.9, '2026-11-17T21:34:00Z') },
      // 12:00 ET 抓到的盘中值 → 不写
      '2026-11-18T1700Z': { move: chart(99, '2026-11-18T16:59:00Z') },
      '2026-11-18T2207Z': { SPY: {} }, // 没有 move 的一轮 → 跳过
    });
    const db = setup();

    expect(ingestArchivedMove(db, archiveRuns(dir))).toBe(1);
    expect(getMarketSeries(db, 'MOVE').map((r) => [r.date, r.value])).toEqual([['2026-11-17', 101.9]]);
  });
});
