import { test, expect } from 'bun:test';
import {
  buildRegimeSpecs,
  derivePaneMeta,
  regimePercentiles,
  secFiledNote,
  secLagNote,
  secTrimNote,
  type PaneSpec,
  type RegimeData,
} from './regimeChart.hooks';
import { dimPanes, regimeView } from '../../pages/regimeDims';
import { ACTIVE_TICKERS, fundKey, kindsOf, SEC_BUYER_FCF_KEY, SEC_BUYER_FCFQ_KEY } from '../../../shared/aiChain';
import { REGIME_SERIES } from '../../../shared/regimeSeries';

// 旧 regime 图(RegimeChart)只剩基本面维度用:画法用例用内联的格子,不依赖任何真实 tab 的配置
// (固定 tab 是 ChartDoc,配置层面的约束见 docs.test,画法见 views/chartDoc 的测试)。
const PANES: PaneSpec[] = [
  { key: 'netLiquidity', label: '净流动性', title: '净流动性', color: '#22c55e' },
  { key: 'reserves', label: '准备金', title: '准备金', color: '#3b82f6' },
  { key: 'repoUsage', label: '回购用量', title: '回购用量', color: '#ec4899' },
  { key: 'repoStress', label: '回购压力', title: '回购压力', render: { kind: 'line', baseline: 0 } },
];
const data: RegimeData = {
  series: {
    netLiquidity: [
      { date: '2020-01-01', value: 5 },
      { date: '2020-01-02', value: 6 },
    ],
    // reserves 无数据、repoUsage 缺失(模拟 unavailable)
    repoStress: [{ date: '2020-01-01', value: -0.01 }],
  },
  unavailable: ['repoUsage'],
};

test('pane 下标按 panes 顺序,缺失序列被跳过', () => {
  const specs = buildRegimeSpecs(data, PANES, '1D');
  expect(specs.map((s) => s.key)).toEqual(['netLiquidity', 'repoStress']);
  // pane 下标 = 原 panes 索引(reserves、repoUsage 被跳过后 repoStress 仍是 3)
  expect(specs.map((s) => s.pane)).toEqual([0, 3]);
  expect((specs[1] as { baseline?: number }).baseline).toBe(0);
  expect((specs[0] as { baseline?: number }).baseline).toBeUndefined();
});

test('全部缺失 → 空 specs', () => {
  expect(buildRegimeSpecs({ series: {}, unavailable: [] }, PANES, '1D')).toEqual([]);
});

test('分位带 + 极端期背景带按 riskTail 语义上色;无 riskTail 只留 P5/P95 线;since 只限阈值窗口', () => {
  const fng = Array.from({ length: 11 }, (_, i) => ({
    date: `2021-01-${String(i + 1).padStart(2, '0')}`,
    value: i * 10,
  }));
  const high: PaneSpec = { key: 'fng', label: 'F&G', title: 'F&G', percentile: { riskTail: 'high' } };
  const specs = buildRegimeSpecs({ series: { fng }, unavailable: [] }, [high], '1D');

  // [背景直方图, 线] 两条,背景先建 → 画在下层
  expect(specs.map((s) => s.key)).toEqual(['fng-bg', 'fng']);
  expect((specs[1] as { refLines?: unknown }).refLines).toEqual([
    { price: 5, title: 'P5' },
    { price: 95, title: 'P95' },
  ]);
  const bg = specs[0] as { data: Array<{ value: number; color: string }>; priceScaleId?: string };
  expect(bg.priceScaleId).toBe('bg-fng');
  expect(bg.data[0]).toMatchObject({ value: 1, color: 'rgba(34,197,94,0.45)' }); // 低端 = 机会 = 绿
  expect(bg.data[10]).toMatchObject({ value: 1, color: 'rgba(239,68,68,0.45)' }); // 高端 = 风险 = 红

  const plain = buildRegimeSpecs({ series: { fng }, unavailable: [] }, [{ ...high, percentile: {} }], '1D');
  expect(plain.map((s) => s.key)).toEqual(['fng']);

  // since:阈值只用 01-06 起的 6 个点(50 … 100),线仍画全部 11 个点
  const since = buildRegimeSpecs(
    { series: { fng }, unavailable: [] },
    [{ ...high, percentile: { riskTail: 'high', since: '2021-01-06' } }],
    '1D',
  );
  const line = since.find((s) => s.key === 'fng') as { data: unknown[]; refLines?: Array<{ price: number }> };
  expect(line.data).toHaveLength(11);
  expect(line.refLines?.[0].price).toBe(52.5);
  expect(regimePercentiles({ series: { fng }, unavailable: [] }, [high])).toEqual({ fng: 'P95' });
});

