import { describe, expect, test } from 'bun:test';
import { betaLegs, depositBeta, jpBankSpreads, monthlyMean } from './jpBanks';

const m = (date: string, value: number) => ({ date, value });

describe('monthlyMean', () => {
  test('按月分组,记当月 1 日', () => {
    const daily = [m('2026-08-28', 0.977), m('2026-09-01', 0.976), m('2026-09-18', 0.978)];
    expect(monthlyMean(daily).map((p) => [p.date, +p.value.toFixed(3)])).toEqual([
      ['2026-08-01', 0.977],
      ['2026-09-01', 0.977],
    ]);
  });
});

describe('depositBeta', () => {
  // 实测值:普通存款 DLDR121N、无担保隔夜拆借月均(STRDCLUCON)。
  const deposit = [m('2024-01-01', 0.001), m('2024-09-01', 0.091), m('2025-04-01', 0.182), m('2026-09-01', 0.322)];
  const policy = [m('2024-01-01', -0.014), m('2024-09-01', 0.227), m('2025-04-01', 0.477), m('2026-09-01', 0.977)];

  test('2026-09 自检:(0.322 − 0.001) / (0.977 + 0.014) ≈ 0.324', () => {
    expect(depositBeta(deposit, policy).at(-1)!.value).toBeCloseTo(0.324, 3);
  });

  test('政策利率累计变动 < 0.25 的月份不出点(2024-09 只动了 0.241)', () => {
    expect(depositBeta(deposit, policy).map((p) => p.date)).toEqual(['2025-04-01', '2026-09-01']);
  });

  test('任务书口径(基准用政策利率 −0.1)得 ≈ 0.29', () => {
    const target = [m('2024-01-01', -0.1), m('2026-09-01', 1.0)];
    expect(depositBeta(deposit, target).at(-1)!.value).toBeCloseTo(0.292, 3);
  });

  test('基准月缺腿 → 空', () => {
    expect(depositBeta(deposit.slice(1), policy)).toEqual([]);
  });
});

describe('jpBankSpreads', () => {
  const r3 = (rows: { date: string; value: number }[]) => rows.map((p) => [p.date, +p.value.toFixed(3)]);
  const deposit = [m('2026-08-01', 0.306), m('2026-09-01', 0.322)];
  const callDaily = [m('2026-08-29', 0.977), m('2026-09-01', 0.976), m('2026-09-24', 1.226)];
  const jgb2y = [m('2026-07-31', 1.4), m('2026-08-31', 1.5), m('2026-09-24', 1.912), m('2026-10-01', 1.95)];
  const out = jpBankSpreads({ deposit, loanStock: [m('2026-08-01', 1.49)], jgb2y, callDaily });

  test('存款按月前向填充:10 月未发布时沿用 9 月;存款起点之前不出点', () => {
    expect(r3(out.jgb2yDeposit)).toEqual([
      ['2026-08-31', 1.194],
      ['2026-09-24', 1.59],
      ['2026-10-01', 1.628],
    ]);
  });

  test('分解逐点相加 = 主线(同一天同一组取值)', () => {
    out.jgb2yDeposit.forEach((p, i) => {
      expect(out.callDeposit[i].value + out.jgb2yCall[i].value).toBeCloseTo(p.value, 12);
    });
    expect(r3(out.callDeposit)).toEqual([
      ['2026-08-31', 0.671],
      ['2026-09-24', 0.904],
      ['2026-10-01', 0.904],
    ]);
  });

  test('存贷利差按月 inner join', () => {
    expect(r3(out.loanDeposit)).toEqual([['2026-08-01', 1.184]]);
  });
});

describe('betaLegs', () => {
  test('基准月起累计变动,基准月 = 0;拆借线乘 0.6', () => {
    const deposit = [m('2023-12-01', 0.001), m('2024-01-01', 0.001), m('2026-09-01', 0.322)];
    const call = [m('2024-01-01', -0.014), m('2026-09-01', 0.977)];
    const { depositDelta, callDelta60 } = betaLegs(deposit, call);

    expect(depositDelta.map((p) => [p.date, +p.value.toFixed(3)])).toEqual([
      ['2024-01-01', 0],
      ['2026-09-01', 0.321],
    ]);
    expect(callDelta60.map((p) => [p.date, +p.value.toFixed(3)])).toEqual([
      ['2024-01-01', 0],
      ['2026-09-01', 0.595],
    ]);
  });

  test('基准月缺腿 → 两条都空', () => {
    expect(betaLegs([m('2026-09-01', 0.322)], [m('2026-09-01', 0.977)])).toEqual({ depositDelta: [], callDelta60: [] });
  });
});
