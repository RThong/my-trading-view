import { describe, expect, it } from 'bun:test';
import { accruedPts, chainDayPrices, clusterGap, dayPrice, denseFrom } from './cdsTrades';

describe('accruedPts', () => {
  it('票息 × 距上个付息日天数(含 T+1)/ 360', () => {
    expect(accruedPts('2026-11-12', 100)).toBeCloseTo((54 * 1) / 360, 6); // 9/20 → 11/12 是 53 天,+1
    expect(accruedPts('2026-09-21', 100)).toBeCloseTo(2 / 360, 6);
    expect(accruedPts('2026-09-20', 100)).toBeCloseTo(1 / 360, 6); // 付息日当天从头算,不是上一季的 93 天
    expect(accruedPts('2026-01-05', 500)).toBeCloseTo((17 * 5) / 360, 6); // 跨年:上个付息日是去年 12/20
  });
});

describe('dayPrice', () => {
  it('买方付(价 < 100):价 = 100 − u − 应计', () => {
    expect(dayPrice([4, 4.2, 4.1], 0.1, 96)).toBeCloseTo(100 - 4.1 - 0.1, 6);
  });

  it('卖方付(价 > 100):按参照价选到 100 + u − 应计', () => {
    expect(dayPrice([0.6], 0.1, 100.6)).toBeCloseTo(100.5, 6);
  });

  it('换合约那周成交分两团:取离参照价近的那团,不被另一团拉偏', () => {
    // 参照 100.45;一团 u≈0.4(价 ≈ 100.4),一团 u≈1.95(价 ≈ 101.95),笔数相当
    expect(dayPrice([0.4, 0.45, 0.46, 1.9, 1.95, 2.0], 0, 100.45)).toBeCloseTo(100.45, 6);
  });

  it('剧烈日整天远离参照价但连成一团:照取整团中位数,不往参照价偏', () => {
    expect(dayPrice([5.0, 5.2, 5.4, 5.6, 5.8], 0, 96)).toBeCloseTo(94.6, 6);
  });
});

describe('clusterGap', () => {
  it('随利差放大:投资级取下限 0.5 点,高利差名放宽到不切碎日内正常波动', () => {
    expect(clusterGap(101.8, 100)).toBe(0.5); // ~60bp
    expect(clusterGap(95, 100)).toBeGreaterThan(1); // ~215bp
    expect(clusterGap(75, 500)).toBeGreaterThan(4); // ~1100bp
    expect(clusterGap(30, 100)).toBe(0.5); // 价 ≤ 回收价无解 → 下限
  });
});

describe('chainDayPrices', () => {
  it('每天以上一天算出的价为参照(往前补时从 ICE 第一天起锚)', () => {
    // 从 100.5 起锚往前:第一天 u=0.3 → 100.3;第二天 u=0.1 → 参照 100.3 选 100.1(而不是 99.9)
    const out = chainDayPrices(
      [
        { date: '2026-07-23', us: [0.3] },
        { date: '2026-07-22', us: [0.1] },
      ],
      100.5,
      0,
    );
    expect(out.map((p) => p.date)).toEqual(['2026-07-23', '2026-07-22']);
    expect(out[0].price).toBeCloseTo(100.3, 6);
    expect(out[1].price).toBeCloseTo(100.1, 6);
  });
});

describe('denseFrom', () => {
  // 某月前 n 个工作日(够用:只看天数)
  const month = (m: string, n: number) => Array.from({ length: n }, (_, i) => `${m}-${String(i + 1).padStart(2, '0')}`);

  it('从最后一个稀疏月之后开始;空月也算稀疏;截止月(残月)不参与判断', () => {
    const dates = [...month('2025-01', 10), ...month('2025-03', 9), ...month('2025-04', 8), ...month('2025-05', 2)];
    // 2025-02 一天没有 → 从 03 起;05 只有 2 天但是截止月,不算
    expect(denseFrom(dates, '2025-05-15')).toBe('2025-03-01');
  });

  it('中间夹着稀疏月 → 只从它之后算;整月全稀疏 → 只留截止月(残月);没有成交 → 回截止日', () => {
    const mid = [...month('2025-01', 10), ...month('2025-02', 3), ...month('2025-03', 9), ...month('2025-04', 1)];
    expect(denseFrom(mid, '2025-04-20')).toBe('2025-03-01');
    expect(denseFrom([...month('2025-01', 2), ...month('2025-02', 2), ...month('2025-03', 1)], '2025-03-31')).toBe(
      '2025-03-01',
    );
    expect(denseFrom([], '2026-07-24')).toBe('2026-07-24');
  });

  it('截止月之前的空月也算稀疏(不能拿最后一个有成交的月当终点)', () => {
    // 4~6 月够密,7 月一笔都没有,截止日在 8 月 → 7 月稀疏 → 只留 8 月残月(这里没成交,等于没有)
    const dates = [...month('2026-04', 10), ...month('2026-05', 10), ...month('2026-06', 10)];
    expect(denseFrom(dates, '2026-08-10')).toBe('2026-08-01');
  });
});
