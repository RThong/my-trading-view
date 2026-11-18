import { expect, test } from 'bun:test';
import { fetchLme3m, parseLme3m } from './westmetall';

const HEAD =
  '<thead><tr class="shaded"><th class="text">date</th><th class="text">LME Copper Cash-Settlement</th>' +
  '<th class="text">LME Copper 3-month</th><th class="text last">LME Copper stock</th></tr></thead>';
function row(d: string, cash: string, m3: string, stock = '100,000') {
  return `<tr><td >${d}</td><td >${cash}</td><td >${m3}</td><td class="last">${stock}</td></tr>`;
}
function page(...rows: string[]) {
  return `<html><body><table >${HEAD}<tbody>${rows.join('')}</tbody></table></body></html>`;
}

test('一年那页:取 3 个月价,千分位去掉,新到旧翻成升序', () => {
  const html = page(row('8. April 2025', '8,760.00', '8,814.00'), row('07. April 2025', '8,825.00', '8,870.00'));
  expect(parseLme3m(html, 2025, false)).toEqual([
    { date: '2025-04-07', value: 8870 },
    { date: '2025-04-08', value: 8814 },
  ]);
});

test('每个月开头重复一遍的表头行跳过(实测整年页 12 次)', () => {
  const repeat = HEAD.replace('<thead>', '').replace('</thead>', '');
  const html = page(row('1. February 2025', '1', '2'), repeat, row('31. January 2025', '1', '3'));
  expect(parseLme3m(html, 2025, false).map((p) => p.value)).toEqual([3, 2]);
});

test('版式变了就整页抛:表头不是 3-month、日期不在那一年 / 不存在、价不是数、日期不降序、往年空页', () => {
  const bad =
    (html: string, current = false) =>
    () =>
      parseLme3m(html, 2025, current);
  expect(bad(page(row('8. April 2025', '1', '2')).replace('3-month', '3M'))).toThrow('表头');
  expect(bad(page(row('8. April 2024', '1', '2')))).toThrow('坏行');
  expect(bad(page(row('31. April 2025', '1', '2')))).toThrow('坏行');
  expect(bad(page(row('8. April 2025', '1', '-')))).toThrow('不是数');
  expect(bad(page(row('7. April 2025', '1', '2'), row('8. April 2025', '1', '2')))).toThrow('降序');
  expect(bad(page())).toThrow('一行数据都没有');
  expect(parseLme3m(page(), 2025, true)).toEqual([]);
});

test('逐年拉到今年拼成一条;任一年 HTTP 失败整条抛', async () => {
  const thisYear = new Date().getUTCFullYear();
  const urls: string[] = [];
  const ok = async (url: string) => {
    urls.push(url);
    const y = Number(/year=(\d+)/.exec(url)?.[1]);
    return new Response(page(row(`2. January ${y}`, '1', '2'), row(`1. January ${y}`, '1', '1')));
  };
  const pts = await fetchLme3m('LME_Cu_cash', thisYear - 1, ok as never, 0);

  expect(urls).toHaveLength(2);
  expect(pts.map((p) => p.date)).toEqual([
    `${thisYear - 1}-01-01`,
    `${thisYear - 1}-01-02`,
    `${thisYear}-01-01`,
    `${thisYear}-01-02`,
  ]);
  const fail = async () => new Response('', { status: 503 });
  await expect(fetchLme3m('LME_Cu_cash', thisYear, fail as never, 0)).rejects.toThrow('503');
});

test('往年页进进程内缓存:第二次只拉当年那一页', async () => {
  const thisYear = new Date().getUTCFullYear();
  const urls: string[] = [];
  const ok = async (url: string) => {
    urls.push(url);
    const y = Number(/year=(\d+)/.exec(url)?.[1]);
    return new Response(page(row(`1. January ${y}`, '1', '1')));
  };
  await fetchLme3m('LME_Al_cash', thisYear - 2, ok as never, 0);
  urls.length = 0;
  const again = await fetchLme3m('LME_Al_cash', thisYear - 2, ok as never, 0);

  expect(urls.map((u) => /year=(\d+)/.exec(u)?.[1])).toEqual([String(thisYear)]);
  expect(again).toHaveLength(3);
});

test('当年页 404 / 没有表:只在 1 月上半月当「还没数据」,其余时候照样失败', async () => {
  const gone = async () => new Response('not found', { status: 404 });
  const noTable = async () => new Response('<html><body>soon</body></html>');

  expect(await fetchLme3m('LME_Ni_cash', 2027, gone as never, 0, new Date('2027-01-05T00:00:00Z'))).toEqual([]);
  expect(await fetchLme3m('LME_Zn_cash', 2027, noTable as never, 0, new Date('2027-01-05T00:00:00Z'))).toEqual([]);
  await expect(fetchLme3m('LME_Pb_cash', 2027, gone as never, 0, new Date('2027-03-01T00:00:00Z'))).rejects.toThrow(
    '404',
  );
  await expect(fetchLme3m('LME_Sn_cash', 2027, noTable as never, 0, new Date('2027-03-01T00:00:00Z'))).rejects.toThrow(
    '张表',
  );
});

test('新年头半个月去年那页不进缓存(T+1 发布,可能还缺年末那两天),过了才缓存', async () => {
  const urls: string[] = [];
  const ok = async (url: string) => {
    urls.push(url);
    const y = Number(/year=(\d+)/.exec(url)?.[1]);
    return new Response(page(row(`2. January ${y}`, '1', '1')));
  };
  const years = () => urls.splice(0).map((u) => /year=(\d+)/.exec(u)?.[1]);
  const jan = new Date('2021-01-05T00:00:00Z');
  const mar = new Date('2021-03-01T00:00:00Z');

  await fetchLme3m('LME_Cu_cash', 2019, ok as never, 0, jan);
  expect(years()).toEqual(['2019', '2020', '2021']);
  await fetchLme3m('LME_Cu_cash', 2019, ok as never, 0, jan);
  expect(years()).toEqual(['2020', '2021']);
  await fetchLme3m('LME_Cu_cash', 2019, ok as never, 0, mar);
  expect(years()).toEqual(['2020', '2021']);
  await fetchLme3m('LME_Cu_cash', 2019, ok as never, 0, mar);
  expect(years()).toEqual(['2021']);
});
