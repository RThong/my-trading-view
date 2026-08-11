import { test, expect } from 'bun:test';
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
