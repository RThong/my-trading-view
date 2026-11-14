import { describe, expect, it } from 'bun:test';
import { onTheRun5y, parseDtccTrades } from './dtccCds';
import { cdsPriceToSpreadBp, JPY_CDS } from '../analytics/rateCurves';

const COLS = [
  'Dissemination Identifier',
  'Original Dissemination Identifier',
  'Action type',
  'Event type',
  'Execution Timestamp',
  'Expiration Date',
  'Notional amount-Leg 1',
  'Notional currency-Leg 1',
  'Fixed rate-Leg 1',
  'Other payment type',
  'Other payment amount',
  'Underlier ID-Leg 1',
  'UPI FISN',
  'UPI Underlier Name',
  'Underlying Asset Name',
];
function q(fs: string[]) {
  return `"${fs.join('","')}"`;
}
function row(o: Partial<Record<string, string>>) {
  return q(
    COLS.map(
      (c) =>
        o[c] ??
        {
          'Dissemination Identifier': '1',
          'Original Dissemination Identifier': '',
          'Action type': 'NEWT',
          'Event type': 'TRAD',
          'Execution Timestamp': '2026-11-12T00:34:29Z',
          'Expiration Date': '2031-12-20',
          'Notional amount-Leg 1': '500,000,000',
          'Notional currency-Leg 1': 'JPY',
          'Fixed rate-Leg 1': '0.01',
          'Other payment type': 'UFRO',
          'Other payment amount': '74503485.00000',
          'Underlier ID-Leg 1': 'JQCEFX',
          'UPI FISN': 'NA/CDS Corp SN Sr',
          'UPI Underlier Name': 'BOND',
          'Underlying Asset Name': 'SoftBank Group Corp.',
        }[c]!,
    ),
  );
}

describe('onTheRun5y', () => {
  it('按 3/20、9/20 换新', () => {
    expect(onTheRun5y('2026-03-19')).toBe('2030-12-20');
    expect(onTheRun5y('2026-03-20')).toBe('2031-06-20');
    expect(onTheRun5y('2026-09-19')).toBe('2031-06-20');
    expect(onTheRun5y('2026-09-20')).toBe('2031-12-20');
    expect(onTheRun5y('2026-11-12')).toBe('2031-12-20');
  });
});

