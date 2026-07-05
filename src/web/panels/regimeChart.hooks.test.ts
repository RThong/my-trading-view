import { test, expect } from 'bun:test';
import { buildRegimeSpecs, type RegimeData } from './regimeChart.hooks';

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
