import { test, expect } from 'bun:test';
import { runBacktest, type AlignedRow, type EngineConfig } from './engine';
import type { DayState } from './signal';

const prices: AlignedRow[] = [
  { date: 'd0', qqq: 100, tqqq: 10 },
  { date: 'd1', qqq: 110, tqqq: 13 }, // qqq +10%, tqqq +30%
  { date: 'd2', qqq: 99, tqqq: 10.4 }, // qqq -10%, tqqq -20%
];

const st = (panic: boolean, greed: boolean): DayState => ({ date: '', panic, greed });
const base: EngineConfig = { tqqqSleeve: 0.3, cashSleeve: 0.2, costBps: 0, legs: { rotation: true, cashInsurance: true } };

test('基准(无腿):纯 QQQ close-to-close', () => {
  const states = [st(false, false), st(false, false), st(false, false)];
  const eq = runBacktest(states, prices, { ...base, legs: { rotation: false, cashInsurance: false } });
  expect(eq[1].value).toBeCloseTo(1.10);        // +10%
  expect(eq[2].value).toBeCloseTo(1.10 * 0.90); // -10%
});

test('执行错位:第 t 天状态吃 t→t+1 收益(当天不贡献)', () => {
  // day0 就 panic → 用 d0→d1 收益(70%QQQ+30%TQQQ):0.7*10% + 0.3*30% = 16%
  const states = [st(true, false), st(false, false), st(false, false)];
  const eq = runBacktest(states, prices, { ...base, costBps: 0 });
  expect(eq[1].value).toBeCloseTo(1.16);
});

test('换手成本按 L1 权重变动计', () => {
  // day0 panic(权重 70/30,较初始 100/0 变动 L1=0.6),costBps=5 → 成本 0.6*5bps=3bps
  const states = [st(true, false), st(false, false), st(false, false)];
  const eq = runBacktest(states, prices, { ...base, costBps: 5 });
  expect(eq[1].value).toBeCloseTo(1.16 * (1 - 0.0003));
});

test('现金腿:贪婪减仓 20% → 只吃 80% QQQ 收益', () => {
  const states = [st(false, true), st(false, false), st(false, false)];
  const eq = runBacktest(states, prices, { ...base, costBps: 0, legs: { rotation: false, cashInsurance: true } });
  expect(eq[1].value).toBeCloseTo(1 + 0.8 * 0.10); // 8%
});
