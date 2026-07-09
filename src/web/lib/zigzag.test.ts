import { describe, expect, it } from 'bun:test';
import { zigzagRegimes } from './zigzag';

describe('zigzagRegimes: ZigZag 摆动(吸附极值)', () => {
  const mk = (vals: number[]) => vals.map((v, i) => ({ date: `d${i}`, value: v }));

  it('结束于峰=defense、结束于谷=offense;拐点吸附极值;首拐点前也上色;末腿 pending', () => {
    // 升到峰(idx2=1.20)→回落确认峰→跌到谷(idx4=1.00)→反弹确认谷→再升(末腿待定)
    const r = zigzagRegimes(mk([1.00, 1.05, 1.20, 1.05, 1.00, 1.15, 1.25]), 0.10);
    expect(r.map((p) => p.regime)).toEqual(
      ['defense', 'defense', 'defense', 'offense', 'offense', 'defense', 'defense']);
    expect(r.map((p) => p.pending)).toEqual([false, false, false, false, false, true, true]);
  });

  it('不够 pct 的小回撤不产生拐点 → 全 neutral', () => {
    const r = zigzagRegimes(mk([1.00, 1.03, 0.98, 1.02]), 0.10);
    expect(r.every((p) => p.regime === 'neutral')).toBe(true);
  });

  it('空输入 → []', () => expect(zigzagRegimes([], 0.10)).toEqual([]));
});