describe('parseDtccTrades', () => {
  it('软银:前端费 / 名义本金 → u(%),并剔除各类干扰行(真实样本的字段形态)', () => {
    const csv = [
      q(COLS),
      row({}),
      // 截上限的名义本金带 `+`;另一种标识(ISIN)也认
      row({
        'Notional amount-Leg 1': '793,675,990+',
        'Other payment amount': '118263852.74328',
        'Underlier ID-Leg 1': 'JP343610ANC5',
      }),
      // 干扰:更替 / 压缩(前端费是转让结算款) / 生命周期事件 / 美元计价 / 非 on-the-run 到期 / 无前端费 / 前端费 0 / 软银电信(另一家公司)
      row({ 'Event type': 'NOVA' }),
      row({ 'Event type': 'COMP' }),
      row({ 'Action type': 'MODI' }),
      // 撤销行:不论哪家公司,它指向的原成交 ID 都收进 cancelled
      row({
        'Action type': 'EROR',
        'Event type': '',
        'Original Dissemination Identifier': '99',
        'Underlier ID-Leg 1': 'X',
      }),
      row({ 'Notional currency-Leg 1': 'USD' }),
      row({ 'Expiration Date': '2031-06-20' }),
      row({ 'Other payment type': '' }),
      row({ 'Other payment amount': '0.00000' }),
      row({ 'Underlier ID-Leg 1': 'JQCFGG', 'Underlying Asset Name': 'SoftBank Corp.' }),
      '',
    ].join('\r\n');

    const { trades, cancelled } = parseDtccTrades(csv);
    expect(cancelled).toEqual(['99']);
    expect(trades.map((t) => [t.ticker, t.date])).toEqual([
      ['SBG', '2026-11-12'],
      ['SBG', '2026-11-12'],
    ]);
    expect(trades[0].u).toBeCloseTo(14.9007, 3);
    expect(trades[1].u).toBeCloseTo(14.9008, 3);
  });

  it('美国公司:按 RED / ISIN 发行人前缀或名字认;币种 / 票息档 / 优先级不对的不收', () => {
    const us = (o: Partial<Record<string, string>>) =>
      row({
        'Notional currency-Leg 1': 'USD',
        'Notional amount-Leg 1': '5,000,000+',
        'Other payment amount': '394720.31000',
        'UPI Underlier Name': 'NT',
        'Underlying Asset Name': '',
        ...o,
      });
    const csv = [
      q(COLS),
      // Oracle:RED 码,名字字段只是债券描述
      us({ 'Dissemination Identifier': 'o', 'Underlier ID-Leg 1': '6EC42L' }),
      // Microsoft:债券 ISIN
      us({
        'Dissemination Identifier': 'm',
        'Underlier ID-Leg 1': 'US594918BC73',
        'Other payment amount': '150000.00000',
      }),
      // 通用标准参考债,只能靠名字认
      us({
        'Dissemination Identifier': 'n',
        'Other payment amount': '100000.00000',
        'Underlier ID-Leg 1': 'XSSNRREFOBL0',
        'UPI Underlier Name': 'NVIDIA CORPORATION',
      }),
      // 干扰(每行前端费各不相同,免得被当成指数拆出来的成分腿):Intelsat(别被 INTEL 撞上)/ CoreWeave 挂 100bp(它只有 500bp 档)/ 次级 / Apple(不回填)
      us({ 'Underlier ID-Leg 1': 'X', 'Underlying Asset Name': 'INTELSAT S.A.', 'Other payment amount': '1.00000' }),
      us({ 'Underlier ID-Leg 1': '239FAV', 'Other payment amount': '2.00000' }),
      us({ 'Underlier ID-Leg 1': '6EC42L', 'UPI FISN': 'NA/CDS Corp SN Sub', 'Other payment amount': '3.00000' }),
      us({ 'Underlier ID-Leg 1': '03AFCJ', 'Other payment amount': '4.00000' }),
      '',
    ].join('\n');

    const { trades } = parseDtccTrades(csv);
    expect(trades.map((t) => [t.id, t.ticker])).toEqual([
      ['o', 'ORCLE'],
      ['m', 'MSFT'],
      ['n', 'NVIDIA'],
    ]);
    expect(trades[0].u).toBeCloseTo(7.8944, 3);
  });

  it('指数成交拆成的成分腿(同一秒同本金同前端费、横跨 ≥3 家发行人,通用标识按名字分)整批剔掉;同一家的重复行保留', () => {
    const leg = (id: string, issuer: string, dup = '') =>
      row({
        'Dissemination Identifier': id + dup,
        'Notional currency-Leg 1': 'USD',
        'Notional amount-Leg 1': '2,000,000',
        'Other payment amount': '41938.00000',
        'Underlier ID-Leg 1': issuer,
        'UPI Underlier Name': 'NT',
        'Underlying Asset Name': '',
      });
    const csv = [
      q(COLS),
      // 一篮子:Oracle 混在别家中间
      leg('b1', '6EC42L'),
      leg('b2', '5F07CP'),
      leg('b3', '4E477P'),
      // 另一个时间点:Amazon 同价报了两次(分配给两个账户),只有一家 → 是真成交
      ...['a1', 'a2'].map((id) => leg(id, '0C5448').replace('2026-11-12T00:34:29Z', '2026-11-12T15:00:00Z')),
      // 另一篮子:标识全是通用参考债,只能按名字分出是不同发行人(Oracle 也混在里面)
      ...['ORACLE CORP', 'AUTOZONE INC', 'AVNET INC'].map((name, i) =>
        row({
          'Dissemination Identifier': `g${i}`,
          'Execution Timestamp': '2026-11-12T19:03:17Z',
          'Notional currency-Leg 1': 'USD',
          'Notional amount-Leg 1': '4,000,000',
          'Other payment amount': '82530.03000',
          'Underlier ID-Leg 1': 'XSSNRREFOBL0',
          'UPI Underlier Name': 'NT',
          'Underlying Asset Name': name,
        }),
      ),
      '',
    ].join('\n');

    expect(parseDtccTrades(csv).trades.map((t) => [t.id, t.ticker])).toEqual([
      ['a1', 'AMZN'],
      ['a2', 'AMZN'],
    ]);
  });

  it('旧版(2025-11 前)表头不带引号也认', () => {
    expect(parseDtccTrades([COLS.join(','), row({})].join('\n')).trades).toHaveLength(1);
  });

  it('表头缺列 → 抛错(改版要响亮)', () => {
    expect(() => parseDtccTrades(q(['Action type']))).toThrow('缺列');
  });
});

describe('日元口径换算', () => {
  it('前端费 14.9%(100bp 票息)约合 470bp;日元利率低 → 风险久期长 → 比按美元参数换算低约 25bp', () => {
    const jpy = cdsPriceToSpreadBp(85.1, 100, JPY_CDS);
    const usd = cdsPriceToSpreadBp(85.1);
    expect(jpy).toBeCloseTo(472, 0);
    expect(usd - jpy).toBeGreaterThan(15);
    expect(usd - jpy).toBeLessThan(40);
  });
});