test('蜡烛用 ohlc 出 spec;符号柱正绿负红、0 基线,不套分位徽标', () => {
  const ohlc = {
    usd: [
      { time: '2021-01-04', open: 89, high: 90, low: 88, close: 89.5 },
      { time: '2021-01-05', open: 89.5, high: 91, low: 89, close: 90.8 },
    ],
  };
  const candle: PaneSpec = { key: 'usd', label: 'DXY', title: 'DXY', render: { kind: 'candle' } };
  const specs = buildRegimeSpecs({ series: { usd: [] }, unavailable: [], ohlc }, [candle], '1D');
  expect(specs.map((s) => (s as { kind: string }).kind)).toEqual(['candle']);

  const series = {
    cftcJpy: [
      { date: '2021-01-01', value: 2 },
      { date: '2021-01-02', value: -1.5 },
    ],
  };
  const signed: PaneSpec = { key: 'cftcJpy', label: '净持仓', title: '净持仓', render: { kind: 'signed' } };
  const [h] = buildRegimeSpecs({ series, unavailable: [] }, [signed], '1D') as Array<{
    kind: string;
    baseline?: number;
    data: Array<{ color: string }>;
  }>;
  expect(h.kind).toBe('histogram');
  expect(h.baseline).toBe(0);
  expect(h.data.map((d) => d.color)).toEqual(['#22c55e', '#ef4444']);
  expect(regimePercentiles({ series, unavailable: [] }, [signed]).cftcJpy).toBeUndefined();
});

test('derivePaneMeta:每格一条线,名字 / 颜色 / 说明按 key 取', () => {
  const meta = derivePaneMeta([{ ...PANES[0], desc: '说明' }, PANES[3]]);
  expect(meta.paneDefs).toEqual([
    { key: 'netLiquidity', label: '净流动性', series: ['netLiquidity'] },
    { key: 'repoStress', label: '回购压力', series: ['repoStress'] },
  ]);
  expect(meta.colors).toEqual({ netLiquidity: '#22c55e' });
  expect(meta.desc).toEqual({ netLiquidity: '说明' });
});

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

// 面板的格子按 source 分派(见 SOURCE_PANES)。这条锁住「加了非 SEC 源的公司,
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

  expect(cloudPane('GOOGL').label).toBe('capex/Google Cloud');
  expect(cloudPane('AMZN').label).toBe('capex/AWS');
  expect(cloudPane('ORCL').label).toBe('capex/OCI IaaS');

  // 比率的判据线是 1.0(当季 capex 恰好等于当季云收入),不是 0。
  expect(cloudPane('AMZN').render).toEqual({ kind: 'line', baseline: 1 });
  // 分子分母口径不同 —— 这条警告不在,读的人会当成「云业务的投入产出比」。
  expect(cloudPane('AMZN').desc).toContain('不是一门生意的投入产出比');

  for (const t of ['MSFT', 'META']) {
    expect(dimPanes(`fundamentals:${t}`).some((p) => /capexCloud/.test(p.key))).toBe(false);
  }
});

test('dimPanes:TSM 的金额格用新台币,别家用美元', () => {
  const money = (dim: string, key: string) => dimPanes(dim as never).find((p) => p.key === key)!;

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

  const note = secTrimNote(data, dimPanes('fundamentals:NVDA'));
  expect(note).toContain('少 5 点');
  expect(note).toContain('2021-01-31 → 2023-10-29');
  expect(note).not.toContain('33'); // 别家的不混进来
});

test('secTrimNote:没裁过就不出提示', () => {
  expect(secTrimNote({ series: {}, unavailable: [] }, dimPanes('fundamentals:NVDA'))).toBeUndefined();
  expect(secTrimNote({ series: {}, unavailable: [], secTrim: [] }, dimPanes('fundamentals:NVDA'))).toBeUndefined();
});

// 类型已经挡住「pane key 拼错」了(PaneSpec.key 收窄成 SeriesKey),这两条守的是**另一半**:
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

// RegimeChart 要求配置引用稳定:基本面维度的 panes 按名单现算,靠 regimeView 的缓存兜住
test('regimeView:同一 dim 每次拿到同一个对象', () => {
  expect(regimeView('fundamentals:NVDA')).toBe(regimeView('fundamentals:NVDA'));
  expect(regimeView('fundamentals:NVDA').panes).toBe(dimPanes('fundamentals:NVDA'));
});
