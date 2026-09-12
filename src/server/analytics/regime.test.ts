import { test, expect } from 'bun:test';
import {
  subtractAligned,
  subtractAt,
  divideAligned,
  yoyPct,
  scale,
  sumAtAnchorDates,
  sumAligned,
  seasonalZ,
  seasonalZFrom,
  oilCracks,
  distillateYield,
} from './regime';

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

test('sumAligned:前向填充后相加', () => {
  const a = [
    { date: '2020-01-01', value: 10 },
    { date: '2020-01-03', value: 20 },
  ];
  const b = [{ date: '2020-01-02', value: 5 }];
  // 01-01:b 还没出现 → 跳过。01-02:10(填充)+5。01-03:20+5(填充)。
  expect(sumAligned([a, b])).toEqual([
    { date: '2020-01-02', value: 15 },
    { date: '2020-01-03', value: 25 },
  ]);
});

// 生成周频序列:每年 date 同一天的 value 由 pick(year) 给。
const weeklyAt = (mmdd: string, years: number[], pick: (y: number) => number) =>
  years.map((y) => ({ date: `${y}-${mmdd}`, value: pick(y) }));

test('seasonalZ:基准期排除当年,只用往年同期', () => {
  // 往年同期 5 个样本恒为 100(σ=0 会被跳过)→ 故给一点离散度:100/102/100/102/100,均值 100.8。
  const base = [100, 102, 100, 102, 100];
  const rows = [
    ...weeklyAt('06-05', [2019, 2020, 2021, 2022, 2023], (y) => base[y - 2019]),
    { date: '2024-06-05', value: 120 },
  ];
  const out = seasonalZ(rows, { years: 5, minSamples: 5 });

  // 只有 2024 那点样本够(往年 5 个);前 5 年各自往年不足 5 个 → 无输出。
  expect(out.map((p) => p.date)).toEqual(['2024-06-05']);

  const mean = 100.8;
  const sd = Math.sqrt(base.reduce((a, b) => a + (b - mean) ** 2, 0) / 4); // 样本口径 ÷(n−1)
  expect(out[0].value).toBeCloseTo((120 - mean) / sd, 10);
});

test('seasonalZ:跨年取样用环形日序差 —— 元旦的点能取到往年 12 月末', () => {
  // 往年样本只放在 12-28(距 01-02 环形 5 天,直线 360 天)。按 week-of-year 或直线差都取不到。
  const xmas = [95, 105, 95, 105, 100]; // 均值 100
  const rows = [
    ...weeklyAt('12-28', [2019, 2020, 2021, 2022, 2023], (y) => xmas[y - 2019]),
    { date: '2024-01-02', value: 100 },
  ];
  const out = seasonalZ(rows, { years: 5, minSamples: 5, windowDays: 10 });

  expect(out.map((p) => p.date)).toEqual(['2024-01-02']);
  expect(out[0].value).toBeCloseTo(0, 10); // 恰好落在往年同期均值上
});

test('seasonalZ:样本不足或 σ=0 的点跳过,不出不可信的 z', () => {
  const thin = [...weeklyAt('06-05', [2022, 2023], (y) => y), { date: '2024-06-05', value: 9 }];
  expect(seasonalZ(thin, { years: 5, minSamples: 8 })).toEqual([]); // 只有 2 个往年样本

  const flat = [...weeklyAt('06-05', [2019, 2020, 2021, 2022, 2023], () => 100), { date: '2024-06-05', value: 120 }];
  expect(seasonalZ(flat, { years: 5, minSamples: 5 })).toEqual([]); // σ=0
});

test('seasonalZ:跨闰年不错位 —— 闰年 12/28 到次年 01/02 是 5 天,不是 4 天', () => {
  // 2020 是闰年:不归一到平年日历的话,它 3/1 之后的日序整体多 1,而环长固定 365 →
  // 12/28 到次年 01/02 会被算成 4 天(真实是 5 天)。下面两段分别钉住「窗口 5 取得到」与「窗口 4 取不到」。
  const rows = [
    ...weeklyAt('12-28', [2019, 2020, 2021, 2022, 2023], (y) => (y === 2020 ? 200 : 100)),
    { date: '2024-01-02', value: 100 },
  ];

  // 窗口 5:够得着(含 2020 的 200)→ 均值 120、σ>0 → 出点。
  const wide = seasonalZ(rows, { years: 5, minSamples: 5, windowDays: 5 });
  expect(wide.map((p) => p.date)).toEqual(['2024-01-02']);
  expect(wide[0].value).toBeCloseTo((100 - 120) / Math.sqrt(2000), 10); // ÷(n−1):8000/4

  // 窗口 4:真实间距 5 天 → 元旦那点一个样本都取不到。
  //
  // ⚠️ 基准期**必须含两个闰年**(这里 2020 与 2024,故 years=6),否则这条断言是空的:
  // 未归一时只有闰年那一个样本会被误算成 4 天而混进来,而 n=1 过不了 `Math.max(minSamples,2)`
  // 那道门,照样被跳过 → 去掉归一逻辑测试仍然绿。两个闰年才凑够 n=2,让「混进来」真的走到输出。
  const near = [
    ...weeklyAt('12-28', [2019, 2020, 2021, 2022, 2023, 2024], (y) => (y === 2020 ? 200 : 100)),
    { date: '2025-01-02', value: 100 },
  ];
  const narrow = seasonalZ(near, { minSamples: 2, windowDays: 4, years: 6 });
  expect(narrow.find((p) => p.date === '2025-01-02')).toBeUndefined();
});

