import { describe, expect, it } from 'bun:test';
import { attackDefenseSeries, fastRegime, ratioSeries } from './attackDefense';

function bar(date: string, value: number) {
  return { date, value };
}

describe('ratioSeries', () => {
  it('按日期内联相除,qqq 缺的日期跳过', () => {
    const xlp = [bar('d1', 50), bar('d2', 52), bar('d3', 51)];
    const qqq = [bar('d1', 400), bar('d2', 410)]; // 缺 d3
    const r = ratioSeries(xlp, qqq);
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

describe('attackDefenseSeries', () => {
  it('背景标记逐日 0 / 1、同一天至多一类为 1;均线从第 N 日起才有', () => {
    // 比值先涨 30% 再跌 30%:确认一个峰,之后的下行腿未确认(待定)
    const vals = [1, 1.1, 1.2, 1.3, 1.2, 1.0, 0.9];
    const xlp = vals.map((v, i) => bar(`d${i}`, v));
    const qqq = vals.map((_, i) => bar(`d${i}`, 1));
    const s = attackDefenseSeries(xlp, qqq);
    const flags = [s.zigDefense, s.zigOffense, s.zigDefensePending, s.zigOffensePending];

    expect(s.ratio.map((p) => p.value)).toEqual(vals);
    expect(flags.every((f) => f.length === vals.length)).toBe(true);
    expect(vals.map((_, i) => flags.reduce((n, f) => n + f[i].value, 0)).every((n) => n <= 1)).toBe(true);
    expect(s.zigDefense.slice(0, 4).map((p) => p.value)).toEqual([1, 1, 1, 1]);
    expect(s.zigOffensePending.slice(4).map((p) => p.value)).toEqual([1, 1, 1]);
    expect(s.ma).toEqual([]);
  });
});
