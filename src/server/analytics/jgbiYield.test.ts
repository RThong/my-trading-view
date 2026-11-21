import { expect, test } from 'bun:test';
import { jgbiCompoundYield } from './jgbiYield';
import { isJpBusinessDay, jpBusinessDaysBetween, nextJpBusinessDay, prevJpBusinessDay } from './jpCalendar';

test('jgbiCompoundYield:JSDA 价格倒推的实际利率与 BB / 财务省逐位一致(#31,票息 0.6%,2036-03-10 到期)', () => {
  // [受渡日, JSDA 平均値単価, BB / 财务省的实际利率]
  const cases: [string, number, number][] = [
    ['2026-08-07', 98.1, 0.806], // 报价日 08-06
    ['2026-08-10', 98.0, 0.817], // 08-07
    ['2026-08-12', 97.7, 0.85], // 08-10(08-11 山の日)
    ['2026-11-20', 96.85, 0.954], // 11-19,财务省 PDF
  ];
  cases.forEach(([settle, price, want]) => {
    expect(Math.round(jgbiCompoundYield(price, 0.6, settle, '2036-03-10') * 1000) / 1000).toBe(want);
  });
});

test('jpCalendar:跳周末、祝日、年末年始', () => {
  const h = new Set(['2026-11-23', '2027-01-01', '2027-01-11']);
  expect(nextJpBusinessDay('2026-11-20', h)).toBe('2026-11-24'); // 周五 → 越过周末 + 勤劳感谢日
  expect(prevJpBusinessDay('2026-11-24', h)).toBe('2026-11-20');
  expect(nextJpBusinessDay('2026-12-30', h)).toBe('2027-01-04'); // 12-31 ~ 1-3 休
  expect(isJpBusinessDay('2026-12-31', h)).toBe(false);
  expect(jpBusinessDaysBetween('2026-11-20', '2026-11-25', h)).toEqual(['2026-11-20', '2026-11-24', '2026-11-25']);
});
