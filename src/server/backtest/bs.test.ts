import { test, expect } from 'bun:test';
import { bsPut } from './bs';

test('ATM 参考价:S=K=100,T=1,σ=0.2,r=0 → put≈7.97', () => {
  expect(bsPut(100, 100, 1, 0.2, 0)).toBeCloseTo(7.97, 1);
});

test('深度实值 put 下限 ≈ 内在价值', () => {
  // S=80,K=100,短期低波动 → 接近 K−S=20
  expect(bsPut(80, 100, 0.05, 0.1)).toBeGreaterThanOrEqual(20);
  expect(bsPut(80, 100, 0.05, 0.1)).toBeLessThan(21);
});

test('T≤0 或 σ≤0 → 内在价值', () => {
  expect(bsPut(90, 100, 0, 0.2)).toBe(10);   // 到期,intrinsic 10
  expect(bsPut(110, 100, 0, 0.2)).toBe(0);   // 到期,虚值
  expect(bsPut(90, 100, 0.5, 0)).toBe(10);   // σ=0
});

test('虚值 put 随时间/波动升值', () => {
  const short = bsPut(100, 95, 0.1, 0.2);
  const long = bsPut(100, 95, 0.5, 0.2);
  expect(long).toBeGreaterThan(short); // 更长期限更值钱
});
