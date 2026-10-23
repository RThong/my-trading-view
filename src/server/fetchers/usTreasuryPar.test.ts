import { describe, expect, it } from 'bun:test';
import { parseTreasuryPar, fetchTreasuryCurve, fetchTreasuryRealCurve } from './usTreasuryPar';

// 新版(含 1.5 Month / 4 Mo 额外档)——按表头名定位,忽略额外档。
const CSV_NEW = `Date,"1 Mo","1.5 Month","2 Mo","3 Mo","4 Mo","6 Mo","1 Yr","2 Yr","3 Yr","5 Yr","7 Yr","10 Yr","20 Yr","30 Yr"
07/29/2026,3.73,3.80,3.83,3.83,3.91,3.97,4.04,4.22,4.29,4.37,4.51,4.67,5.21,5.20
07/28/2026,3.76,3.86,3.90,3.90,4.02,4.07,4.09,4.26,4.31,4.35,4.47,4.61,5.11,5.09`;

// 旧版(2018:无 1.5 Month / 4 Mo,列集不同)——同一套表头映射照样对齐。
const CSV_OLD = `Date,"1 Mo","2 Mo","3 Mo","6 Mo","1 Yr","2 Yr","3 Yr","5 Yr","7 Yr","10 Yr","20 Yr","30 Yr"
12/31/2018,2.44,2.45,2.45,2.56,2.63,2.48,2.46,2.51,2.59,2.69,2.87,3.02`;

// TIPS 实际收益率表:只有 5 档,表头全大写「5 YR」(与名义表的「5 Yr」不同)。
const CSV_REAL = `Date,"5 YR","7 YR","10 YR","20 YR","30 YR"
10/22/2026,2.33,2.48,2.64,2.91,3.05
10/21/2026,2.55,2.65,2.76,3.01,3.15`;

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

// 注入 fetch:按 URL 里的年份回 CSV。csvByYear 指定的年份回指定内容,failYears 回 500,
// 其余年份回 defaultCsv(year)(每年一行占位数据 —— 往年空表现在算失败,见 fetchCurve)。
const yearOf = (url: string) => url.match(/daily-treasury-rates\.csv\/(\d{4})\//)?.[1] ?? '';
const fakeFetch =
  (defaultCsv: (year: string) => string, csvByYear: Record<string, string> = {}, failYears: string[] = []) =>
  (url: string) => {
    const year = yearOf(url);
    const res = failYears.includes(year)
      ? new Response('nope', { status: 500 })
      : new Response(csvByYear[year] ?? defaultCsv(year), { status: 200 });
    return Promise.resolve(res) as Promise<Response>;
  };

// 占位值取 1 / 9,断言时据此滤掉,只看测试指定的那几行
const nominalRow = (year: string) => `${CSV_OLD.split('\n')[0]}\n01/02/${year},${Array(12).fill(1).join(',')}`;

// 验「跨年合并后按日期升序」(源 CSV 本身是倒序)+「任一年失败即整体抛」(不让缺段结果冒充齐全)。
describe('fetchTreasuryCurve(年度聚合 / 失败)', () => {
  const fake = (csvByYear: Record<string, string> = {}, failYears: string[] = []) =>
    fakeFetch(nominalRow, csvByYear, failYears);

  it('各年合并且按日期升序', async () => {
    const out = await fetchTreasuryCurve(fake({ '2018': CSV_OLD, '2026': CSV_NEW }));
    const dates = out['10Y'].map((p) => p.date);

    // 2018(1 天)+ 2026(2 天)跨年合并且升序 —— 源 CSV 内是倒序,故这里能证明排过
    expect(out['10Y'].filter((p) => p.value !== 1)).toEqual([
      { date: '2018-12-31', value: 2.69 },
      { date: '2026-07-28', value: 4.61 },
      { date: '2026-07-29', value: 4.67 },
    ]);
    expect(dates).toEqual(dates.toSorted());
  });

  it('任一年失败 → 整体抛(缺一段的结果不能当完整结果被缓存)', async () => {
    await expect(fetchTreasuryCurve(fake({}, ['2026']))).rejects.toThrow('UST 2026');
  });

  it('往年 200 + 空 body → 整体抛', async () => {
    await expect(fetchTreasuryCurve(fake({ '2019': '' }))).rejects.toThrow('UST 2019');
  });

  it('1 月上旬今年 200 + 空 body(尚无交易日)→ 正常,只是今年没有点', async () => {
    const out = await fetchTreasuryCurve(fake({ '2027': '' }), new Date('2027-01-05T00:00:00Z'));

    expect(out['10Y'].some((p) => p.date.startsWith('2027'))).toBe(false);
    expect(out['10Y'].length).toBeGreaterThan(0);
  });

  it('1 月上旬以外今年 200 + 空 body → 整体抛(年中抖一下不能丢掉今年整段)', async () => {
    await expect(fetchTreasuryCurve(fake({ '2027': '' }), new Date('2027-03-02T00:00:00Z'))).rejects.toThrow(
      'UST 2027',
    );
  });

  it('HTML 错误页(一档都解析不出)→ 整体抛', async () => {
    await expect(fetchTreasuryCurve(fake({ '2020': '<html>maintenance</html>' }))).rejects.toThrow('UST 2020: 无数据');
  });

  it('单档表头改名 → 只缺那一档,不拖垮整条曲线', async () => {
    const renamed = `${CSV_OLD.split('\n')[0].replace('"1 Mo"', '"1 Month"')}\n01/02/2020,${Array(12).fill(1).join(',')}`;
    const out = await fetchTreasuryCurve(fake({ '2020': renamed }));

    expect(out['1M'].some((p) => p.date.startsWith('2020'))).toBe(false);
    expect(out['10Y'].some((p) => p.date.startsWith('2020'))).toBe(true);
  });
});

describe('fetchTreasuryRealCurve(TIPS 实际收益率)', () => {
  const realRow = (year: string) => `${CSV_REAL.split('\n')[0]}\n01/02/${year},9,9,9,9,9`;
  // 非 real 表的请求回 500:证明拉的是 real 表
  const fake = (url: string) =>
    url.includes('type=daily_treasury_real_yield_curve&')
      ? fakeFetch(realRow, { '2026': CSV_REAL })(url)
      : (Promise.resolve(new Response('nope', { status: 500 })) as Promise<Response>);

  it('按大写表头取 real 表的 5 档,升序', async () => {
    const out = await fetchTreasuryRealCurve(fake);

    expect(Object.keys(out).sort()).toEqual(['10Y', '20Y', '30Y', '5Y', '7Y']);
    expect(out['10Y'].filter((p) => p.value !== 9)).toEqual([
      { date: '2026-10-21', value: 2.76 },
      { date: '2026-10-22', value: 2.64 },
    ]);
  });
});
