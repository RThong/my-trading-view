import { test, expect } from 'bun:test';
import { parseIsmRelease, parseNewsroom, hintFromSlug } from './ismPrn';

// 表格按真实发布件的形状缩写:标题行 + 表头行 + 数据行。td 里夹 <sup>® 与 &nbsp; 是真实页面的样子。
const table = (title: string, rows: string[][]) =>
  `<p>正文里也会出现 Manufacturing PMI registered 99.9 percent 这种句子,不该被取到</p><table>
    <tr><td colspan="7"><b>${title}</b></td></tr>
    <tr><td>Index</td><td>Series Index Aug</td><td>Series Index Jul</td><td>Change</td></tr>
    ${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('\n')}
  </table>`;

test('parseIsmRelease:新版制造业 —— 按行首标签取头条与 Prices,不按行号', () => {
  const html = table('MANUFACTURING AT A GLANCE<br>August 2026', [
    ['Manufacturing PMI<sup>&reg;</sup>', '54.6', '55.6', '-1.0'],
    ['New Orders', '53.7', '56.7', '-3.0'],
    ['Prices', '71.1', '71.1', '0'],
  ]);

  expect(parseIsmRelease(html)).toEqual({
    sector: 'mfg',
    month: '2026-08-01',
    prevMonth: '2026-07-01',
    pmi: { cur: 54.6, prev: 55.6 },
    prices: { cur: 71.1, prev: 71.1 },
  });
});

test('parseIsmRelease:旧版服务业(NMI)—— 标题含 MANUFACTURING 也判成服务业,只取左半边', () => {
  // 服务业表每行 = 服务业 5 格 + 制造业 5 格。取错半边会得到 59.1 / 72.7(制造业的数)。
  const html = table(
    'ISM&reg; NON-MANUFACTURING SURVEY RESULTS AT A GLANCE COMPARISON OF ISM&reg; MANUFACTURING SURVEYS* JANUARY 2018',
    [
      ['NMI<sup>®</sup> /PMI<sup>®</sup>', '59.9', '56.0', '+3.9', 'Growing', '59.1', '59.3'],
      ['Prices', '61.9', '59.9', '+2.0', 'Increasing', '72.7', '68.3'],
    ],
  );

  const r = parseIsmRelease(html);
  expect(r?.sector).toBe('svc');
  expect(r?.month).toBe('2018-01-01');
  expect(r?.prevMonth).toBe('2017-12-01');
  expect(r?.pmi).toEqual({ cur: 59.9, prev: 56 });
  expect(r?.prices).toEqual({ cur: 61.9, prev: 59.9 });
});

test('parseIsmRelease:报告月在标题第二行(2021~2023 那批的版式)也能认出', () => {
  const html = `<table>
    <tr><td colspan="7">MANUFACTURING AT A GLANCE</td></tr>
    <tr><td colspan="7">July 2023</td></tr>
    <tr><td>Index</td><td>Series Index Jul</td><td>Series Index Jun</td></tr>
    <tr><td>Manufacturing PMI&reg;</td><td>46.4</td><td>46.0</td></tr>
    <tr><td>Prices</td><td>42.6</td><td>41.8</td></tr>
  </table>`;

  expect(parseIsmRelease(html)?.month).toBe('2023-07-01');

  // 2020-10~2022-02 那批:年份被拆进两个 span,去标签后是「202 1」。
  const split = html.replace('July 2023', 'December &nbsp; <span>202</span><span>1</span>');
  expect(parseIsmRelease(split)?.month).toBe('2021-12-01');
});

test('parseIsmRelease:1 月报的上月跨年;缺表 / 缺行 / 越界值 → null(由 job 报成结构变了)', () => {
  const jan = table('MANUFACTURING AT A GLANCE January 2026', [
    ['PMI&reg;', '52.6', '47.9'],
    ['Prices', '59.0', '58.5'],
  ]);
  expect(parseIsmRelease(jan)?.prevMonth).toBe('2025-12-01');

  expect(parseIsmRelease('<p>no table</p>')).toBeNull();
  // 标题既不是服务业也不明确是制造业(如 Hospital)→ null,绝不兜底成制造业
  expect(
    parseIsmRelease(
      table('HOSPITAL AT A GLANCE August 2026', [
        ['Hospital PMI', '51.3', '51.0'],
        ['Prices', '60.0', '59.0'],
      ]),
    ),
  ).toBeNull();
  expect(parseIsmRelease(table('MANUFACTURING AT A GLANCE August 2026', [['PMI', '54.6', '55.6']]))).toBeNull();
  // 取到「变动」那一格(+1.3)不会越界,但取到别的非指数列(如趋势月数 111)会 —— 越界一律拒收。
  expect(
    parseIsmRelease(
      table('MANUFACTURING AT A GLANCE August 2026', [
        ['PMI', '154.6', '55.6'],
        ['Prices', '71.1', '71.1'],
      ]),
    ),
  ).toBeNull();
});

test('parseNewsroom:只认月报 slug(新旧两代),去重;非月报一律不进候选', () => {
  const html = [
    '/news-releases/manufacturing-pmi-at-54-6-august-2026-ism-manufacturing-pmi-report-302865127.html',
    '/news-releases/manufacturing-pmi-at-54-6-august-2026-ism-manufacturing-pmi-report-302865127.html',
    '/news-releases/nmi-at-599-january-non-manufacturing-ism-report-on-business-300593372.html',
    '/news-releases/ism-makes-annual-adjustments-to-seasonal-factors-for-ism-manufacturing-pmi-302674150.html',
    '/news-releases/award-nominations-open-to-honor-global-supply-chain-leaders-301628968.html',
    // 同一 newsroom 的 Hospital PMI:放宽正则就会被吸进来当成制造业写库
    '/news-releases/hospital-pmi-at-51-3-august-2025-ism-hospital-pmi-report-302547001.html',
    // 2020-07 改名当月的特例 slug —— 曾被漏掉,而且是静默漏掉
    '/news-releases/services-pmi-formerly-non-manufacturing-nmi-at-58-1-301106674.html',
  ]
    .map((p) => `<a href="${p}">x</a>`)
    .join('');

  const c = parseNewsroom(html);
  expect(c.map((x) => x.path.match(/-(\d{9})\.html/)?.[1])).toEqual(['302865127', '300593372', '301106674']);
  expect(c.map((x) => x.hint)).toEqual([{ sector: 'mfg', month: '2026-08-01' }, null, null]);
});

test('hintFromSlug:只有新版 slug 带年份;服务业两种前缀都认', () => {
  expect(hintFromSlug('services-pmi-at-55-4-august-2026-ism-services-pmi-report')).toEqual({
    sector: 'svc',
    month: '2026-08-01',
  });
  expect(hintFromSlug('pmi-at-591-january-manufacturing-ism-report-on-business')).toBeNull();
  // 2021~2024 那批:年份后面先跟扇区词再跟 ism
  expect(hintFromSlug('manufacturing-pmi-at-47-4-january-2023-manufacturing-ism-report-on-business')).toEqual({
    sector: 'mfg',
    month: '2023-01-01',
  });
  // 2020 上半年服务业还叫 non-manufacturing
  expect(hintFromSlug('nmi-at-57-1-june-2020-non-manufacturing-ism-report-on-business')).toEqual({
    sector: 'svc',
    month: '2020-06-01',
  });
  expect(hintFromSlug('services-pmi-at-69-1-november-2021-services-ism-report-on-business')).toEqual({
    sector: 'svc',
    month: '2021-11-01',
  });
});
