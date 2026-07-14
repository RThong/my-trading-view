import { describe, expect, test } from 'bun:test';
import { parseCapeTable } from './capeShiller';

describe('parseCapeTable', () => {
  // 真实结构:值前有 &#x2002; 实体,须跳过——否则会误抓实体里的 2002。
  const html =
    `<table id="datatable"><tr><th>Date</th><th>Value</th></tr>` +
    `<tr class="odd"><td>Jul 13, 2026</td><td> &#x2002; 41.85 </td></tr>` +
    `<tr class="even"><td>Jun 1, 2026</td><td> &#x2002; 41.32 </td></tr>` +
    `<tr class="odd"><td>Feb 1, 1871</td><td> &#x2002; 10.92 </td></tr>` +
    `</table>`;

  test('解析日期+值,跳 &#x2002; 实体,升序', () => {
    expect(parseCapeTable(html)).toEqual([
      { date: '1871-02-01', value: 10.92 },
      { date: '2026-06-01', value: 41.32 },
      { date: '2026-07-13', value: 41.85 },
    ]);
  });

  test('空/无表 → []', () => {
    expect(parseCapeTable('<html>nope</html>')).toEqual([]);
  });
});
