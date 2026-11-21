import { describe, expect, it } from 'bun:test';
import {
  cliffSeries,
  skewCollapse,
  stressPeak,
  stressSeries,
  stressScore,
  flushSeries,
  recentFlush,
  LEVEL_RULES,
  dimScore,
  metricLevel,
  currentRun,
  escalateOn,
  escalateSeries,
  pauseChecklist,
  pauseChecklistAt,
  pctlAt,
  pctlOf,
  riskChecklist,
  riskChecklistAt,
  stageAt,
  stageOf,
  stageSeries,
} from './stampede';

const base = { vix: 20, vixVix3m: 0.9, vvix: 100, skew: 150, vixeqVix: 2.2 };

// 连续日历日的序列(分位窗口按日期回看 5 年,日历日足够)
function daily(values: number[], start = '2020-01-01') {
  const t0 = Date.parse(start);
  return values.map((value, i) => ({ date: new Date(t0 + i * 86_400_000).toISOString().slice(0, 10), value }));
}

describe('stageOf', () => {
  it('优先级 三 → 一 → 四 → 二', () => {
    expect(stageOf({ ...base, vix: 26, vixVix3m: 1 })).toBe(3);
    expect(stageOf({ ...base, vix: 30, vixVix3m: 0.9, vvix: 110 })).toBe(3);
    expect(stageOf({ ...base, vix: 17.9, skew: 157 })).toBe(1);
    // 同时满足四的条件,一优先
    expect(stageOf({ ...base, vix: 17, skew: 150, vixeqVix: 1.5 })).toBe(1);
    expect(stageOf({ ...base, vix: 22, vixeqVix: 1.9 })).toBe(4);
    expect(stageOf({ ...base, vix: 22 })).toBe(2);
  });

  it('验收:2026-11-20 判阶段三', () => {
    expect(stageOf({ vix: 35.89, vixVix3m: 1.16, vvix: 138.03, skew: 140, vixeqVix: 1.5 })).toBe(3);
  });
});

describe('stageSeries', () => {
  it('五条缺任一条的日子不判', () => {
    const s = {
      vix: [
        { date: 'a', value: 30 },
        { date: 'b', value: 30 },
      ],
      vixVix3m: [
        { date: 'a', value: 1.1 },
        { date: 'b', value: 1.1 },
      ],
      vvix: [{ date: 'a', value: 120 }],
      skew: [
        { date: 'a', value: 140 },
        { date: 'b', value: 140 },
      ],
      vixeqVix: [
        { date: 'a', value: 1.5 },
        { date: 'b', value: 1.5 },
      ],
    };
    expect(stageSeries(s)).toEqual([{ date: 'a', stage: 3 }]);
  });
});

describe('pctlAt', () => {
  it('只看当天之前、不足 252 个观测给 NaN', () => {
    const rows = daily(Array.from({ length: 300 }, (_, i) => i));
    expect(pctlAt(rows, 251)).toBeNaN();
    // 前面 252 个都更小 → 100
    expect(pctlAt(rows, 252)).toBe(100);
  });

  it('窗口只回看 5 年', () => {
    // 头一年全是大值,之后 5 年多都是小值:到第 6 年末,大值已滑出窗口
    const rows = daily([...Array(366).fill(100), ...Array(5 * 366).fill(1), 50]);
    expect(pctlAt(rows, rows.length - 1)).toBe(100);
  });
});

describe('pctlAt 边界', () => {
  it('恰好 5 年前那天算进窗口', () => {
    const rows = [
      { date: '2020-03-01', value: 100 },
      ...daily(Array(300).fill(1), '2024-01-01'),
      { date: '2025-03-01', value: 50 },
    ];
    // 窗口 = 300 个 1 + 5 年前那个 100 → 50 排在 300/301
    expect(pctlAt(rows, rows.length - 1)).toBeCloseTo((300 / 301) * 100, 6);
  });
});

