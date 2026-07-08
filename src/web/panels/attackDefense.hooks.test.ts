import { describe, expect, it } from 'bun:test';
import { ratioSeries, regimeZones } from './attackDefense.hooks';

const bar = (date: string, close: number) => ({ date, open: close, high: close, low: close, close });

describe('ratioSeries', () => {
  it('按日期内联相除,qqq 缺的日期跳过', () => {
    const nobl = [bar('d1', 50), bar('d2', 52), bar('d3', 51)];
    const qqq = [bar('d1', 400), bar('d2', 410)]; // 缺 d3
    const r = ratioSeries(nobl, qqq);
    expect(r.map((p) => p.date)).toEqual(['d1', 'd2']);
    expect(r[0].value).toBeCloseTo(0.125);   // 50/400
    expect(r[1].value).toBeCloseTo(0.126829); // 52/410
  });
  it('任一缺失 → []', () => {
    expect(ratioSeries([], [bar('d1', 1)])).toEqual([]);
    expect(ratioSeries([bar('d1', 1)], [])).toEqual([]);
  });
});

describe('regimeZones: 均线+迟滞', () => {
  it('前 maLen-1 neutral;上穿+band→defense;带内维持;下穿-band→offense', () => {
    const vals = [1, 1, 1, 1.1, 1.02, 0.85];
    const ratio = vals.map((v, i) => ({ date: `d${i}`, value: v }));
    const z = regimeZones(ratio, 3, 0.05).map((p) => p.regime);
    expect(z).toEqual(['neutral', 'neutral', 'neutral', 'defense', 'defense', 'offense']);
  });
});
