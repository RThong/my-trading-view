import { describe, test, expect } from 'bun:test';
import { computeSoxFng, putcallScore, type Bar } from './soxFng';

// 造一段合成日线:N 天,收盘按给定函数生成。
function mkBars(n: number, closeAt: (i: number) => number, volAt: (i: number) => number = () => 1000): Bar[] {
  const start = new Date('2022-01-03T00:00:00Z');
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(start.getTime() + i * 86400_000);
    return { date: d.toISOString().slice(0, 10), close: closeAt(i), volume: volAt(i) };
  });
}

describe('computeSoxFng', () => {
  test('复合指数与子分数恒在 0-100', () => {
    const n = 500;
    // 锚:带噪声的上升趋势;债:缓涨;成分:各自不同斜率
    const anchor = mkBars(n, (i) => 100 + i * 0.3 + Math.sin(i / 7) * 5);
    const bond = mkBars(n, (i) => 100 + i * 0.02);
    const constituents = Array.from({ length: 20 }, (_, s) =>
      mkBars(n, (i) => 50 + i * (0.1 + s * 0.01) + Math.cos(i / (5 + s)) * 3),
    );

    const rows = computeSoxFng({ anchor, bond, constituents });

    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.index).toBeGreaterThanOrEqual(0);
      expect(r.index).toBeLessThanOrEqual(100);
      for (const v of Object.values(r.parts)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    }
  });

  test('波动子指标翻转:平静期得高分(贪),爆炸期得低分(恐)', () => {
    const n = 400;
    const bond = mkBars(n, () => 100);
    const constituents = Array.from({ length: 20 }, () => mkBars(n, (i) => 50 + i * 0.05));

    // 前 300 天平静(小波动),后 100 天剧烈震荡(大波动)
    const anchor = mkBars(n, (i) => (i < 300 ? 100 + i * 0.1 : 100 + i * 0.1 + (i % 2 ? 20 : -20)));

    const rows = computeSoxFng({ anchor, bond, constituents });

    const calm = rows.filter((r) => r.parts.vol != null && r.date < rows[250].date).map((r) => r.parts.vol!);
    const wild = rows
      .slice(-20)
      .map((r) => r.parts.vol)
      .filter((v): v is number => v != null);

    // 平静期均分应明显高于爆炸期(翻转生效)
    expect(calm.reduce((a, b) => a + b, 0) / calm.length).toBeGreaterThan(
      wild.reduce((a, b) => a + b, 0) / wild.length,
    );
  });

  test('putcall 绝对映射:1.0→50、≥1.6→0、≤0.4→100、线性', () => {
    expect(putcallScore(1.0)).toBe(50);
    expect(putcallScore(1.6)).toBe(0);
    expect(putcallScore(0.4)).toBe(100);
    expect(putcallScore(1.787)).toBe(0); // 超界 clamp
    expect(putcallScore(0.7)).toBeCloseTo(75, 5); // 距中性 0.3 = 半幅一半 → +25
  });

  test('动量 125 日均线含当日(标准 SMA 口径)', () => {
    // 前 189 天收盘 100,末日跳 200:含当日均线 = (124×100 + 200)/125 = 100.8 → mom raw = 200/100.8 - 1。
    const n = 190;
    const anchor = mkBars(n, (i) => (i === n - 1 ? 200 : 100));
    const bond = mkBars(n, () => 100);
    const constituents = Array.from({ length: 20 }, () => mkBars(n, (i) => 50 + i * 0.05));

    const last = computeSoxFng({ anchor, bond, constituents }).at(-1)!;
    expect(last.raw.mom).toBeCloseTo(200 / 100.8 - 1, 4); // ≈0.9841;若排除当日会是 1.0
  });

  test('量广度:无成交量的成分不计入有效票(跌破 15 只则当日缺席)', () => {
    const n = 200;
    const anchor = mkBars(n, (i) => 100 + i * 0.1);
    const bond = mkBars(n, () => 100);
    // 15 只每天上涨、有量 → 量广度成立
    const upVol = () =>
      Array.from({ length: 15 }, () =>
        mkBars(
          n,
          (i) => 50 + i * 0.2,
          () => 1000,
        ),
      );
    expect(computeSoxFng({ anchor, bond, constituents: upVol() }).at(-1)!.raw.breadth).not.toBeUndefined();

    // 其中一只改成 null 量 → 只剩 14 只有效 < 15 → 量广度当日缺席
    const withNull = upVol();
    withNull[0] = mkBars(
      n,
      (i) => 50 + i * 0.2,
      () => null as unknown as number,
    );
    expect(computeSoxFng({ anchor, bond, constituents: withNull }).at(-1)!.raw.breadth).toBeUndefined();
  });
});