describe('交割后 GEX 回升(暂歇第 1 项)', () => {
  // 2026-11 的月度交割是 11-20(周五):基准要取 11-19,不是交割日当天
  const history = daily(
    Array.from({ length: 400 }, (_, i) => i % 10),
    '2025-10-14',
  );
  const gex = [
    ...history.filter((p) => p.date < '2026-11-19'),
    { date: '2026-11-19', value: 0 },
    { date: '2026-11-20', value: 100 },
    { date: '2026-11-23', value: 100 },
  ];

  it('基准取交割前最后一个交易日', () => {
    expect(pauseChecklist({ gex })[0].on).toBe(true);
  });

  it('交割日休市(提前一天交割)时,基准再往前退一天', () => {
    // 11-20 没有点:11-19 是实际交割日,基准取 11-18(低)而不是 11-19(高)→ 回升够 20pp
    const shifted = [
      ...history.filter((p) => p.date < '2026-11-18'),
      { date: '2026-11-18', value: 0 },
      { date: '2026-11-19', value: 100 },
      { date: '2026-11-23', value: 100 },
    ];
    expect(pauseChecklist({ gex: shifted })[0].on).toBe(true);
  });

  it('当天就是交割日 → 不在窗口', () => {
    expect(pauseChecklist({ gex: gex.slice(0, -1) })[0].on).toBe(false);
  });
});

describe('cliffSeries', () => {
  it('前 20 日分位冲到高位、当日跌回中位以下才亮', () => {
    // 300 天在 1~2 之间来回,再连冲高 5 天,随后跌回 1
    const calm = Array.from({ length: 300 }, (_, i) => 1 + (i % 2));
    const rows = daily([...calm, 5, 5, 5, 5, 5, 1]);
    const marks = cliffSeries(rows);
    expect(marks.at(-1)?.value).toBe(1);
    expect(marks.at(-2)?.value).toBe(0);
  });
});

describe('currentRun', () => {
  it('末尾连续同阶段的天数与起点', () => {
    const r = currentRun([
      { date: 'a', stage: 2 },
      { date: 'b', stage: 3 },
      { date: 'c', stage: 3 },
    ]);
    expect(r).toEqual({ date: 'c', stage: 3, days: 2, since: 'b' });
  });
});

describe('清单', () => {
  it('各项在自己最近有数据的那天判,没数据给 null', () => {
    const s = {
      vix: [{ date: '2026-11-20', value: 35.89 }],
      vixVix3m: [{ date: '2026-11-20', value: 1.16 }],
      vvix: [{ date: '2026-11-20', value: 138.03 }],
      pcIndex: [{ date: '2026-11-19', value: 1.2 }],
    };
    const risk = riskChecklist(s);
    expect(risk.map((x) => x.on)).toEqual([null, false, null, true]);
    expect(risk[1].date).toBe('2026-11-19');

    const pause = pauseChecklist(s);
    expect(pause[1].on).toBe(false); // VVIX 138 ≥ 110
  });
});

describe('pctlOf', () => {
  it('任意值在最近 5 年(含最后一天)里的分位,观测不足给 NaN', () => {
    const rows = daily(Array.from({ length: 300 }, (_, i) => i));
    // 0~299 里比 150 小的 150 个、相等 1 个 → (150 + 0.5) / 300
    expect(pctlOf(rows, 150)).toBeCloseTo((150.5 / 300) * 100, 6);
    expect(pctlOf(rows, 1000)).toBe(100);
    expect(pctlOf(rows, -1)).toBe(0);
    expect(pctlOf(rows.slice(0, 251), 10)).toBeNaN();
    expect(pctlOf([], 10)).toBeNaN();
  });

  it('只看最后一天往回 5 年', () => {
    const rows = daily([...Array(366).fill(100), ...Array(5 * 366).fill(1)]);
    expect(pctlOf(rows, 50)).toBe(100);
  });
});

describe('快照判定(情景模板)', () => {
  // 付鹏原页 SCENARIOS 的阶段三升级模板
  const stage3 = {
    vixeqVix: 1.35,
    vix: 35.8,
    vvix: 142,
    vixVix3m: 1.14,
    vix9dVix: 1.11,
    skew: 132,
    pcEquity: 0.88,
    pcTotal: 1.34,
    pcIndex: 1.42,
  };

  it('stageAt 缺输入给 null', () => {
    expect(stageAt(stage3)).toBe(3);
    expect(stageAt({ ...stage3, vvix: Number.NaN })).toBeNull();
    expect(stageAt({ vix: 14 })).toBeNull();
  });

  it('风险清单:同一组谓词,GEX 项按给定分位判', () => {
    expect(riskChecklistAt(stage3, 3).map((x) => x.on)).toEqual([true, true, true, true]);
    expect(riskChecklistAt({ vix: 35.8 }, Number.NaN).map((x) => x.on)).toEqual([null, null, null, null]);
    expect(escalateOn(stage3)).toBe(true);
  });

  it('暂歇清单:第 1 项不适用并注明,其余照判', () => {
    const items = pauseChecklistAt({ ...stage3, vvix: 101, vixVix3m: 0.96, vix9dVix: 0.94, vixeqVix: 1.72, vix: 22.6 });
    expect(items[0].on).toBeNull();
    expect(items[0].na).toBeTruthy();
    expect(items.slice(1).map((x) => x.on)).toEqual([true, true, true]);
  });

  it('实盘与快照对同一天的值判出相同结果', () => {
    const s = Object.fromEntries(Object.entries(stage3).map(([k, v]) => [k, [{ date: '2026-11-20', value: v }]]));
    expect(riskChecklist(s).map((x) => x.on)).toEqual(riskChecklistAt(stage3, Number.NaN).map((x) => x.on));
    expect(
      pauseChecklist(s)
        .slice(1)
        .map((x) => x.on),
    ).toEqual(
      pauseChecklistAt(stage3)
        .slice(1)
        .map((x) => x.on),
    );
    expect(escalateSeries(s)).toEqual([{ date: '2026-11-20', value: 1 }]);
  });
});

