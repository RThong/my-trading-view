import { describe, expect, test } from 'bun:test';
import { yyyymmddToIso, yyyyqToIso, parseSeries, parseNakajima } from './nakajimaJgb';

describe('yyyymmddToIso', () => {
  test('正常日', () => expect(yyyymmddToIso('20260630')).toBe('2026-06-30'));
  test('起点', () => expect(yyyymmddToIso('19950104')).toBe('1995-01-04'));
  // 「格式合法但日历上不存在」只有回一趟 Date 才拦得住;不拦就会把 2026-02-30 交给图表。
  test('日历上不存在的日 → null', () => expect(yyyymmddToIso('20260230')).toBeNull());
  test('位数不对 → null', () => expect(yyyymmddToIso('202606')).toBeNull());
});

describe('yyyyqToIso', () => {
  // 5 位不是 6 位:20262 = 2026Q2。按 6 位解会整列读不出。
  test('5 位 → 季末', () => {
    expect(yyyyqToIso('20262')).toBe('2026-06-30');
    expect(yyyyqToIso('19951')).toBe('1995-03-31');
    expect(yyyyqToIso('20254')).toBe('2025-12-31');
  });
  test('季号越界 / 6 位 → null', () => {
    expect(yyyyqToIso('20265')).toBeNull();
    expect(yyyyqToIso('202602')).toBeNull();
  });
});

// rstar.csv 的真实形状:第 1 行是元数据,表头在第 2 行。
const rstarCsv =
  'Data as of 26-07-06,,,,,,\n' +
  'YYYYQ,1Y_Mean,1Y_95%Low,1Y_95%High,10Y_Mean,10Y_95%Low,10Y_95%High\n' +
  '20261,-0.149,-1.009,0.71,0.713,-0.06,1.486\n' +
  '20262,-0.143,-1.009,0.724,0.722,-0.058,1.502\n';
// yield_D.csv:表头带引号,数据行不带。10Y 左右就是 7Y / 15Y,按列号取会静默取到邻列。
const yieldCsv =
  '"YYYYMMDD","ShadowRate","TermPremium-7Y","TermPremium-10Y","TermPremium-15Y","ExpectedRate-10Y"\n' +
  '20260629,0.662,0.7544,0.9504,1.1833,1.6936\n' +
  '20260630,0.6646,0.7822,0.9943,1.2484,1.6957\n';

describe('parseSeries', () => {
  // 硬编码「跳过 1 行」的话,官方多加一行说明就整表错位;按首格找表头则跟着走。
  test('表头不在第一行也能找到', () => {
    const out = parseSeries(rstarCsv, 'YYYYQ', yyyyqToIso, ['10Y_Mean'], '1995-01-01');
    expect(out?.['10Y_Mean']).toEqual([
      { date: '2026-03-31', value: 0.713 },
      { date: '2026-06-30', value: 0.722 },
    ]);
  });

  test('按表头名取列,不会取到邻列(7Y / 15Y)', () => {
    const out = parseSeries(yieldCsv, 'YYYYMMDD', yyyymmddToIso, ['TermPremium-10Y'], '1995-01-01');
    const vals = out?.['TermPremium-10Y'].map((p) => p.value);
    expect(vals).toEqual([0.9504, 0.9943]);
    expect(vals).not.toContain(0.7822); // 7Y
    expect(vals).not.toContain(1.2484); // 15Y
  });

  test('要的列不存在 → null(交给上层抛错,不静默少一条线)', () =>
    expect(parseSeries(yieldCsv, 'YYYYMMDD', yyyymmddToIso, ['TermPremium-30Y'], '1995-01-01')).toBeNull());

  // 列名还在、内容变了(全空)的情形。只校验其中一列的话,这里会静默返回一条空序列 ——
  // 对 r* 的 95% 区间尤其致命:带没了图上只是少两条线,读者不会发现点估计失去了不确定性提示。
  test('目标列存在但整列解析不出 → null(不返回空序列)', () => {
    const blanked = yieldCsv.replace(/,1\.6936/, ',').replace(/,1\.6957/, ',');
    expect(
      parseSeries(blanked, 'YYYYMMDD', yyyymmddToIso, ['TermPremium-10Y', 'ExpectedRate-10Y'], '1995-01-01'),
    ).toBeNull();
  });

  test('找不到表头 → null', () =>
    expect(parseSeries(rstarCsv, 'YYYYMMDD', yyyymmddToIso, ['10Y_Mean'], '1995-01-01')).toBeNull());

  test('since 过滤', () =>
    expect(parseSeries(rstarCsv, 'YYYYQ', yyyyqToIso, ['10Y_Mean'], '2026-04-01')?.['10Y_Mean']).toHaveLength(1));
});

describe('parseNakajima', () => {
  test('五条序列各归各位', () => {
    const out = parseNakajima(yieldCsv, rstarCsv, '1995-01-01');
    expect(out.termPremium10.at(-1)).toEqual({ date: '2026-06-30', value: 0.9943 });
    expect(out.expectedRate10.at(-1)).toEqual({ date: '2026-06-30', value: 1.6957 });
    expect(out.rstar10.at(-1)).toEqual({ date: '2026-06-30', value: 0.722 });
    expect(out.rstar10Lo.at(-1)?.value).toBe(-0.058);
    expect(out.rstar10Hi.at(-1)?.value).toBe(1.502);
  });

  // 只取 10Y 那组:1Y_Mean(−0.143)和 10Y_Mean(0.722)符号都不同,串了会读反。
  test('不会把 1Y 那组当成 10Y', () => {
    const out = parseNakajima(yieldCsv, rstarCsv, '1995-01-01');
    expect(out.rstar10.map((p) => p.value)).not.toContain(-0.143);
  });

  test('任一侧解不出 → 抛错', () => {
    expect(() => parseNakajima('', rstarCsv, '1995-01-01')).toThrow();
    expect(() => parseNakajima(yieldCsv, '', '1995-01-01')).toThrow();
  });

  // 95% 区间整列失效必须和「缺列」同等对待:静默少两条线 = 点估计失去不确定性提示。
  test('95% 区间整列解析不出 → 抛错,不是静默少两条线', () => {
    const noBand = rstarCsv.replace(/,-0\.06,1\.486/, ',,').replace(/,-0\.058,1\.502/, ',,');
    expect(() => parseNakajima(yieldCsv, noBand, '1995-01-01')).toThrow();
  });
});
