import { test, expect } from 'bun:test';
import { secFiledNote, secLagNote, secTrimNote, type FundDim, type RegimeData } from './regimeChart.hooks';
import { fundamentalDoc } from '../../pages/regimeDims';
import { parseChartDoc } from '../chartDoc/chartDoc';
import { seriesDef } from '../chartDoc/registry';
import { ACTIVE_TICKERS, fundKey, kindsOf, SEC_BUYER_FCF_KEY, SEC_BUYER_FCFQ_KEY } from '../../../shared/aiChain';
import { REGIME_SERIES } from '../../../shared/regimeSeries';

// 基本面 dim 的格子(一格一条线):取出测试关心的几项
function dimPanes(dim: FundDim) {
  return fundamentalDoc(dim).panes.map((p) => ({
    key: p.layers[0].series,
    title: p.layers[0].title,
    render: p.layers[0].render,
    desc: p.desc,
  }));
}

const LAG = { ticker: 'META', remoteFiled: '2026-07-30', localFiled: '2026-04-30', latestPeriodEnd: '2026-03-31' };
function withLag(secLag: (typeof LAG)[]): RegimeData {
  return { series: {}, unavailable: [], secLag };
}

test('secLagNote:落后的那家 tab 出提示,其余 tab 与非基本面维度不出', () => {
  expect(secLagNote(withLag([LAG]), 'fundamentals:META')).toContain('META 截至 2026-03-31');
  expect(secLagNote(withLag([LAG]), 'fundamentals:META')).toContain('2026-07-30 已申报');
  expect(secLagNote(withLag([LAG]), 'fundamentals:AMZN')).toBeUndefined();
  expect(secLagNote(withLag([LAG]), 'liquidity')).toBeUndefined();
  expect(secLagNote({ series: {}, unavailable: [] }, 'fundamentals:META')).toBeUndefined();
});

test('secLagNote:买方合计格受任一买方滞后影响;卖方滞后不影响它', () => {
  // 合计是全员齐才出点,买方 META 落后就顶住整条线末端 → 必须提示。
  expect(secLagNote(withLag([LAG]), 'fundamentals:buyer')).toContain('META');
  // MU 是卖方,不进合计 → 合计那格不该因它报警。
  expect(secLagNote(withLag([{ ...LAG, ticker: 'MU' }]), 'fundamentals:buyer')).toBeUndefined();
});

// 面板的格子按 source 分派(见 ai/fundamentals 的 SOURCE_PANES)。这条锁住「加了非 SEC 源的公司,
// 不会被套上 SEC 那四格」—— 套错了会画出四条永远空的线,而空线不报错。
test('dimPanes:TSM 八格 = sec6k 六格 + twse 两格,gm 不重复', () => {
  const twse = dimPanes('fundamentals:TSM');
  expect(twse.map((p) => p.key)).toEqual([
    'fund:TSM:gm',
    'fund:TSM:fcf',
    'fund:TSM:fcfq',
    'fund:TSM:rev',
    'fund:TSM:revGrowth',
    'fund:TSM:capex',
    'fund:TSM:revYoy',
    'fund:TSM:revM',
  ]);

  // sec 侧的 rev(TTM 营收)/ revGrowth(单季同比)与 twse 的 revM / revYoy(月营收 / 月同比)
  // 是四个不同的 kind —— 口径与频率都不同,TSM 两边都有,不去重。
  const sec = dimPanes('fundamentals:NVDA');
  expect(sec.map((p) => p.key)).toEqual([
    'fund:NVDA:gm',
    'fund:NVDA:fcf',
    'fund:NVDA:fcfq',
    'fund:NVDA:rev',
    'fund:NVDA:revGrowth',
    'fund:NVDA:capex',
  ]);
});

