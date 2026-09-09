import { test, expect } from 'bun:test';
import { subtractAligned, subtractAt, divideAligned, yoyPct, scale, sumAtAnchorDates } from './regime';

test('scale:逐点乘常数(单位对齐)', () => {
  expect(
    scale(
      [
        { date: '2020-01-01', value: 2 },
        { date: '2020-01-02', value: 3 },
      ],
      1000,
    ),
  ).toEqual([
    { date: '2020-01-01', value: 2000 },
    { date: '2020-01-02', value: 3000 },
  ]);
});

test('yoyPct:对齐到约一年前算同比%', () => {
  const rows = [
    { date: '2023-01-02', value: 100 }, // 头一年无对照,跳过
    { date: '2024-01-02', value: 150 }, // 对 2023-01-02:+50%
    { date: '2024-06-01', value: 120 }, // 无 2023-06-01,取 ≤ 该日最近=2023-01-02(100)→ +20%
  ];
  const out = yoyPct(rows);
  expect(out.map((p) => p.date)).toEqual(['2024-01-02', '2024-06-01']); // 头一年跳过
  expect(out[0].value).toBeCloseTo(50);
  expect(out[1].value).toBeCloseTo(20);
});

test('divideAligned:逐日 num/den,den=0 跳过', () => {
  const num = [
    { date: '2020-01-01', value: 10 },
    { date: '2020-01-02', value: 12 },
  ];
  const den = [
    { date: '2020-01-01', value: 5 },
    { date: '2020-01-02', value: 0 },
  ];
  expect(divideAligned(num, den)).toEqual([{ date: '2020-01-01', value: 2 }]); // 01-02 den=0 跳过
});

test('日频相减:逐日 A - B', () => {
  const a = [
    { date: '2020-01-01', value: 10 },
    { date: '2020-01-02', value: 12 },
  ];
  const b = [
    { date: '2020-01-01', value: 3 },
    { date: '2020-01-02', value: 4 },
  ];
  expect(subtractAligned([a, b])).toEqual([
    { date: '2020-01-01', value: 7 },
    { date: '2020-01-02', value: 8 },
  ]);
});

test('周频前向填充到日频:WALCL 只在周一有值,中间日沿用', () => {
  const walcl = [
    { date: '2020-01-06', value: 100 },
    { date: '2020-01-13', value: 110 },
  ]; // 周频
  const daily = [
    { date: '2020-01-06', value: 1 },
    { date: '2020-01-08', value: 2 },
    { date: '2020-01-13', value: 3 },
  ];
  expect(subtractAligned([walcl, daily])).toEqual([
    { date: '2020-01-06', value: 99 }, // 100 - 1
    { date: '2020-01-08', value: 98 }, // 100(前填) - 2
    { date: '2020-01-13', value: 107 }, // 110 - 3
  ]);
});

test('起点对齐:某序列晚开始,输出从分量齐全日起', () => {
  const a = [{ date: '2020-01-02', value: 5 }]; // 晚一天开始
  const b = [
    { date: '2020-01-01', value: 1 },
    { date: '2020-01-02', value: 2 },
  ];
  expect(subtractAligned([a, b])).toEqual([{ date: '2020-01-02', value: 3 }]); // 01-01 缺 a,跳过
});

test('三序列净流动性:WALCL - TGA - RRP', () => {
  const w = [{ date: '2020-01-01', value: 100 }];
  const t = [{ date: '2020-01-01', value: 20 }];
  const r = [{ date: '2020-01-01', value: 5 }];
  expect(subtractAligned([w, t, r])).toEqual([{ date: '2020-01-01', value: 75 }]);
});

test('sumAtAnchorDates:只在锚点日出点,日频腿前向填充', () => {
  const anchor = [
    { date: '2026-01-01', value: 1.09 }, // 元旦非交易日 → 取 2025-12-31 那笔
    { date: '2026-04-01', value: 1.0 },
  ];
  const daily = [
    { date: '2025-12-30', value: 2.3 },
    { date: '2025-12-31', value: 2.31 },
    { date: '2026-01-02', value: 2.35 }, // 锚点日之后 → 不该被 2026-01-01 用上
    { date: '2026-04-01', value: 2.4 },
  ];

  expect(sumAtAnchorDates(anchor, daily)).toEqual([
    { date: '2026-01-01', value: 1.09 + 2.31 },
    { date: '2026-04-01', value: 1.0 + 2.4 },
  ]);
});

test('sumAtAnchorDates:日频腿尚无观测的锚点日跳过,不补 0', () => {
  const anchor = [
    { date: '2018-01-01', value: 1.2 },
    { date: '2018-04-01', value: 1.3 },
  ];
  const daily = [{ date: '2018-03-15', value: 2.0 }];

  expect(sumAtAnchorDates(anchor, daily)).toEqual([{ date: '2018-04-01', value: 3.3 }]);
});

// 构造用例(KW 两腿真实日历是一致的):锁住「日历一旦分叉,inner join 不跨日配对」这个保证。
test('subtractAt:inner join,任一腿缺日就跳过(不跨日配对)', () => {
  const fitted = [
    { date: '2018-01-12', value: 4.0 },
    { date: '2018-01-16', value: 4.2 },
  ];
  const tp = [
    { date: '2018-01-12', value: 0.5 },
    { date: '2018-01-15', value: 0.6 }, // 只有 b 腿有 → 不能用 a 腿 01-12 的 4.0 去减
    { date: '2018-01-16', value: 0.7 },
  ];

  expect(subtractAt(fitted, tp)).toEqual([
    { date: '2018-01-12', value: 4.0 - 0.5 },
    { date: '2018-01-16', value: 4.2 - 0.7 },
  ]);
  // 对照:前向填充版本会多出 01-15 那个跨日配对的点
  expect(subtractAligned([fitted, tp]).some((p) => p.date === '2018-01-15')).toBe(true);
});