describe('维度分', () => {
  it('只按有数据的指标求平均(用户定),全缺给 NaN', () => {
    expect(dimScore(['red', 'yellow', null])).toBe(50);
    expect(dimScore(['red', undefined])).toBe(100);
    expect(dimScore([undefined, undefined])).toBeNaN();
  });

  it('要看 VIX 的线在 VIX 缺时算无数据;按分位判的在分位缺时算无数据', () => {
    const vixRule = { needsVix: true as const, level: () => 'yellow' as const };
    expect(metricLevel(vixRule, 30, 50, NaN)).toBeUndefined();
    expect(metricLevel(vixRule, 30, 50, 20)).toBe('yellow');

    const pctlRule = {
      byPctl: true as const,
      level: (_v: number, _x: number, p: number) => (p <= 5 ? ('red' as const) : null),
    };
    expect(metricLevel(pctlRule, NaN, NaN, 20)).toBeUndefined();
    expect(metricLevel(pctlRule, NaN, 3, 20)).toBe('red');
  });
});

describe('付鹏黄 / 红线边界', () => {
  const lv = (k: keyof typeof LEVEL_RULES, v: number, vix = 20, pctl = 50) => LEVEL_RULES[k].level(v, vix, pctl);

  it('期限比值红线严格 > 1、黄线 ≥ 0.95', () => {
    expect(lv('vixVix3m', 1)).toBe('yellow');
    expect(lv('vixVix3m', 1.0001)).toBe('red');
    expect(lv('vix9dVix', 0.95)).toBe('yellow');
    expect(lv('vix9dVix', 0.9499)).toBeNull();
  });

  it('VIX / VVIX / P/C 红黄线含等号', () => {
    expect(lv('vix', 28)).toBe('red');
    expect(lv('vix', 20)).toBe('yellow');
    expect(lv('vvix', 115)).toBe('red');
    expect(lv('pcEquity', 0.8)).toBe('red');
    expect(lv('pcTotal', 1)).toBe('yellow');
    expect(lv('pcIndex', 1.12)).toBe('yellow');
  });

  it('VIXEQ/VIX 与 DSPX 是低于线才亮;DSPX 红线还要 VIX > 25', () => {
    expect(lv('vixeqVix', 1.84)).toBe('red');
    expect(lv('vixeqVix', 2.15)).toBeNull();
    expect(lv('dspx', 34, 25)).toBe('yellow');
    expect(lv('dspx', 34, 25.1)).toBe('red');
  });

  it('SKEW:VIX ≥ 25 时 < 150 红,≥ 160 黄', () => {
    expect(lv('skew', 149, 25)).toBe('red');
    expect(lv('skew', 149, 24.9)).toBeNull();
    expect(lv('skew', 160)).toBe('yellow');
  });

  it('GEX 按分位:≤ 5 红、≤ 20 黄', () => {
    expect(lv('gex', NaN, 20, 5)).toBe('red');
    expect(lv('gex', NaN, 20, 20)).toBe('yellow');
    expect(lv('gex', NaN, 20, 20.1)).toBeNull();
  });
});