// 分部格挂在「这家披露不披露」上,不挂在源上 —— 同一个 sec 源下,五家买方里只有三家报得出
// 云收入(MSFT 只报 Intelligent Cloud 合并口径、META 根本不对外卖云)。挂错会给另外两家
// 各加一条永远空的线,而空线不报错。
test('dimPanes:capex/云收入只出现在报了分部的三家,同源的 MSFT/META 没有', () => {
  // 标签取自各自 SEGMENT_FACTS 的 label —— 写死成「Google Cloud」的话,新加的两家会
  // 顶着别家的分部名出图,而图上看不出错。
  const cloudPane = (ticker: string) => {
    const panes = dimPanes(`fundamentals:${ticker}`).filter((p) => p.key === `fund:${ticker}:capexCloud`);
    expect(panes).toHaveLength(1); // GOOGL 成员名改过 → SEGMENT_FACTS 里两个 member,面板上仍只有一格
    return panes[0]!;
  };

  expect(cloudPane('GOOGL').title).toContain('/ Google Cloud 收入');
  expect(cloudPane('AMZN').title).toContain('/ AWS 收入');
  expect(cloudPane('ORCL').title).toContain('/ OCI IaaS 收入');

  // 比率的判据线是 1.0(当季 capex 恰好等于当季云收入),不是 0。
  expect(cloudPane('AMZN').render).toEqual({ kind: 'line', baseline: 1 });
  // 分子分母口径不同 —— 这条警告不在,读的人会当成「云业务的投入产出比」。
  expect(cloudPane('AMZN').desc).toContain('不是一门生意的投入产出比');

  for (const t of ['MSFT', 'META']) {
    expect(dimPanes(`fundamentals:${t}`).some((p) => /capexCloud/.test(p.key))).toBe(false);
  }
});

test('dimPanes:TSM 的金额格用新台币,别家用美元', () => {
  const money = (dim: FundDim, key: string) => dimPanes(dim).find((p) => p.key === key)!;

  // 币种混淆是这一格最容易踩的坑:TSM 的数比别家大一个数量级纯粹因为汇率。
  expect(money('fundamentals:TSM', 'fund:TSM:fcf').title).toContain('百万新台币');
  expect(money('fundamentals:NVDA', 'fund:NVDA:fcf').title).toContain('百万美元');
});

test('dimPanes:TSM 走 6-K 那条的格子要交代「不是 XBRL、是 IFRS」', () => {
  // 没有 tag 级溯源、口径是 IFRS —— 两条都影响和别家的可比性,必须写在格子里。
  for (const key of ['fund:TSM:gm', 'fund:TSM:fcf', 'fund:TSM:fcfq', 'fund:TSM:capex']) {
    const desc = dimPanes('fundamentals:TSM').find((p) => p.key === key)!.desc!;
    expect(desc).toContain('不是 XBRL');
    expect(desc).toContain('IFRS');
  }
});

test('dimPanes:月营收那两格要写清币种与「不可回填」', () => {
  const monthly = dimPanes('fundamentals:TSM').filter((p) => /revM|revYoy/.test(p.key));

  expect(monthly).toHaveLength(2);
  for (const p of monthly) {
    expect(p.desc).toContain('百万新台币');
    expect(p.desc).toContain('补不了历史');
  }
});

// 折线只连点 —— 断档两端会被连成一条斜率是编的直线。月营收是快照攒的、中间必然有空档,
// 实测接入首日就画出一条 2025-06 → 2026-05 的假匀速上升,所以这两格必须是柱状。
test('dimPanes:月营收两格画柱状不画折线(断档不得连成假斜率)', () => {
  const byKey = Object.fromEntries(dimPanes('fundamentals:TSM').map((p) => [p.key, p]));

  expect(byKey['fund:TSM:revM']!.render).toEqual({ kind: 'signed' });
  expect(byKey['fund:TSM:revYoy']!.render).toEqual({ kind: 'signed' });
  // 毛利率是比率、等间隔季频,折线才对(它由路由端裁断档兜住)。
  expect(byKey['fund:TSM:gm']!.render).toBeUndefined();
});

// 面板造的格子必须与 shared/aiChain 声明的格子种类**逐个对上**。多造一格的后果是**哑空格**:
// 路由按 kindsOf 决定发哪些序列、也按它决定哪些进 unavailable,名单外的 key 两边都不管
// → 面板上一块既没数据也不提示的空白。(踩过:twseCompanyPanes 曾多造一格已退掉的 TWSE 季度毛利率,
// 眼下被 sec6k 的同名格挡住才没露出来。)
test('每家的 panes 与 kindsOf 一一对应,不多不少', () => {
  for (const ticker of ACTIVE_TICKERS) {
    const keys = dimPanes(`fundamentals:${ticker}`).map((p) => p.key);
    const want = kindsOf(ticker).map((k) => fundKey(ticker, k));

    expect(new Set(keys), `${ticker} 的格子`).toEqual(new Set(want));
    expect(keys.length, `${ticker} 的格子有重复`).toBe(new Set(keys).size);
  }
});

