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

describe('rotationEpisodes · A 候选', () => {
  it('数据截在 VIX ≥ 30 那一簇中间:A 标为候选(还会挪);走完的轮没有候选', () => {
    const cut = (s: { date: string; value: number }[]) => s.slice(0, 301); // 截到第 300 天,VIX 35 还在
    const [open] = rotationEpisodes(cut(qqq), cut(xlp), cut(vix), cut(hy(3)));
    expect(open.outcome).toBe('进行中·通杀');
    expect(open.lowsAOpen).toEqual([day(300)]);
    expect(rotationSeries(cut(qqq), cut(xlp), cut(vix), cut(hy(3))).rpLowA).toEqual([]);

    const [done] = rotationEpisodes(qqq, xlp, vix, hy(3));
    expect(done.lowsAOpen).toEqual([]);
  });
});

describe('rotationEpisodes · A 候选(见底后)', () => {
  it('进行中·见底、③ + 5 天之后同一簇 VIX ≥ 30 还在延续:A 仍是候选', () => {
    // 底在第 300 天;312 / 318 / 323 / 329 天把 VIX 抬到 31(相隔都 ≤ 7 天,和 300 日那一簇连成一簇),
    // 第 325 天 QQQ 反弹满 10% 且 VIX < 25 → 见底确认;数据截到第 330 天
    const n = 331;
    const hot = new Set([312, 318, 323, 329]);
    const v2 = vix.slice(0, n).map((p, i) => (hot.has(i) ? { ...p, value: 31 } : p));
    const [e] = rotationEpisodes(qqq.slice(0, n), xlp.slice(0, n), v2, hy(3).slice(0, n));

    expect(e.outcome).toBe('进行中·见底');
    expect(e.bottom).toBe(day(300));
    expect(e.lowsAOpen).toEqual([day(300)]);
  });
});

describe('rotationEpisodes · 当时出现过的', () => {
  it('合成数据里 QQQ 一路新低到第 300 天:300 之前出现过的 A 候选都记成「挪走」,最终 A 不在其中', () => {
    const [e] = rotationEpisodes(qqq, xlp, vix, hy(3));
    expect(e.ghostA.length).toBeGreaterThan(0);
    expect(e.ghostA.every((d) => d < day(300))).toBe(true);
    expect(e.ghostA).not.toContain(day(300));
    expect(e.ghostBottoms).toEqual([]);
    expect(e.ghostKills).toEqual([]);
  });

  it('XLP 再创新高把通杀撤销:撤销的那段记进 ghostKills', () => {
    // 通杀约在第 281 天确认;第 285 天把 XLP 抬到 57,超过 ② 的 56 → 退回高切低,260~285 那段通杀撤销
    const x2 = xlp.map((p, i) => (i === 285 ? { ...p, value: 57 } : p));
    const [e] = rotationEpisodes(qqq, x2, vix, hy(3));
    expect(e.ghostKills.length).toBe(1);
    expect(e.ghostKills[0].from).toBe(day(260));
    expect(e.ghostKills[0].to).toBe(day(285));
  });
});

describe('rotationEpisodes · ② 要在死叉之后', () => {
  it('XLP 在 QQQ 刚见顶(EMA20 还没下穿 EMA50)时就见顶:② 不落在那天,改从死叉那天起找', () => {
    // XLP 第 205 天冲到 58(QQQ 第 200 天才见顶,还没死叉),回落后第 260 天反弹到 57 再往下:
    // 不看死叉 ② 会是 205,看死叉则是死叉之后的高点 260
    const x2 = path(
      [
        [0, 50],
        [200, 50],
        [205, 58],
        [225, 54],
        [260, 57],
        [290, 52],
        [N, 52],
      ],
      N,
    );
    const [e] = rotationEpisodes(qqq, x2, vix, hy(3));
    expect(e.peakX).toBe(day(260));
  });
});

describe('rotationEpisodes · 磨底型要周线背离', () => {
  it('第一阶段 VIX 到过 30(磨底型)、QQQ 只有一个低点(没有周线背离):不认 A、不判见底', () => {
    // 第 240 天(高切低期间)VIX 冲到 31 → 磨底型;QQQ 平滑地只探一次底,周线没有「更低的低点 + 指标更高」
    const v2 = vix.map((p, i) => (i === 240 ? { ...p, value: 31 } : p));
    const [e] = rotationEpisodes(qqq, xlp, v2, hy(3));
    expect(e.kind).toBe('磨底型');
    expect(e.lowsA).toEqual([]);
    expect(e.bottom).toBeUndefined();
    expect(e.outcome).toBe('进行中·通杀');
  });
});
