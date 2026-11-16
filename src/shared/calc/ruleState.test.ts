import { describe, expect, test } from 'bun:test';
import type { AlertRule } from '../alertRules';
import { hysteresisZones, MIN_PCTL_POINTS, ruleDays, ruleGeometry } from './ruleState';

describe('hysteresisZones', () => {
  // 常态带 [85, 97],常态 = 中间那段(1),回常态要多走 1
  const band = (xs: number[], confirm = 1) => hysteresisZones(xs, [85, 97], 1, 1, confirm);

  test('越线当天就进;往回贴着线不出,越过 pad 才出', () => {
    expect(band([90, 84, 85.5, 86.5])).toEqual([1, 0, 0, 1]);
    expect(band([90, 98, 96.5, 95.5])).toEqual([1, 2, 2, 1]);
  });

  test('从一端直接跨到另一端不受滞后限制', () => {
    expect(band([84, 98])).toEqual([0, 2]);
  });

  test('确认天数:新区间连续 N 天才切,中途回来就重新数', () => {
    expect(band([90, 84, 90, 84, 84], 2)).toEqual([1, 1, 1, 1, 0]);
  });

  test('阶梯(常态 = 最低一段):升级立即,降级要多走 pad', () => {
    const ladder = (xs: number[]) => hysteresisZones(xs, [13, 15], 0.5, 0);
    expect(ladder([12, 15.2, 14.8, 14.4, 12.7, 12.4])).toEqual([0, 2, 2, 1, 1, 0]);
  });
});

describe('ruleDays', () => {
  const pctlRule: AlertRule = {
    id: 't',
    version: 1,
    name: 't',
    at: 'vol',
    input: { series: 'vix' },
    percentile: { riskTail: 'low' },
  };

  // 第 i 天 / 第 i 个月的日期(真实日期:最小窗口按时间跨度判)
  const day = (i: number) => new Date(Date.UTC(2020, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
  const month = (i: number) => `${2020 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}-01`;

  test('分位规则:按截到当天的历史算分位,不看未来', () => {
    // 前 400 天递增,最后一天跌到 0:截到当天它是历史最低 → 低端区间
    const pts = [...Array.from({ length: 400 }, (_, i) => 10 + i), 0].map((value, i) => ({ time: day(i), value }));
    const days = ruleDays(pctlRule, pts, 3);
    expect(days).toHaveLength(3);
    // 递增序列每天都是「截至当天的最高」→ 高端区间;如果用了全样本,最后一天前的点不会都是 P95 以上
    expect(days.map((d) => d.zone)).toEqual([2, 2, 0]);
    expect(days.every((d) => d.judged)).toBe(true);
    expect(days.at(-1)?.rank).toBe(0);
  });

  test('窗口不够长(跨度不到一年或点数不够):不判、按常态填,judged = false', () => {
    // 日线 200 天:跨度不到一年
    const daily = Array.from({ length: 200 }, (_, i) => ({ time: day(i), value: i }));
    expect(ruleDays(pctlRule, daily, 1)).toEqual([{ time: day(199), value: 199, zone: 1, judged: false }]);
    // 月频 24 个月:跨度够了但点数不够 MIN_PCTL_POINTS
    const monthly = (n: number) => Array.from({ length: n }, (_, i) => ({ time: month(i), value: i }));
    expect(ruleDays(pctlRule, monthly(24), 1)[0].judged).toBe(false);
    // 月频攒满 MIN_PCTL_POINTS 个月就判(只按点数卡 250 的话,月频要 21 年)
    expect(ruleDays(pctlRule, monthly(MIN_PCTL_POINTS), 1)[0]).toMatchObject({ judged: true, zone: 2 });
  });

  test('NaN 不进窗口;levels 规则总是判', () => {
    const rising = Array.from({ length: 400 }, (_, i) => ({ time: day(i), value: 100 + i }));
    expect(ruleDays(pctlRule, [...rising, { time: day(400), value: Number.NaN }], 1)[0].time).toBe(day(399));
    const levelRule: AlertRule = { ...pctlRule, percentile: undefined, levels: [{ price: 4, title: '临界' }] };
    expect(ruleDays(levelRule, [{ time: day(0), value: 5 }], 1)).toEqual([
      { time: day(0), value: 5, zone: 1, judged: true },
    ]);
  });

  test('切点与默认滞后:分位 P5 / P95、退 5 个分位点;两切点的常态在中间', () => {
    expect(ruleGeometry(pctlRule)).toEqual({ cuts: [5, 95], pad: 5, neutral: 1 });
    expect(
      ruleGeometry({ ...pctlRule, percentile: undefined, levels: [{ price: 4, title: '临界' }], exitPad: 0.5 }),
    ).toEqual({ cuts: [4], pad: 0.5, neutral: 0 });
  });
});