test('seasonalZ:闰年 3/1 与平年 3/1 视为同一季节位置', () => {
  // 2020/2024 闰年。不归一的话它们的日序比平年多 1,windowDays=0 时配不上。
  const base = [98, 102, 98, 102, 100]; // 均值 100、σ>0(σ=0 会被跳过)
  const rows = [
    ...weeklyAt('03-01', [2019, 2020, 2021, 2022, 2023], (y) => base[y - 2019]),
    { date: '2024-03-01', value: 110 },
  ];
  // windowDays=0 = 只认「同一个季节位置」。2020 闰年那点必须仍算同位,否则样本只剩 4 个。
  const out = seasonalZ(rows, { years: 5, minSamples: 5, windowDays: 0 });

  expect(out.map((p) => p.date)).toEqual(['2024-03-01']);
  expect(out[0].value).toBeCloseTo((110 - 100) / Math.sqrt(4), 10); // ÷(n−1):16/4
});

test('seasonalZ:任何情况下不得漏出 NaN/Infinity(n=1 时 ÷(n−1) 会除以 0)', () => {
  // ⚠️ 这条断言**不区分**是被「下限 2」挡住的还是被 `sd > 0` 挡住的 —— 两道闸互为冗余,
  // 拆掉任一道另一道都能兜住。它声称的就只是行为结论:不漏非有限值。
  const rows = [
    { date: '2023-06-05', value: 100 },
    { date: '2024-06-05', value: 120 },
  ];
  expect(seasonalZ(rows, { years: 5, minSamples: 1 })).toEqual([]);

  const many = [...weeklyAt('06-05', [2019, 2020, 2021, 2022, 2023], (y) => y), { date: '2024-06-05', value: 9 }];
  for (const p of seasonalZ(many, { years: 5, minSamples: 1 })) expect(Number.isFinite(p.value)).toBe(true);
});

test('seasonalZ:基准期下界生效 —— 超出 years 的往年数据不得进基准', () => {
  // 回归点:`q.year >= p.year - years` 这半个条件此前没有任何用例咬合(现有 fixture 历史都不超 5 年),
  // 删掉它 17 条测试照样全绿。它一旦失效,z 会拿全部历史当基准 —— 与 EIA 官方 5-year average 口径、
  // 以及 fetcher 多拉那几年的理由同时失配,而且同样无声。
  const base = [100, 102, 100, 102, 100]; // 2019-2023,均值 100.8
  const rows = [
    { date: '2013-06-05', value: 10_000 }, // 第 11 年前的离群值,必须够不着
    ...weeklyAt('06-05', [2019, 2020, 2021, 2022, 2023], (y) => base[y - 2019]),
    { date: '2024-06-05', value: 120 },
  ];
  const out = seasonalZ(rows, { minSamples: 5, years: 5 });

  const mean = 100.8;
  const sd = Math.sqrt(base.reduce((a, b) => a + (b - mean) ** 2, 0) / 4);
  const z2024 = out.find((p) => p.date === '2024-06-05');
  // 若下界失效,2013 那个 10000 会进基准,均值/σ 被彻底拉偏,这个值对不上。
  expect(z2024?.value).toBeCloseTo((120 - mean) / sd, 10);
});

// ── 能源派生层。这几条都是「改错了也不报错、只让图默默变成另一个量」的地方 ──
const seq = (vals: number[], from = 1) =>
  vals.map((v, i) => ({ date: `2024-01-${String(i + from).padStart(2, '0')}`, value: v }));

