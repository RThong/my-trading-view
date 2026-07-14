import { test, expect } from 'bun:test';
import { buildRegimeSpecs, regimePercentiles, type RegimeData } from './regimeChart.hooks';

const data: RegimeData = {
  series: {
    netLiquidity: [{ date: '2020-01-01', value: 5 }, { date: '2020-01-02', value: 6 }],
    reverseRepo: [{ date: '2020-01-01', value: 2 }],
    // repoUsage 缺失(模拟 unavailable)
    repoStress: [{ date: '2020-01-01', value: -0.01 }],
  },
  unavailable: ['repoUsage'],
};

test('流动性维度:pane 下标按 paneDefs 顺序,缺失序列被跳过', () => {
  const specs = buildRegimeSpecs(data, 'liquidity', '1D');
  // 4 个 paneDef,repoUsage 缺 → 只出 3 条 spec
  expect(specs.map((s) => s.key)).toEqual(['netLiquidity', 'reverseRepo', 'repoStress']);
  // pane 下标 = 原 paneDefs 索引(repoUsage 是第 2,被跳过后 repoStress 仍是 3)
  expect(specs.map((s) => s.pane)).toEqual([0, 1, 3]);
});

test('repoStress 带 0 基线,其余无', () => {
  const specs = buildRegimeSpecs(data, 'liquidity', '1D');
  const byKey = Object.fromEntries(specs.map((s) => [s.key, s]));
  expect((byKey.repoStress as { baseline?: number }).baseline).toBe(0);
  expect((byKey.netLiquidity as { baseline?: number }).baseline).toBeUndefined();
});

test('全部缺失 → 空 specs', () => {
  expect(buildRegimeSpecs({ series: {}, unavailable: [] }, 'sentiment', '1D')).toEqual([]);
});

test('情绪维度:分位带 + 极端期背景带按 riskTail 语义上色', () => {
  // fng 0..100 步长 10,共 11 点 → P5=5、P95=95。fng riskTail=high:高端=风险(红)、低端=机会(绿)。
  const fng = Array.from({ length: 11 }, (_, i) => ({ date: `2021-01-${String(i + 1).padStart(2, '0')}`, value: i * 10 }));
  const specs = buildRegimeSpecs({ series: { fng }, unavailable: [] }, 'sentiment', '1D');

  // 每个有数据的 pane 出 [背景直方图, 线] 两条;这里只有 fng
  expect(specs.map((s) => s.key)).toEqual(['fng-bg', 'fng']);

  const line = specs[1] as { refLines?: { price: number; title: string }[] };
  expect(line.refLines).toEqual([{ price: 5, title: 'P5' }, { price: 95, title: 'P95' }]);

  const bg = specs[0] as { data: Array<{ value: number; color: string }>; priceScaleId?: string };
  expect(bg.priceScaleId).toBe('bg-fng');
  expect(bg.data[0]).toMatchObject({ value: 1, color: 'rgba(34,197,94,0.45)' });  // 值0 < P5,低端=机会=绿
  expect(bg.data[10]).toMatchObject({ value: 1, color: 'rgba(239,68,68,0.45)' }); // 值100 > P95,高端=风险=红
  expect(bg.data[5].value).toBe(0);                                               // 值50 不极端 → 无柱
});

test('candle 维度:标 candle 的序列用 ohlc 出蜡烛 spec', () => {
  const ohlc = { usd: [
    { time: '2021-01-04', open: 89, high: 90, low: 88, close: 89.5 },
    { time: '2021-01-05', open: 89.5, high: 91, low: 89, close: 90.8 },
  ] };
  const specs = buildRegimeSpecs({ series: { usd: [] }, unavailable: [], ohlc }, 'macro', '1D');
  expect(specs.map((s) => s.key)).toEqual(['usd']);
  expect((specs[0] as { kind: string }).kind).toBe('candle');
  expect((specs[0] as { data: unknown[] }).data.length).toBe(2);
});

test('percentiles 维度里无 riskTail 的序列不画背景带(方向不单一,只留 P5/P95 线)', () => {
  const dgs10 = Array.from({ length: 21 }, (_, i) => ({ date: `2021-01-${String(i + 1).padStart(2, '0')}`, value: i }));
  const specs = buildRegimeSpecs({ series: { dgs10 }, unavailable: [] }, 'ratesVol', '1D');
  expect(specs.map((s) => s.key)).toEqual(['dgs10']); // 无 dgs10-bg 背景带
  const line = specs[0] as { kind: string; refLines?: unknown[] };
  expect(line.kind).toBe('line');
  expect(line.refLines).toHaveLength(2); // P5/P95 参考线仍在
});

test('期限结构:符号柱状图(正绿负红、0基线),不套分位带/徽标', () => {
  const vxTermSpread = [
    { date: '2021-01-01', value: 2 },   // 正 → 绿
    { date: '2021-01-02', value: -1.5 }, // 负 → 红
  ];
  const specs = buildRegimeSpecs({ series: { vxTermSpread }, unavailable: [] }, 'vol', '1D');
  expect(specs.map((s) => s.key)).toEqual(['vxTermSpread']); // 单条 histo,无 bg/line 对
  const h = specs[0] as { kind: string; baseline?: number; refLines?: unknown; data: Array<{ value: number; color: string }> };
  expect(h.kind).toBe('histogram');
  expect(h.baseline).toBe(0);
  expect(h.refLines).toBeUndefined();
  expect(h.data[0].color).toBe('#22c55e'); // 正=绿
  expect(h.data[1].color).toBe('#ef4444'); // 负=红
  // 无分位徽标
  expect(regimePercentiles({ series: { vxTermSpread }, unavailable: [] }, 'vol').vxTermSpread).toBeUndefined();
});

test('jgbVol:jgb10y 无 riskTail → 无背景带', () => {
  const jgb10y = [{ date: '2020-01-01', value: 0.1 }, { date: '2020-01-02', value: 0.12 }];
  const specs = buildRegimeSpecs({ series: { jgb10y }, unavailable: [] }, 'jgbVol', '1D');
  expect(specs.map((s) => s.key)).toEqual(['jgb10y']); // 无 jgb10y-bg
});

test('jgbVol:jgbVix 有 riskTail → 带背景带', () => {
  const jgbVix = [{ date: '2020-01-01', value: 2 }, { date: '2020-01-02', value: 3 }];
  const specs = buildRegimeSpecs({ series: { jgbVix }, unavailable: [] }, 'jgbVol', '1D');
  expect(specs.map((s) => s.key)).toEqual(['jgbVix-bg', 'jgbVix']);
});

test('valuation:cape 有 riskTail high → 带背景带', () => {
  const cape = [{ date: '2020-01-01', value: 30 }, { date: '2020-02-01', value: 42 }];
  const specs = buildRegimeSpecs({ series: { cape }, unavailable: [] }, 'valuation', '1D');
  expect(specs.map((s) => s.key)).toEqual(['cape-bg', 'cape']);
});
