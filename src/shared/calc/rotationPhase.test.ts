import { describe, expect, it } from 'bun:test';
import { rotationEpisodes, rotationSeries } from './rotationPhase';

// 合成一轮完整的 高切低 → 通杀 → 见底:分段线性插值,日期按自然日连续排
function day(i: number) {
  return new Date(Date.UTC(2020, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
}
function path(knots: [number, number][], n: number) {
  return Array.from({ length: n }, (_, i) => {
    const k = knots.findIndex(([d]) => d >= i);
    if (k <= 0) return { date: day(i), value: knots[Math.max(k, 0)][1] };
    const [d0, v0] = knots[k - 1];
    const [d1, v1] = knots[k];
    return { date: day(i), value: v0 + ((v1 - v0) * (i - d0)) / (d1 - d0) };
  });
}

const N = 420;
// QQQ 200 日见顶 → 跌到 90(高切低)→ 300 日跌到 80(通杀)→ 反弹回 99(见底、走完)
const qqq = path(
  [
    [0, 90],
    [200, 100],
    [260, 90],
    [300, 80],
    [330, 90],
    [N, 99.5],
  ],
  N,
);
// XLP 200~260 日涨 12%(高切低),之后回撤 7%(通杀)
const xlp = path(
  [
    [0, 50],
    [200, 50],
    [260, 56],
    [290, 52],
    [N, 52],
  ],
  N,
);
// VIX:通杀确认前 26(没过 30),300 日附近冲到 35,之后回落到 20
const vix = path(
  [
    [0, 15],
    [260, 15],
    [270, 26],
    [285, 26],
    [295, 35],
    [305, 35],
    [320, 20],
    [N, 15],
  ],
  N,
);
function hy(v: number) {
  return qqq.map((p) => ({ date: p.date, value: v }));
}

describe('rotationEpisodes', () => {
  it('一轮走完:①② ③ 落在极值日,第一阶段 VIX 没过 30 = V 形,A 点在底', () => {
    const [e, ...rest] = rotationEpisodes(qqq, xlp, vix, hy(3));
    expect(rest).toEqual([]);
    expect(e.outcome).toBe('走完');
    expect(e.peakQ).toBe(day(200));
    expect(e.peakX).toBe(day(260));
    expect(e.bottom).toBe(day(300));
    expect(e.kind).toBe('V 形');
    expect(e.confirm1 < (e.confirm2 as string)).toBe(true);
    expect((e.confirm2 as string) < (e.confirm3 as string)).toBe(true);
    expect(e.lowsA).toEqual([day(300)]);
  });

  it('高切低确认当天 hyOas ≥ 6% → 信用危机型,不画标注', () => {
    const [e] = rotationEpisodes(qqq, xlp, vix, hy(6.5));
    expect(e.outcome).toBe('不算·信用危机型');
    expect(e.peakX).toBeUndefined();
  });
});

describe('rotationSeries', () => {
  it('底色 ① → ② 黄、② → ③ 红互不重叠;竖线落在极值日;分型标签挂在 ①', () => {
    const s = rotationSeries(qqq, xlp, vix, hy(3));
    const on = (rows: { date: string; value: number }[]) => rows.filter((p) => p.value === 1).map((p) => p.date);
    expect(on(s.rpRotate)[0]).toBe(day(200));
    expect(on(s.rpRotate).at(-1)).toBe(day(259));
    expect(on(s.rpKill)[0]).toBe(day(260));
    expect(on(s.rpKill).at(-1)).toBe(day(300));
    expect(s.rpPeakQ.map((p) => p.date)).toEqual([day(200)]);
    expect(s.rpBottom.map((p) => p.date)).toEqual([day(300)]);
    expect(s.rpPeakXPending).toEqual([]);
    expect(s.rpLabel).toEqual([{ date: day(200), value: 2 }]);
  });
});
