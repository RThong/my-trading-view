import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, openDb } from './db';
import { insertMarketSeries, getMarketSeries } from './repository';

describe('openDb', () => {
  test('设了 busy_timeout(股票/加密 job 同点触发并发写)', () => {
    const db = openDb(':memory:');
    const row = db.query('PRAGMA busy_timeout').get() as { timeout: number };
    expect(row.timeout).toBe(30_000);
    db.close();
  });

  test('真实文件库:busy_timeout 让并发写等待,而非 0ms 撞锁瞬崩', () => {
    const path = join(tmpdir(), `mtv-busy-${process.pid}-${Date.now()}.db`);
    const cleanup = () => ['', '-wal', '-shm'].forEach((s) => rmSync(path + s, { force: true }));
    const holder = new Database(path);
    try {
      holder.exec('PRAGMA journal_mode = WAL;');
      holder.exec('CREATE TABLE t (x)');
      holder.exec('BEGIN IMMEDIATE');        // holder 持有写锁,直到本测试结束都不放
      holder.run('INSERT INTO t VALUES (1)');

      // 无 busy_timeout:第二个写者立刻崩(~0ms)
      const nb = new Database(path);
      const t0 = Date.now();
      expect(() => nb.run('INSERT INTO t VALUES (2)')).toThrow(/lock|busy/i);
      expect(Date.now() - t0).toBeLessThan(100);
      nb.close();

      // 有 busy_timeout=400:等约 400ms(holder 不放锁)才崩 —— 证明是「等待」而非瞬崩
      const wb = new Database(path);
      wb.exec('PRAGMA busy_timeout = 400;');
      const t1 = Date.now();
      expect(() => wb.run('INSERT INTO t VALUES (3)')).toThrow(/lock|busy/i);
      expect(Date.now() - t1).toBeGreaterThanOrEqual(300);
      wb.close();
    } finally {
      holder.close();
      cleanup();
    }
  });
});

describe('migrate 保留 VX 期限结构序列', () => {
  test('每次 migrate 的全量 DELETE 不清掉 VX1/VX3', () => {
    const db = new Database(':memory:');
    migrate(db);
    insertMarketSeries(db, [
      { seriesId: 'VX1', obsDate: '2026-06-01', value: 18.5 },
      { seriesId: 'VX3', obsDate: '2026-06-01', value: 19.2 },
    ]);
    migrate(db); // daily job 每次启动都会再跑一次 migrate

    expect(getMarketSeries(db, 'VX1')).toHaveLength(1);
    expect(getMarketSeries(db, 'VX3')).toHaveLength(1);
  });
});
