import { describe, expect, it } from 'bun:test';
import { parseTreasuryPar, fetchTreasuryCurve } from './usTreasuryPar';

// 新版(含 1.5 Month / 4 Mo 额外档)——按表头名定位,忽略额外档。
const CSV_NEW = `Date,"1 Mo","1.5 Month","2 Mo","3 Mo","4 Mo","6 Mo","1 Yr","2 Yr","3 Yr","5 Yr","7 Yr","10 Yr","20 Yr","30 Yr"
07/29/2026,3.73,3.80,3.83,3.83,3.91,3.97,4.04,4.22,4.29,4.37,4.51,4.67,5.21,5.20
07/28/2026,3.76,3.86,3.90,3.90,4.02,4.07,4.09,4.26,4.31,4.35,4.47,4.61,5.11,5.09`;

// 旧版(2018:无 1.5 Month / 4 Mo,列集不同)——同一套表头映射照样对齐。
const CSV_OLD = `Date,"1 Mo","2 Mo","3 Mo","6 Mo","1 Yr","2 Yr","3 Yr","5 Yr","7 Yr","10 Yr","20 Yr","30 Yr"
12/31/2018,2.44,2.45,2.45,2.56,2.63,2.48,2.46,2.51,2.59,2.69,2.87,3.02`;

describe('parseTreasuryPar', () => {
  it('按表头名取标准 11 档(忽略 1.5Mo/2Mo/4Mo 额外档)', () => {
    const out = parseTreasuryPar(CSV_NEW);
    expect(Object.keys(out).sort()).toEqual(['10Y', '1M', '1Y', '20Y', '2Y', '30Y', '3M', '3Y', '5Y', '6M', '7Y']);
  });

  it('日期 MM/DD/YYYY → YYYY-MM-DD;取对列的值', () => {
    const out = parseTreasuryPar(CSV_NEW);
    expect(out['10Y']).toEqual([
      { date: '2026-07-29', value: 4.67 },
      { date: '2026-07-28', value: 4.61 },
    ]);
    expect(out['1M'][0]).toEqual({ date: '2026-07-29', value: 3.73 });
    expect(out['30Y'][0]).toEqual({ date: '2026-07-29', value: 5.2 });
  });

  it('列集不同的旧年份靠表头名对齐,不错位', () => {
    const out = parseTreasuryPar(CSV_OLD);
    // 2018 无 1.5Mo/4Mo,若靠下标会取错列;靠表头名则 10Y 仍是 2.69
    expect(out['10Y'][0]).toEqual({ date: '2018-12-31', value: 2.69 });
    expect(out['3M'][0]).toEqual({ date: '2018-12-31', value: 2.45 });
    expect(out['2M' as string]).toBeUndefined(); // 2Mo 非目标档,不收
  });
});

// 年度聚合 + 降级:注入 fetch,只让两年成功、其余年份 500。
// 验「单年失败跳过而非整体报错」+「跨年合并后按日期升序」(源 CSV 本身是倒序)。
describe('fetchTreasuryCurve(年度聚合 / 降级)', () => {
  const fake = (okYears: Record<string, string>) => (url: string) => {
    const year = url.match(/daily-treasury-rates\.csv\/(\d{4})\//)?.[1] ?? '';
    const csv = okYears[year];
    return Promise.resolve(
      csv ? new Response(csv, { status: 200 }) : new Response('nope', { status: 500 }),
    ) as Promise<Response>;
  };

  it('失败年份跳过,成功年份照常合并且按日期升序', async () => {
    const out = await fetchTreasuryCurve(fake({ '2018': CSV_OLD, '2026': CSV_NEW }));

    // 2018(1 天)+ 2026(2 天)跨年合并成 3 点,且升序 —— 源 CSV 内是倒序,故这里能证明排过
    expect(out['10Y']).toEqual([
      { date: '2018-12-31', value: 2.69 },
      { date: '2026-07-28', value: 4.61 },
      { date: '2026-07-29', value: 4.67 },
    ]);
  });

  it('全部年份失败 → 空对象,不抛异常', async () => {
    expect(await fetchTreasuryCurve(fake({}))).toEqual({});
  });
});