describe('出清(试行)', () => {
  const dates = Array.from({ length: 80 }, (_, i) => new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10));
  const series = (f: (i: number) => number) => dates.map((date, i) => ({ date, value: f(i) }));

  it('SKEW 坍塌 + VIX ≥ 25 + 两个板块 10 日都跌 ≥3% 才亮', () => {
    const s = { skew: series((i) => (i === 40 ? 170 : i > 70 ? 140 : 150)), vix: series((i) => (i > 70 ? 30 : 15)) };
    const xlp = series((i) => (i > 70 ? 95 : 100));
    const xlk = series((i) => (i > 70 ? 90 : 100));
    const f = flushSeries(s, xlp, xlk);
    expect(f.at(-1)?.value).toBe(1);
    expect(recentFlush(f)).toBe(dates.at(-1) ?? null);
    // 防御板块没跌 → 不亮(还在高切低,不是通杀)
    expect(
      flushSeries(
        s,
        series(() => 100),
        xlk,
      ).at(-1)?.value,
    ).toBe(0);
  });
});

describe('综合压力分(方案 A)', () => {
  it('满压 = 100、全平静 = 0;GEX 分位 P50 以上不加分', () => {
    const calm = {
      vix: 12,
      vvix: 80,
      vixVix3m: 0.8,
      vix9dVix: 0.8,
      vixeqVix: 2.6,
      pcEquity: 0.4,
      pcTotal: 0.7,
      pcIndex: 0.9,
      gexPctl: 80,
    };
    const storm = {
      vix: 40,
      vvix: 150,
      vixVix3m: 1.2,
      vix9dVix: 1.2,
      vixeqVix: 1.2,
      pcEquity: 1,
      pcTotal: 1.5,
      pcIndex: 1.5,
      gexPctl: 2,
    };
    expect(stressScore(calm)).toEqual({ total: 0, missing: 0 });
    expect(stressScore(storm)).toEqual({ total: 100, missing: 0 });
    // VIX 一项拉满 = 15 × 88/70 ≈ 18.9
    expect(stressScore({ ...calm, vix: 36 }).total).toBe(19);
  });

  it('缺数的项不计分并报缺几项', () => {
    expect(stressScore({ vix: 36 })).toEqual({ total: 19, missing: 8 });
    expect(stressScore({}).total).toBeNaN();
  });
});

describe('stressSeries', () => {
  it('P/C 晚一天也能接上(5 日内取最近值);缺项太久的日子不出点', () => {
    const one = (date: string, value: number) => [{ date, value }];
    const s = {
      vix: [...one('2026-11-19', 36), { date: '2026-11-20', value: 36 }],
      vvix: [...one('2026-11-19', 135), { date: '2026-11-20', value: 135 }],
      vixVix3m: [...one('2026-11-19', 1.12), { date: '2026-11-20', value: 1.12 }],
      vix9dVix: [...one('2026-11-19', 1.12), { date: '2026-11-20', value: 1.12 }],
      vixeqVix: [...one('2026-11-19', 1.35), { date: '2026-11-20', value: 1.35 }],
      pcEquity: one('2026-11-19', 0.9),
      pcTotal: one('2026-11-19', 1.35),
      pcIndex: one('2026-11-10', 1.4), // 太旧 → 那两天都不出点
    };
    expect(stressSeries(s, one('2026-11-19', 2))).toEqual([]);
    const fresh = { ...s, pcIndex: one('2026-11-19', 1.4) };
    expect(stressSeries(fresh, one('2026-11-19', 2))).toEqual([
      { date: '2026-11-19', value: 100 },
      { date: '2026-11-20', value: 100 },
    ]);
  });
});

describe('stressPeak', () => {
  it('只看最近 20 个交易日;报峰值、日期与回落', () => {
    const rows = [
      { date: '2020-01-02', value: 120 }, // 窗口外
      ...Array.from({ length: 18 }, (_, i) => ({ date: `2020-02-${String(i + 1).padStart(2, '0')}`, value: 50 })),
      { date: '2020-03-09', value: 100 },
      { date: '2020-03-16', value: 59 },
    ];
    expect(stressPeak(rows)).toEqual({ peak: 100, date: '2020-03-09', now: 59, drop: 41 });
    expect(stressPeak([])).toBeNull();
  });
});

describe('skewCollapse', () => {
  it('较前 60 个交易日高点回落 ≥20 点算坍塌;更早的高点不算', () => {
    const at = (vals: number[]) => vals.map((value, i) => ({ date: `d${String(i).padStart(3, '0')}`, value }));
    expect(skewCollapse(at([150, 168, ...Array(20).fill(150), 140]))).toEqual({ drop: 28, collapsed: true });
    expect(skewCollapse(at([150, 158, 145]))).toEqual({ drop: 13, collapsed: false });
    // 170 在 61 个交易日之前,窗口外
    expect(skewCollapse(at([170, ...Array(60).fill(150), 145]))?.collapsed).toBe(false);
    expect(skewCollapse([])).toBeNull();
  });
});
