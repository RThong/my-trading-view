import { describe, expect, it } from 'bun:test';
import { rollMismatchDates, wtiExpiryByMonth } from './oilRoll';

// 某月的交易日:工作日扣掉给定休市日
const tradingDays = (month: string, holidays: string[] = [], upTo = 31) =>
  Array.from({ length: upTo }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`).filter((d) => {
    const dt = new Date(`${d}T00:00:00Z`);
    return dt.getUTCMonth() + 1 === Number(month.slice(5)) && dt.getUTCDay() % 6 !== 0 && !holidays.includes(d);
  });

describe('wtiExpiryByMonth', () => {
  it('25 号是周日 → 从周五往前数 3 个交易日(2026-10:11 月合约 10-20 到期,10-21 Yahoo 换月实测)', () => {
    expect(wtiExpiryByMonth(tradingDays('2026-10')).get('2026-10')).toBe('2026-10-20');
  });

  it('25 号是周六 → 2020-04 的 5 月合约 04-21 到期(负油价是到期前一天 04-20)', () => {
    expect(wtiExpiryByMonth(tradingDays('2020-04', ['2020-04-10'])).get('2020-04')).toBe('2020-04-21');
  });

  it('25 号休市(圣诞)→ 锚到 24 号,2018-12 到期 12-19', () => {
    expect(wtiExpiryByMonth(tradingDays('2018-12', ['2018-12-05', '2018-12-25'])).get('2018-12')).toBe('2018-12-19');
  });

  it('锚前的休市日要跳过(2018-11 感恩节 22 号)→ 11-19', () => {
    expect(wtiExpiryByMonth(tradingDays('2018-11', ['2018-11-22'])).get('2018-11')).toBe('2018-11-19');
  });

  it('当月数据还没到 25 号 → 用工作日补齐推算,不把月中误判成已到期', () => {
    expect(wtiExpiryByMonth(tradingDays('2026-10', [], 15)).get('2026-10')).toBe('2026-10-20');
  });

  it('往月不补工作日:圣诞休市不会被当成交易日', () => {
    const dates = [...tradingDays('2018-12', ['2018-12-05', '2018-12-25']), ...tradingDays('2019-01', ['2019-01-01'])];
    expect(wtiExpiryByMonth(dates).get('2018-12')).toBe('2018-12-19');
  });
});

describe('rollMismatchDates', () => {
  const oct = tradingDays('2026-10');

  it('裂解:WTI 到期之后到月底错月(WTI 已是 12 月合约,柴油 / 汽油仍是 11 月)', () => {
    expect([...rollMismatchDates(oct, 'crack')]).toEqual([
      '2026-10-21',
      '2026-10-22',
      '2026-10-23',
      '2026-10-26',
      '2026-10-27',
      '2026-10-28',
      '2026-10-29',
      '2026-10-30',
    ]);
  });

  it('Brent−WTI:恰好相反,到期日(含)之前错月,两段合起来覆盖全月', () => {
    const brent = rollMismatchDates(oct, 'brentWti');
    const crack = rollMismatchDates(oct, 'crack');

    expect(brent.has('2026-10-20')).toBe(true);
    expect(brent.has('2026-10-21')).toBe(false);
    expect(oct.every((d) => brent.has(d) !== crack.has(d))).toBe(true);
  });
});