// 裁剪必须**可见**。裁本身是对的(折线只连点,断档两端会连出一条斜率是编的直线),
// 但静默裁掉后用户只看到一条短线,分不清是「这家上市晚」还是「中间缺季、TTM 整段作废」。
test('secTrimNote:只报本 tab 的格子,并说清断在哪', () => {
  const data: RegimeData = {
    series: {},
    unavailable: [],
    secTrim: [
      { key: fundKey('NVDA', 'capex'), dropped: 5, gapFrom: '2021-01-31', gapTo: '2023-10-29' },
      { key: fundKey('AMZN', 'capex'), dropped: 33, gapFrom: '2017-03-31', gapTo: '2018-06-30' },
    ],
  };

  const note = secTrimNote(data, fundamentalDoc('fundamentals:NVDA'));
  expect(note).toContain('少 5 点');
  expect(note).toContain('2021-01-31 → 2023-10-29');
  expect(note).not.toContain('33'); // 别家的不混进来
});

test('secTrimNote:没裁过就不出提示', () => {
  expect(secTrimNote({ series: {}, unavailable: [] }, fundamentalDoc('fundamentals:NVDA'))).toBeUndefined();
  expect(
    secTrimNote({ series: {}, unavailable: [], secTrim: [] }, fundamentalDoc('fundamentals:NVDA')),
  ).toBeUndefined();
});

// 这两条守的是枚举与后端产出的一致:
// 枚举本身与后端实际产出漂移。类型只保证两端用同一份名单,不保证名单还对得上代码。
test('REGIME_SERIES:无重复、无 fund: 前缀(动态键不进枚举)', () => {
  expect(new Set(REGIME_SERIES).size).toBe(REGIME_SERIES.length);
  expect(REGIME_SERIES.filter((k) => k.startsWith('fund:'))).toEqual([]);
});

// 买方合计那两条聚合键**不走 kindsOf**,所以上面「每家的 panes 与 kindsOf 一一对应」那条
// (只遍历 ACTIVE_TICKERS)覆盖不到它;而类型也挡不住 —— `FundSeries` 是 `fund:${string}`,
// 前缀对就通过。键写错 = 永远空白的一格,编译过、测试过、只有打开面板才看得见。
test('fundamentals:buyer 的 pane key 是后端真会产的那两条', () => {
  const emitted = new Set([SEC_BUYER_FCF_KEY, SEC_BUYER_FCFQ_KEY]);
  const keys = dimPanes('fundamentals:buyer').map((p) => p.key);

  expect(new Set(keys)).toEqual(emitted);
});

test('secFiledNote:单家 tab 标最新一期与申报日;没数据、合计与非基本面不标', () => {
  const data: RegimeData = {
    series: {},
    unavailable: [],
    secFiled: { ASML: { periodEnd: '2026-09-27', filed: '2026-10-14' } },
  };

  expect(secFiledNote(data, 'fundamentals:ASML')).toBe('截至 2026-09-27 · 2026-10-14 申报');
  expect(secFiledNote(data, 'fundamentals:MU')).toBeUndefined();
  expect(secFiledNote(data, 'fundamentals:buyer')).toBeUndefined();
  expect(secFiledNote(data, 'liquidity')).toBeUndefined();
});

// DocChart 以 doc 为初值:基本面 doc 按名单现算,同一 dim 必须拿到同一个对象(靠 fundamentalDoc 的缓存兜住)
test('fundamentalDoc:同一 dim 每次拿到同一个对象', () => {
  expect(fundamentalDoc('fundamentals:NVDA')).toBe(fundamentalDoc('fundamentals:NVDA'));
});

// 动态生成的 doc 不在 REGIME_DOCS 里,docs.test 的 JSON 往返 / 注册表检查覆盖不到,这里逐家补上
test.each([...ACTIVE_TICKERS, 'buyer'])(
  'fundamentals:%s 的 doc:JSON 往返无损、序列都在注册表、图层 id 不重复',
  (who) => {
    const doc = fundamentalDoc(`fundamentals:${who}`);
    expect(parseChartDoc(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
    const layers = doc.panes.flatMap((p) => p.layers);
    expect(layers.filter((l) => !seriesDef(l.series)).map((l) => l.series)).toEqual([]);
    expect(new Set(layers.map((l) => l.id)).size).toBe(layers.length);
  },
);
