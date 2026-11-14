import { describe, expect, it } from 'bun:test';
import { parseMofWeeklyFlows } from './mofSecurities';

const CAT =
  'Equity and investment fund shares,,, Long-term debt securities,,,Subtotal,Short-term debt securities,,,Total';
const HEAD = [
  `,1. Portfolio Investment Assets${','.repeat(11)}2. Portfolio Investment Liabilities${','.repeat(10)}`,
  `,${CAT},${CAT}`,
  ',Acquisition,Disposition,Net,Acquisition,Disposition,Net,Net,Acquisition,Disposition,Net,Net,Acquisition,Disposition,Net,Acquisition,Disposition,Net,Net,Acquisition,Disposition,Net,Net',
];
// 真实两行(2026-11 文件):普通周 + 跨年周(终点另写年份)
const ROWS = [
  '2026．11．1～11．7,"30,310 ","36,749 ","-6,439 ","84,352 ","89,728 ","-5,376 ","-11,816 ","12,368 ","11,704 ",663 ,"-11,153 ","404,355 ","405,407 ","-1,052 ","60,708 ","46,997 ","13,711 ","12,659 ","18,807 ","33,790 ","-14,983 ","-2,324 "',
  '2006．12．31～ 2007．1．6,"1,583 ","1,346 ",237 ,"6,630 ","7,428 ",-798 ,-562 ,936 ,"1,311 ",-375 ,-937 ,"20,838 ","21,137 ",-299 ,"4,638 ","6,065 ","-1,428 ","-1,726 ","2,778 ",582 ,"2,196 ",470 ',
];

describe('parseMofWeeklyFlows', () => {
  it('取四个净额,日期标该周周五(含跨年周)', () => {
    expect(parseMofWeeklyFlows([...HEAD, ...ROWS, ',③ネットのプラス…'].join('\r\n'))).toEqual([
      { date: '2026-11-06', outEquity: -6439, outBonds: -5376, inEquity: -1052, inBonds: 13711 },
      { date: '2007-01-05', outEquity: 237, outBonds: -798, inEquity: -299, inBonds: -1428 },
    ]);
  });

  it('空格子不当成 0:记 NaN,同周另外三格照留', () => {
    const blank = ROWS[0].replace('"-6,439 "', '');
    const [w] = parseMofWeeklyFlows([...HEAD, blank].join('\n'));
    expect(w.outEquity).toBeNaN();
    expect(w.outBonds).toBe(-5376);
  });

  it('子表头变了 → 抛错', () => {
    expect(() => parseMofWeeklyFlows([HEAD[0], HEAD[1], ',Acquisition,Net', ...ROWS].join('\n'))).toThrow('表头');
  });

  it('子表头尾部多出一列 → 也抛错(整行核对,不是前缀)', () => {
    expect(() => parseMofWeeklyFlows([HEAD[0], HEAD[1], `${HEAD[2]},Net`, ...ROWS].join('\n'))).toThrow('表头');
  });

  it('股 / 债两块对调(子表头不变)→ 靠分类那行抛错', () => {
    const swapped = HEAD[1].replace(
      'Equity and investment fund shares,,, Long-term debt securities',
      ' Long-term debt securities,,,Equity and investment fund shares',
    );
    expect(() => parseMofWeeklyFlows([HEAD[0], swapped, HEAD[2], ...ROWS].join('\n'))).toThrow('表头');
  });
});
