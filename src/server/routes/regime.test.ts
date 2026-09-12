import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { nearMinusFar } from '../analytics/termStructure';

// 两条期限结构价差(VX1−V3 与 VIX−VIX3M)的**减号方向**必须一致 —— 这是这条线上唯一
// 「写反了不报错、只让人把图读反一格」的地方。
//
// ⚠️ 方向**锁不住在测试里**,这一点要说清楚:方向由调用点决定,而测一个纯函数永远是绿的
// (前端那两格共用同一个 signed 渲染,喂同样的数必然同色,更是恒真)。真正的防线是把入参
// 改成具名的 `{ near, far }` —— 写反就得写成 `{ near: 三个月, far: 三十天 }`,阅读时自明地荒谬。
// 下面测的是这个入口本身的语义,以及两格共用它这个事实。
test('nearMinusFar:近端 − 远端,正 = backwardation', () => {
  const d = (value: number) => [{ date: '2021-01-04', value }];

  // 近端高于远端(倒挂)→ 正
  expect(nearMinusFar({ near: d(30), far: d(25) })[0]!.value).toBe(5);
  // 近端低于远端(常态 contango)→ 负
  expect(nearMinusFar({ near: d(15), far: d(18) })[0]!.value).toBe(-3);
});

// 内连接:两腿更新不同步时宁可少一根,也不拿旧的一腿配新的另一腿。
// VIX3M 是实时外拉、VX1/VX3 来自库,不同步是常态而非例外。
// (换回 subtractAligned 那种前向填充,第一条断言就会红。)
test('nearMinusFar:只在两腿都有当日观测时出点,不前向填充', () => {
  const near = [
    { date: '2021-01-04', value: 20 },
    { date: '2021-01-05', value: 21 }, // 远端这天没有 → 整根不出
  ];
  const far = [{ date: '2021-01-04', value: 18 }];

  expect(nearMinusFar({ near, far })).toEqual([{ date: '2021-01-04', value: 2 }]);
});

// 空腿(CBOE 某个符号 404 / 空 CSV)→ 空数组,由路由那侧归入 unavailable,不出这一格。
test('nearMinusFar:任一腿为空 → 空结果', () => {
  const d = [{ date: '2021-01-04', value: 20 }];
  expect(nearMinusFar({ near: [], far: d })).toEqual([]);
  expect(nearMinusFar({ near: d, far: [] })).toEqual([]);
});

// ── 缓存命中路径必须重读「独立 job 写库」的序列 ─────────────────────────────
//
// 这条是实际踩过的:GPU 四条由 cryptoDaily 的 computable_gpu 分组写库,而缓存条件又专门放宽了
// 「gpu 前缀缺失也缓存」(库没跑过 job 时必然缺、B300 长期允许缺)。两个改动各自合理,合起来
// 把「GPU 不可用」这个状态缓存住并卡满 TTL(6h)—— job 跑完了面板还说不可用。
//
// 结构上的修法是让主路径与缓存命中路径共用同一份 JOB_WRITTEN_SERIES。下面锁的是**剩下那个
// 会静默出错的点**:缓存命中时要把旧的 unavailable 条目剔掉再塞新的,剔除若按 'gpu' 前缀做,
// 往名单里加一条不叫 gpu* 的(vix 就是)就会漏剔、unavailable 里出现重复。所以按 key 集合剔。
import { Database } from 'bun:sqlite';
import { migrate } from '../storage/db';
import { JOB_WRITTEN_SERIES, GPU_KEY_PREFIX, DB_BACKED_KEYS, readDbBacked, shouldCache, EIA_SERIES } from './regime';

test('JOB_WRITTEN_SERIES:out 键唯一、symbol 唯一', () => {
  const outs = JOB_WRITTEN_SERIES.map(([out]) => out);
  const syms = JOB_WRITTEN_SERIES.map(([, sym]) => sym);

  expect(new Set(outs).size).toBe(outs.length);
  expect(new Set(syms).size).toBe(syms.length);
});

