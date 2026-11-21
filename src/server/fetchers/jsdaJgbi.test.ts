import { describe, expect, test } from 'bun:test';
import { parseBbBei, parseJsdaJgbi } from './jsdaJgbi';
import { parseJpHolidays } from './jpHolidays';

// 真实文件 S261124.csv 里的几行(其余 1 万多行省略)
const JGB382 =
  '20261124,02,003820067,"長期国債 382",20360320,2.4,2.743,97.19,0.26,"03/09","20",0,0,0,2.779,97.22,2.775,97.18,2.780," ",9,2.739,0.29,2.744,0.29,2.744,2.780,97.18,0.25';
const JGB383 =
  '20261124,02,003830067,"長期国債 383",20360620,2.7,2.781,99.32,0.27,"06/12","20",0,0,0,2.789,99.35,2.785,99.31,2.790," ",9,2.777,0.29,2.782,0.30,2.782,2.790,99.31,0.26';
function jgbi(no: number, mat: string, px: string) {
  return `20261124,05,000${no}0083,"物価連動国債 ${no}",${mat},99.999,999.999,${px},-0.05,"03/09","10",0,0,0,999.999,${px},999.999,${px},999.999," ",5,999.999,-0.05,999.999,-0.05,999.999,999.999,${px},-0.05`;
}

describe('parseJsdaJgbi', () => {
  test('取编号最大的 JGBi + 同到期年月的长期国债;文件日期 = 受渡日', () => {
    const csv = [JGB382, JGB383, jgbi(30, '20350310', '93.15'), jgbi(31, '20360310', '96.80')].join('\r\n');
    expect(parseJsdaJgbi(csv)).toEqual({
      settle: '2026-11-24',
      jgbi: { no: 31, maturity: '2036-03-10', coupon: 0.6, price: 96.8 },
      nominal: { name: '長期国債 382', yield: 2.743 },
    });
  });

  test('价格 999.99(报价社数不足)→ null;票息没登记 / 没有 JGBi / 找不到对应名义券 → 抛错', () => {
    expect(parseJsdaJgbi([JGB382, jgbi(31, '20360310', '999.99')].join('\n')).jgbi.price).toBeNull();
    expect(() => parseJsdaJgbi([JGB382, jgbi(32, '20370310', '100.10')].join('\n'))).toThrow('票息没登记');
    expect(() => parseJsdaJgbi(JGB382)).toThrow('没有物価連動国債');
    expect(() => parseJsdaJgbi([JGB383, jgbi(31, '20360310', '96.80')].join('\n'))).toThrow('同到期年月');
  });
});

describe('parseBbBei', () => {
  const page = (affiliate: string, labels: string, data: string) =>
    [
      '<script>',
      '    initChart(',
      '    // label',
      `    ${JSON.stringify(labels)},`,
      '    // affiliate',
      `    ${JSON.stringify(affiliate)},`,
      '    // tabledata',
      `    ${JSON.stringify(data)},`,
      '    // left axis enable',
      '    true',
      '    );',
      '</script>',
    ].join('\n');
  const LEGEND = JSON.stringify(['１０年物価連動債<br>複利利回り', '10年利付国債<br>複利利回り', 'BEI']);

  test('三条按日期展开', () => {
    const html = page(LEGEND, '["2024/04/01","2026/10/30"]', '[[-0.656,0.738],[0.655,2.739],[1.311,2.001]]');
    expect(parseBbBei(html)).toEqual([
      { date: '2024-04-01', real: -0.656, nominal: 0.655, bei: 1.311 },
      { date: '2026-10-30', real: 0.738, nominal: 2.739, bei: 2.001 },
    ]);
  });

  test('源里重复贴的日期:值相同去重并排序,值不同抛错', () => {
    const dup = page(LEGEND, '["2026/05/01","2026/05/07","2026/05/01"]', '[[0.5,0.4,0.5],[2.5,2.4,2.5],[2,2,2]]');
    expect(parseBbBei(dup).map((r) => r.date)).toEqual(['2026-05-01', '2026-05-07']);
    const clash = page(LEGEND, '["2026/05/01","2026/05/01"]', '[[0.5,0.6],[2.5,2.5],[2,1.9]]');
    expect(() => parseBbBei(clash)).toThrow('值不同');
  });

  test('图例变了 / 长度不一致 / 空值 → 抛错', () => {
    expect(() => parseBbBei(page('["a","b","c"]', '["2024/04/01"]', '[[1],[2],[3]]'))).toThrow('图例变了');
    expect(() => parseBbBei(page(LEGEND, '["2024/04/01"]', '[[1,2],[2],[3]]'))).toThrow('长度不一致');
    expect(() => parseBbBei(page(LEGEND, '["2024/04/01"]', '[[null],[2],[3]]'))).toThrow('空值');
  });
});

test('parseJpHolidays:日期补零;表头变了抛错', () => {
  const csv = '国民の祝日・休日月日,国民の祝日・休日名称\r\n2026/11/3,文化の日\r\n2026/11/23,勤労感謝の日\r\n';
  expect([...parseJpHolidays(csv)]).toEqual(['2026-11-03', '2026-11-23']);
  expect(() => parseJpHolidays('日付,名称\n2026/11/3,文化の日')).toThrow('表头变了');
});
