import { describe, expect, it } from 'bun:test';
import { fastRegime, ratioSeries } from './attackDefense.hooks';

const bar = (date: string, close: number) => ({ date, open: close, high: close, low: close, close });

describe('ratioSeries', () => {
  it('按日期内联相除,qqq 缺的日期跳过', () => {
    const nobl = [bar('d1', 50), bar('d2', 52), bar('d3', 51)];
    const qqq = [bar('d1', 400), bar('d2', 410)]; // 缺 d3
    const r = ratioSeries(nobl, qqq);
    expect(r.map((p) => p.date)).toEqual(['d1', 'd2']);
    expect(r[0].value).toBeCloseTo(0.125); // 50/400
    expect(r[1].value).toBeCloseTo(0.126829); // 52/410
  });
  it('任一缺失 → []', () => {
    expect(ratioSeries([], [bar('d1', 1)])).toEqual([]);
    expect(ratioSeries([bar('d1', 1)], [])).toEqual([]);
  });
});

describe('fastRegime', () => {
  const pts = (vals: number[]) => vals.map((value, i) => ({ date: `d${i}`, value }));

  it('均线未满 N 日 → ma=null、neutral', () => {
    const r = fastRegime(pts([1, 1, 2]), 3, 0.02);
    expect(r.slice(0, 2).map((x) => [x.ma, x.regime])).toEqual([
      [null, 'neutral'],
      [null, 'neutral'],
    ]);
    expect(r[2].ma).toBeCloseTo(4 / 3);
  });

  it('超出 ±band 才翻,带内保持前一状态(滞回)', () => {
    // N=2:d1 均线 1.05,1.1 > 1.05×1.02 → defense;d2 均线 1.1,1.1 在带内 → 保持;d3 均线 1.0,0.9 < 0.98 → offense
    const r = fastRegime(pts([1, 1.1, 1.1, 0.9]), 2, 0.02);
    expect(r.map((x) => x.regime)).toEqual(['neutral', 'defense', 'defense', 'offense']);
  });
});
