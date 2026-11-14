import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate } from '../storage/db';
import { getMarketSeries } from '../storage/repository';
import { updateIceCds } from './iceCdsSnapshot';

function memDb() {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}

async function singleNames() {
  return { date: '2026-11-13', points: [{ ticker: 'ORCLE', price: 95 }] };
}

test('单名 + CDX 同轮写库;CDX 存 ICE_CDX_*', async () => {
  const db = memDb();
  await updateIceCds(db, singleNames, async () => ({
    date: '2026-11-13',
    points: [
      { ticker: 'CDX_IG', price: 101.8 },
      { ticker: 'CDX_HY', price: 106.1 },
    ],
  }));

  expect(getMarketSeries(db, 'ICE_CDX_IG')).toEqual([{ date: '2026-11-13', value: 101.8 }]);
  expect(getMarketSeries(db, 'ICE_CDX_HY')).toEqual([{ date: '2026-11-13', value: 106.1 }]);
  expect(getMarketSeries(db, 'ICE_CDS_ORCLE')).toEqual([{ date: '2026-11-13', value: 95 }]);
});

test('指数端点挂了:单名照写,CDX 记进 missing(daily 判 failed、当天重跑)', async () => {
  const db = memDb();
  const r = await updateIceCds(db, singleNames, async () => {
    throw new Error('500');
  });

  expect(getMarketSeries(db, 'ICE_CDS_ORCLE')).toHaveLength(1);
  // 带上原因,状态板上分得清是 HTTP 失败还是结构变了
  expect(r.missing).toContain('CDX_IG(500)');
  expect(r.missing).toContain('CDX_HY(500)');
});

test('单名端点挂了:CDX 照写,再抛单名的错', async () => {
  const db = memDb();
  const run = updateIceCds(
    db,
    async () => {
      throw new Error('ICE CDS 下载失败:403');
    },
    async () => ({ date: '2026-11-13', points: [{ ticker: 'CDX_IG', price: 101.8 }] }),
  );

  await expect(run).rejects.toThrow('403');
  expect(getMarketSeries(db, 'ICE_CDX_IG')).toHaveLength(1);
});

test('两个端点同时挂:抛出的错误同时带上单名和 CDX 的原因', async () => {
  const run = updateIceCds(
    memDb(),
    async () => {
      throw new Error('ICE CDS 下载失败:403');
    },
    async () => {
      throw new Error('ICE CDX 下载失败:403');
    },
  );

  await expect(run).rejects.toThrow('单名:ICE CDS 下载失败:403;CDX:ICE CDX 下载失败:403');
});