test('oilCracks:三条裂解的数学(×42、权重 2:1、缺腿返回 undefined)', () => {
  const wti = seq([60, 60]);
  const diesel = seq([2, 3]); // $/gal
  const rbob = seq([2, 2]);

  const { dieselCrack, rbobCrack, crack321 } = oilCracks({ wti, diesel, rbob });
  expect(dieselCrack).toEqual(seq([2 * 42 - 60, 3 * 42 - 60]));
  expect(rbobCrack).toEqual(seq([2 * 42 - 60, 2 * 42 - 60]));
  // 3-2-1 = (2×汽油裂解 + 柴油裂解)/3;权重写成 1/2 会得到别的数。
  expect(crack321?.map((p) => p.value)).toEqual([(2 * 24 + 24) / 3, (2 * 24 + 66) / 3]);
  // 与直接口径 (2×RBOB + ULSD)×42/3 − WTI 对齐
  expect(crack321?.[1].value).toBeCloseTo(((2 * 2 + 3) * 42) / 3 - 60, 10);

  // 缺任一腿 → 相关那条为 undefined,不出半对的数
  expect(oilCracks({ wti: null, diesel, rbob }).dieselCrack).toBeUndefined();
  expect(oilCracks({ wti, diesel, rbob: null }).crack321).toBeUndefined();
  expect(oilCracks({ wti, diesel, rbob: null }).dieselCrack).toBeDefined(); // 只丢受影响的那条
});

test('distillateYield:分子是产量、分母是加工量(写反了值仍在合理量级,肉眼看不出)', () => {
  const distProd = seq([5000]);
  const crudeRuns = seq([16000]);

  expect(distillateYield(distProd, crudeRuns)?.[0].value).toBeCloseTo(31.25, 10);
  // 写反 → 320,不是 31.25
  expect(distillateYield(crudeRuns, distProd)?.[0].value).toBeCloseTo(320, 10);
  expect(distillateYield(null, crudeRuns)).toBeUndefined();
});

test('seasonalZFrom:先算 z 再裁 —— 顺序反了会把基准期一起砍掉', () => {
  // 贴近生产:±10 天窗 × 5 年 ≈ 15 个样本(默认 minSamples=8,样本太少会被整体跳过)。
  const years = [2019, 2020, 2021, 2022, 2023];
  const around = ['05-29', '06-05', '06-12']; // 距 06-05 分别 7 / 0 / 7 天,都在窗内
  const valueAt = (y: number, i: number) => 100 + ((y + i) % 3);

  const rows = [
    ...years.flatMap((y) => around.map((md, i) => ({ date: `${y}-${md}`, value: valueAt(y, i) }))),
    { date: '2024-06-05', value: 120 },
  ];
  const out = seasonalZFrom(rows, { years: 5, from: '2024-01-01' });

  const base = years.flatMap((y) => around.map((_, i) => valueAt(y, i)));
  const mean = base.reduce((a, b) => a + b, 0) / base.length;
  const sd = Math.sqrt(base.reduce((a, b) => a + (b - mean) ** 2, 0) / (base.length - 1));

  // 裁剪只该切掉输出,不该切掉基准期 —— 若先裁再算,2024 那点的往年样本被砍光 → 输出空。
  expect(out?.map((p) => p.date)).toEqual(['2024-06-05']);
  expect(out?.[0].value).toBeCloseTo((120 - mean) / sd, 10);
  expect(seasonalZFrom(null, { years: 5, from: '2024-01-01' })).toBeUndefined();
});

test('seasonalZ:minSamples 默认 8 —— 生产端不传这个参数,默认值就是实际策略', () => {
  // 「宁可线短一截,不出不可信的 z」是写在文档里的口径,而路由调用 seasonalZ 时只传 years。
  // 默认值被悄悄调小(比如 2)就等于改了策略,却不会有任何地方报错。
  const five = [
    ...weeklyAt('06-05', [2019, 2020, 2021, 2022, 2023], (y) => 100 + (y % 3)),
    { date: '2024-06-05', value: 120 },
  ];
  // 5 个往年样本 < 默认 8 → 整条空。若默认值被调到 ≤5,这里就会出点。
  expect(seasonalZ(five, { years: 5 })).toEqual([]);

  // 补到每年 3 个窗内点(2024 那点的基准就有 15 个)才出得来 —— 证明门槛确实是 8 而不是更松的数。
  // 只查 2024 那一点:靠后的年份自己也够样本、本来就该出 z,把它们算进来会让断言依赖年份数。
  const enough = [
    ...[2019, 2020, 2021, 2022, 2023].flatMap((y) =>
      ['05-29', '06-05', '06-12'].map((md, i) => ({ date: `${y}-${md}`, value: 100 + ((y + i) % 3) })),
    ),
    { date: '2024-06-05', value: 120 },
  ];
  expect(seasonalZ(enough, { years: 5 }).find((p) => p.date === '2024-06-05')).toBeDefined();
});
