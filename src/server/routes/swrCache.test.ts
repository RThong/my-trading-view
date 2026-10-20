import { test, expect } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSwrCache, type SwrLoad } from './swrCache';

const TTL = 1000;
const RETRY = 100;

// 可控时钟 + 记录调用的 load:按队列依次吐结果,每次调用记下收到的 prev。
// 队列项为 Error 时该次 load 直接抛。
function setup(results: ({ value: string; complete: boolean } | Error)[], snapshotPath?: string) {
  let t = 0;
  const prevs: (string | null)[] = [];
  const load: SwrLoad<string> = async (prev) => {
    prevs.push(prev);
    const r = results.shift() ?? { value: 'end', complete: true };
    if (r instanceof Error) throw r;
    return r;
  };
  const cache = createSwrCache({ ttlMs: TTL, retryMs: RETRY, load, snapshotPath, now: () => t });
  return { cache, prevs, tick: (ms: number) => (t += ms) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

test('真冷:等一次 load;未过期再取不重拉', async () => {
  const { cache, prevs } = setup([{ value: 'a', complete: true }]);

  expect(await cache.get()).toMatchObject({ value: 'a', refreshing: false });
  expect(await cache.get()).toMatchObject({ value: 'a', refreshing: false });
  expect(prevs).toEqual([null]);
});

test('过期:立刻回旧值 + 后台刷新一次,刷新完再取是新值', async () => {
  const { cache, prevs, tick } = setup([
    { value: 'a', complete: true },
    { value: 'b', complete: true },
  ]);
  await cache.get();
  tick(TTL);

  expect(await cache.get()).toMatchObject({ value: 'a', refreshing: true });
  await flush();
  expect(await cache.get()).toMatchObject({ value: 'b', refreshing: false });
  expect(prevs).toEqual([null, 'a']); // 刷新时拿得到上一份(供调用方补缺口)
});

test('并发冷请求只 load 一次', async () => {
  const { cache, prevs } = setup([{ value: 'a', complete: true }]);

  const [x, y] = await Promise.all([cache.get(), cache.get()]);
  expect([x.value, y.value]).toEqual(['a', 'a']);
  expect(prevs.length).toBe(1);
});

test('不完整结果:retryMs 后就重试,而不是等满 TTL', async () => {
  const { cache, prevs, tick } = setup([
    { value: 'partial', complete: false },
    { value: 'full', complete: true },
  ]);
  await cache.get();

  tick(RETRY - 1);
  expect(await cache.get()).toEqual({ value: 'partial', refreshing: false, partial: true }); // 前端据 partial 隔几分钟再取
  tick(1);
  expect(await cache.get()).toMatchObject({ value: 'partial', refreshing: true });
  await flush();
  expect(await cache.get()).toEqual({ value: 'full', refreshing: false, partial: false });
  expect(prevs).toEqual([null, 'partial']);
});

test('后台 load 抛错:旧值照回,retryMs 后才再试(不让每个请求都撞失败的上游)', async () => {
  const { cache, prevs, tick } = setup([
    { value: 'a', complete: true },
    new Error('boom'),
    { value: 'b', complete: true },
  ]);
  await cache.get();
  tick(TTL);
  await cache.get(); // 触发后台刷新 → 抛错
  await flush();

  expect(await cache.get()).toMatchObject({ value: 'a', refreshing: false });
  tick(RETRY);
  expect(await cache.get()).toMatchObject({ value: 'a', refreshing: true });
  await flush();
  expect(await cache.get()).toMatchObject({ value: 'b', refreshing: false });
  expect(prevs.length).toBe(3);
});

test('真冷且 load 抛错:错抛给调用方,下次请求再试', async () => {
  const { cache } = setup([new Error('boom'), { value: 'a', complete: true }]);

  await expect(cache.get()).rejects.toThrow('boom');
  expect((await cache.get()).value).toBe('a');
});

test('快照:完整结果落盘;新实例(进程重启)立刻回盘上那份,同时后台重拉(快照是旧代码算的)', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'swr-')), 'sub', 'snap.json.gz');
  const first = setup([{ value: 'a', complete: true }], path);
  await first.cache.get();
  await Bun.sleep(20); // 等异步写盘

  const second = setup([{ value: 'b', complete: true }], path);
  expect(await second.cache.get()).toMatchObject({ value: 'a', refreshing: true });
  await flush();
  expect(await second.cache.get()).toMatchObject({ value: 'b', refreshing: false });
  expect(second.prevs).toEqual(['a']);
});

test('快照:不完整结果不落盘', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'swr-')), 'snap.json.gz');
  const first = setup([{ value: 'partial', complete: false }], path);
  await first.cache.get();
  await Bun.sleep(20);

  const second = setup([{ value: 'b', complete: true }], path);
  expect((await second.cache.get()).value).toBe('b');
});
