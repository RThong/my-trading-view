import { afterEach, describe, expect, test } from 'bun:test';
import { fetchAcmTermPremium, parseAcmPlot } from './nyfedAcm';

// 真文件的形状(实测 2026-09-11):RunDates 是 `31-Aug-2026`,月末;数据按日期升序。
const csv = [
  'RunDates,TERMYld,ACMFITYld,GSWYld',
  '30-Jun-2026,0.5107896670684884,4.477172290819595,4.48',
  '31-Jul-2026,0.8363484212290779,4.823032091367971,4.83',
  '31-Aug-2026,0.7625129457707631,4.817096041484916,4.82610113666976',
].join('\n');

describe('parseAcmPlot', () => {
  test('取 TERMYld 作期限溢价,日期 DD-Mon-YYYY → ISO', () => {
    expect(parseAcmPlot(csv, '2026-07-01')).toEqual([
      { date: '2026-07-31', value: 0.8363484212290779 },
      { date: '2026-08-31', value: 0.7625129457707631 },
    ]);
  });

  test('since 之前的行被过滤', () => expect(parseAcmPlot(csv, '2026-08-01')).toHaveLength(1));

  // 列序若被调换,按列号取会静默拿到 ACMFITYld(4.8 而非 0.76)——量级像溢价的十倍,但图上只是条高线。
  test('按表头名定位,列顺序变了也取对', () => {
    const swapped = [
      'RunDates,GSWYld,ACMFITYld,TERMYld',
      '31-Aug-2026,4.82610113666976,4.817096041484916,0.7625129457707631',
    ].join('\n');

    expect(parseAcmPlot(swapped, '2026-01-01')).toEqual([{ date: '2026-08-31', value: 0.7625129457707631 }]);
  });

  // Number('') 是 0 且通过 isFinite —— 空格子落成 0 = 图上一条掉到零的假溢价线,不报错。
  test('TERMYld 为空的行 → 跳过,不落成 0', () =>
    expect(parseAcmPlot('RunDates,TERMYld\n31-Jul-2026,\n31-Aug-2026,0.76', '2000-01-01')).toEqual([
      { date: '2026-08-31', value: 0.76 },
    ]));

  test('整列为空 → 抛错,不能靠凑行数蒙混过去', () =>
    expect(() => parseAcmPlot('RunDates,TERMYld\n31-Jul-2026,\n31-Aug-2026,', '2000-01-01')).toThrow(/没解析出/));

  // 日期只校验月名和年份是不够的:日号部分没验形状,也没验这一天真的存在。
  // 吐出 '2026-08-xx' / '2026-02-31' 会绕过「没解析出」那道保护,把非法日期交给图表。
  test.each([
    ['xx-Aug-2026', '日号不是数字'],
    ['31-Feb-2026', '这一天不存在'],
    ['0-Aug-2026', '日号为 0'],
    ['31-Aug-26', '年份不是四位'],
  ])('非法日期 %s(%s)→ 该行跳过', (bad) =>
    expect(() => parseAcmPlot(`RunDates,TERMYld\n${bad},0.76`, '2000-01-01')).toThrow(/没解析出/),
  );

  test('缺 TERMYld 列 → 抛错(表结构可能改版)', () =>
    expect(() => parseAcmPlot('RunDates,ACMFITYld\n31-Aug-2026,4.8', '2026-01-01')).toThrow(/TERMYld/));

  // 日期格式一变就会每行都跳过 → 空数组。静默返回空会被上层当成「源暂时没数据」,必须响。
  test('一行都没解析出 → 抛错', () =>
    expect(() => parseAcmPlot('RunDates,TERMYld\n2026-08-31,0.76', '2026-01-01')).toThrow(/没解析出/));

  test('输出升序,且源已升序时不重排坏', () => {
    const rows = parseAcmPlot(csv, '2000-01-01');
    expect(rows.map((r) => r.date)).toEqual(['2026-06-30', '2026-07-31', '2026-08-31']);
  });
});

// 这条源是**无文档端点**(NY Fed 图表的取数源),改版随时会 404。降级链是
// 「fetcher 抛 → 路由 .catch(() => null) → put(undefined) → unavailable → 面板少一条对照线」。
// 这里测的是链条的**第一环**:非 2xx 必须抛,不能把错误页当空数据吞。
// ⚠️ 中间那环(路由把拒绝转成 unavailable)没有单测 —— 它没有可注入的缝,且与 cape / rstar /
// jgbVix 用的是同一个既有写法。最后一环在 regimeChart.hooks.test.ts 那条 overlay 测试里。
describe('fetchAcmTermPremium', () => {
  const realFetch = globalThis.fetch;
  // Bun 的 fetch 带 preconnect 等自有属性,直接断言成 typeof fetch 过不了 —— 只替换调用行为,保留其余。
  const stub = (make: () => Response) => Object.assign(async () => make(), realFetch) as unknown as typeof fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('非 2xx → 抛错(不把错误页当空数据)', async () => {
    globalThis.fetch = stub(() => new Response('<html>oops</html>', { status: 503 }));

    await expect(fetchAcmTermPremium()).rejects.toThrow(/503/);
  });

  test('200 但内容不是预期表结构 → 抛错', async () => {
    globalThis.fetch = stub(() => new Response('<html>redirected</html>', { status: 200 }));

    await expect(fetchAcmTermPremium()).rejects.toThrow(/表结构可能改版/);
  });
});