test('允许「缺着也缓存」的只有 gpu 那几条,别把别的也放宽', () => {
  const lenient = JOB_WRITTEN_SERIES.map(([out]) => out).filter((out) => out.startsWith(GPU_KEY_PREFIX));

  // vix/vxn 不在其中:它们缺失说明库是空的或 daily job 从没成功过,那种状态不该被缓存住。
  expect(lenient).toEqual(['gpuH100', 'gpuH200', 'gpuB200', 'gpuB300']);
});

// 缓存命中时要按 key 剔掉旧的 unavailable 条目、再塞新读到的。DB_BACKED_KEYS 漏一个,
// 那一格的旧条目就剔不掉 —— 结果是 unavailable 里出现重复项、甚至"既说不可用又给了数据"。
//
// ⚠️ 这条**必须真的调用 readDbBacked**。上一版是拿 DB_BACKED_KEYS 去比它自己的构造成分
// (JOB_WRITTEN_SERIES + 硬编码那四个),由构造保证恒真 —— 而它声称要挡的场景恰恰是
// "往 readDbBacked 里加了第五个 ad-hoc key 却忘了同步 DB_BACKED_KEYS",那种改动照旧全绿。
// 空库跑一次,unavailable 就是它能产出的 key 全集,拿这个比才挡得住。
test('DB_BACKED_KEYS 等于 readDbBacked 实际产出的 key 全集', () => {
  const db = new Database(':memory:');
  migrate(db);
  try {
    // 空库 → 每一格都进 unavailable,于是 unavailable 就是全集。
    const { unavailable, series } = readDbBacked(db, []);

    expect(series).toEqual({});
    expect(new Set(unavailable)).toEqual(new Set(DB_BACKED_KEYS));
  } finally {
    db.close();
  }
});

const ok = (u: string[], hasEiaKey: boolean) => shouldCache(u, { hasEiaKey });

test('shouldCache:全成功 → 缓存', () => {
  expect(ok([], true)).toBe(true);
});

test('shouldCache:SEC / GPU 缺席是常态,不挡缓存', () => {
  expect(ok(['fund:NVDA:fcf', 'gpuB300'], true)).toBe(true);
});

test('shouldCache:没配 EIA key 时那八条恒缺,必须豁免 —— 否则缓存永久关不上', () => {
  // 这正是回归点:不豁免的话每次请求都会重拉 FRED/CBOE/Yahoo 全套上游。
  expect(ok([...EIA_SERIES], false)).toBe(true);
  expect(ok([...EIA_SERIES, 'fund:NVDA:fcf'], false)).toBe(true);
});

test('shouldCache:配了 key 还缺 = 真失败,照旧挡住缓存等下次重试', () => {
  expect(ok([...EIA_SERIES], true)).toBe(false);
  expect(ok(['distStocksZ5y'], true)).toBe(false);
});

test('shouldCache:豁免只覆盖 EIA 那八条,别的源缺席照样挡', () => {
  expect(ok(['hyOas'], false)).toBe(false);
  expect(ok([...EIA_SERIES, 'hyOas'], false)).toBe(false);
});

test('EIA_SERIES 必须与路由实际发出的那批 EIA 线一致(手抄名单的防漂移锁)', () => {
  // 回归点:名单漏一条 → 缺 key 时那条不在豁免里 → shouldCache 恒 false → 缓存永久关不上。
  // 「实际发出哪些」的真源是 regime.ts 里 put() 那一段;这里用源码文本对齐,避免跑真实网络。
  const src = readFileSync(new URL('./regime.ts', import.meta.url), 'utf8');
  const seg = src.slice(src.indexOf("put('refUtil'"), src.indexOf("put('rbobYoy'"));
  const actual = [...seg.matchAll(/put\(\s*'([A-Za-z0-9]+)'/g)].map((m) => m[1]);

  expect(actual.length).toBeGreaterThan(0);
  expect([...EIA_SERIES].sort()).toEqual([...new Set(actual)].sort() as (typeof EIA_SERIES)[number][]);
});
