import { test, expect } from 'bun:test';
import {
  buildRegimeSpecs,
  dimPanes,
  regimePercentiles,
  secLagNote,
  secTrimNote,
  type RegimeData,
} from './regimeChart.hooks';
import { ACTIVE_TICKERS, fundKey, kindsOf } from '../../../shared/aiChain';

const data: RegimeData = {
  series: {
    netLiquidity: [
      { date: '2020-01-01', value: 5 },
      { date: '2020-01-02', value: 6 },
    ],
    reverseRepo: [{ date: '2020-01-01', value: 2 }],
    // repoUsage 缺失(模拟 unavailable)
    repoStress: [{ date: '2020-01-01', value: -0.01 }],
  },
  unavailable: ['repoUsage'],
};

test('流动性维度:pane 下标按 paneDefs 顺序,缺失序列被跳过', () => {
  const specs = buildRegimeSpecs(data, 'liquidity', '1D');
  // 4 个 paneDef,repoUsage 缺 → 只出 3 条 spec
  expect(specs.map((s) => s.key)).toEqual(['netLiquidity', 'reverseRepo', 'repoStress']);
  // pane 下标 = 原 paneDefs 索引(repoUsage 是第 2,被跳过后 repoStress 仍是 3)
  expect(specs.map((s) => s.pane)).toEqual([0, 1, 3]);
});

test('repoStress 带 0 基线,其余无', () => {
  const specs = buildRegimeSpecs(data, 'liquidity', '1D');
  const byKey = Object.fromEntries(specs.map((s) => [s.key, s]));
  expect((byKey.repoStress as { baseline?: number }).baseline).toBe(0);
  expect((byKey.netLiquidity as { baseline?: number }).baseline).toBeUndefined();
});

test('全部缺失 → 空 specs', () => {
  expect(buildRegimeSpecs({ series: {}, unavailable: [] }, 'sentiment', '1D')).toEqual([]);
});

test('情绪维度:分位带 + 极端期背景带按 riskTail 语义上色', () => {
  // fng 0..100 步长 10,共 11 点 → P5=5、P95=95。fng riskTail=high:高端=风险(红)、低端=机会(绿)。
  const fng = Array.from({ length: 11 }, (_, i) => ({
    date: `2021-01-${String(i + 1).padStart(2, '0')}`,
    value: i * 10,
  }));
  const specs = buildRegimeSpecs({ series: { fng }, unavailable: [] }, 'sentiment', '1D');

  // 每个有数据的 pane 出 [背景直方图, 线] 两条;这里只有 fng
  expect(specs.map((s) => s.key)).toEqual(['fng-bg', 'fng']);

  const line = specs[1] as { refLines?: { price: number; title: string }[] };
  expect(line.refLines).toEqual([
    { price: 5, title: 'P5' },
    { price: 95, title: 'P95' },
  ]);

  const bg = specs[0] as { data: Array<{ value: number; color: string }>; priceScaleId?: string };
  expect(bg.priceScaleId).toBe('bg-fng');
  expect(bg.data[0]).toMatchObject({ value: 1, color: 'rgba(34,197,94,0.45)' }); // 值0 < P5,低端=机会=绿
  expect(bg.data[10]).toMatchObject({ value: 1, color: 'rgba(239,68,68,0.45)' }); // 值100 > P95,高端=风险=红
  expect(bg.data[5].value).toBe(0); // 值50 不极端 → 无柱
});

test('candle 维度:标 candle 的序列用 ohlc 出蜡烛 spec', () => {
  const ohlc = {
    usd: [
      { time: '2021-01-04', open: 89, high: 90, low: 88, close: 89.5 },
      { time: '2021-01-05', open: 89.5, high: 91, low: 89, close: 90.8 },
    ],
  };
  const specs = buildRegimeSpecs({ series: { usd: [] }, unavailable: [], ohlc }, 'macro', '1D');
  expect(specs.map((s) => s.key)).toEqual(['usd']);
  expect((specs[0] as { kind: string }).kind).toBe('candle');
  expect((specs[0] as { data: unknown[] }).data.length).toBe(2);
});

test('percentiles 维度里无 riskTail 的序列不画背景带(方向不单一,只留 P5/P95 线)', () => {
  const dgs10 = Array.from({ length: 21 }, (_, i) => ({ date: `2021-01-${String(i + 1).padStart(2, '0')}`, value: i }));
  const specs = buildRegimeSpecs({ series: { dgs10 }, unavailable: [] }, 'ratesVol', '1D');
  expect(specs.map((s) => s.key)).toEqual(['dgs10']); // 无 dgs10-bg 背景带
  const line = specs[0] as { kind: string; refLines?: unknown[] };
  expect(line.kind).toBe('line');
  expect(line.refLines).toHaveLength(2); // P5/P95 参考线仍在
});

test('期限结构:符号柱状图(正绿负红、0基线),不套分位带/徽标', () => {
  const vxTermSpread = [
    { date: '2021-01-01', value: 2 }, // 正 → 绿
    { date: '2021-01-02', value: -1.5 }, // 负 → 红
  ];
  const specs = buildRegimeSpecs({ series: { vxTermSpread }, unavailable: [] }, 'vol', '1D');
  expect(specs.map((s) => s.key)).toEqual(['vxTermSpread']); // 单条 histo,无 bg/line 对
  const h = specs[0] as {
    kind: string;
    baseline?: number;
    refLines?: unknown;
    data: Array<{ value: number; color: string }>;
  };
  expect(h.kind).toBe('histogram');
  expect(h.baseline).toBe(0);
  expect(h.refLines).toBeUndefined();
  expect(h.data[0].color).toBe('#22c55e'); // 正=绿
  expect(h.data[1].color).toBe('#ef4444'); // 负=红
  // 无分位徽标
  expect(regimePercentiles({ series: { vxTermSpread }, unavailable: [] }, 'vol').vxTermSpread).toBeUndefined();
});

test('jgbVol:jgb10y 无 riskTail → 无背景带', () => {
  const jgb10y = [
    { date: '2020-01-01', value: 0.1 },
    { date: '2020-01-02', value: 0.12 },
  ];
  const specs = buildRegimeSpecs({ series: { jgb10y }, unavailable: [] }, 'jgbVol', '1D');
  expect(specs.map((s) => s.key)).toEqual(['jgb10y']); // 无 jgb10y-bg
});

test('jgbVol:jgbVix 有 riskTail → 带背景带', () => {
  const jgbVix = [
    { date: '2020-01-01', value: 2 },
    { date: '2020-01-02', value: 3 },
  ];
  const specs = buildRegimeSpecs({ series: { jgbVix }, unavailable: [] }, 'jgbVol', '1D');
  expect(specs.map((s) => s.key)).toEqual(['jgbVix-bg', 'jgbVix']);
});

test('valuation:cape 有 riskTail high → 带背景带', () => {
  const cape = [
    { date: '2020-01-01', value: 30 },
    { date: '2020-02-01', value: 42 },
  ];
  const specs = buildRegimeSpecs({ series: { cape }, unavailable: [] }, 'valuation', '1D');
  expect(specs.map((s) => s.key)).toEqual(['cape-bg', 'cape']);
});

test('valuation:cape 分位只用 pctlSince(2000+)窗口,线仍画全部', () => {
  // 1995 的极低值不该进分位(会把 P5 拉到 10);2000+ 三点才算分位。
  const cape = [
    { date: '1995-01-01', value: 10 },
    { date: '2000-01-01', value: 30 },
    { date: '2000-02-01', value: 40 },
    { date: '2000-03-01', value: 50 },
  ];
  const specs = buildRegimeSpecs({ series: { cape }, unavailable: [] }, 'valuation', '1D');
  const line = specs.find((s) => s.key === 'cape')!;
  expect(line.data.length).toBe(4); // 线画全部 4 点(含 1995)
  const refLines = (line as { refLines: { price: number; title: string }[] }).refLines;
  const p5 = refLines.find((r) => r.title === 'P5')!.price;
  expect(p5).toBeGreaterThanOrEqual(30); // 分位不含 1995 的 10 → P5 落在 2000+ 区间

  // 徽标分位:最新值 50 只对 2000+ 三点(中位排名 =(3−0.5)/3=P83)排名,不被 1995 稀释
  // (含 1995 会是 4 点 → P88,借此证明窗口生效)
  const pctls = regimePercentiles({ series: { cape }, unavailable: [] }, 'valuation');
  expect(pctls.cape).toBe('P83');
});

// SEC 滞后提示:判据只认后端算好的 secLag,不做任何日期差推断(各家财年季末天然错开)。
const LAG = { ticker: 'META', remoteFiled: '2026-07-30', localFiled: '2026-04-30', latestPeriodEnd: '2026-03-31' };
const withLag = (secLag: (typeof LAG)[]): RegimeData => ({ series: {}, unavailable: [], secLag });

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

// 分部格挂在「这家披露不披露」上,不挂在源上(同一个 sec 源下只有 GOOGL 报云收入)。
// 挂错会给其余四家买方各加一条永远空的线,而空线不报错。
test('dimPanes:capex/云收入只出现在 GOOGL,同源的 MSFT 没有', () => {
  const googl = dimPanes('fundamentals:GOOGL');
  const cloud = googl.filter((p) => p.key === 'fund:GOOGL:capexCloud');

  expect(cloud).toHaveLength(1); // 成员名改过 → SEGMENT_FACTS 里两条,面板上仍只有一格
  expect(cloud[0]!.label).toBe('capex/Google Cloud');
  // 比率的判据线是 1.0(当季 capex 恰好等于当季云收入),不是 0。
  expect(cloud[0]!.render).toEqual({ kind: 'line', baseline: 1 });
  // 分子分母口径不同 —— 这条警告不在,读的人会当成「云业务的投入产出比」。
  expect(cloud[0]!.desc).toContain('不是一门生意的投入产出比');

  expect(dimPanes('fundamentals:MSFT').some((p) => /capexCloud/.test(p.key))).toBe(false);
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

  const note = secTrimNote(data, 'fundamentals:NVDA');
  expect(note).toContain('少 5 点');
  expect(note).toContain('2021-01-31 → 2023-10-29');
  expect(note).not.toContain('33'); // 别家的不混进来
});

test('secTrimNote:没裁过就不出提示', () => {
  expect(secTrimNote({ series: {}, unavailable: [] }, 'fundamentals:NVDA')).toBeUndefined();
  expect(secTrimNote({ series: {}, unavailable: [], secTrim: [] }, 'fundamentals:NVDA')).toBeUndefined();
});

test('QQQ 现货是两个 tab 共用的同一份定义', () => {
  const [volQqq] = dimPanes('vol').filter((p) => p.key === 'qqq');
  const [sentQqq] = dimPanes('sentiment').filter((p) => p.key === 'qqq');

  // 断言「同一个对象引用」而不是「深相等」:这一格的存在意义就是不被抄成两份 ——
  // 深相等会放过「复制粘贴且内容恰好一样」,而那正是本仓库反复踩的「改一处漏一处」。
  expect(volQqq).toBeDefined();
  expect(sentQqq).toBe(volQqq);

  // 它是价格参照物不是判据:蜡烛 + 不套分位(套了会出徽标和红绿背景带,读成风险信号)。
  expect(volQqq?.render).toEqual({ kind: 'candle' });
  expect(volQqq?.percentile).toBeUndefined();
});

test('VIX6M:低位染红(riskTail low),缺数据则整格不出', () => {
  // 单调升序 → 首点在 P5 以下、末点在 P95 以上。riskTail 决定哪一端染红:
  // low 表示「低 = 压扁 = 自满 = 风险」,所以**低端红、高端绿**;写成 high 就正好反过来。
  // 只断言 refLines 有两条是不够的 —— 那对 low/high 都成立,改反了测试照绿。
  const vix6m = Array.from({ length: 30 }, (_, i) => ({
    date: `2021-01-${String(i + 1).padStart(2, '0')}`,
    value: 15 + i,
  }));
  const data = { series: { vix6m }, unavailable: [] };
  const specs = buildRegimeSpecs(data, 'vol', '1D');
  const bg = specs.find((s) => s.key === 'vix6m-bg') as { data: Array<{ color: string }> };
  const line = specs.find((s) => s.key === 'vix6m') as { refLines?: unknown[] };

  expect(line.refLines).toHaveLength(2); // P5/P95 —— 「这一段在自身历史什么位置」全靠它
  expect(bg.data[0].color).toBe('rgba(239,68,68,0.45)'); // 最低那天 < P5 → 风险端 = 红
  expect(bg.data.at(-1)?.color).toBe('rgba(34,197,94,0.45)'); // 最高那天 > P95 → 另一端 = 绿
  expect(regimePercentiles(data, 'vol').vix6m).toBeDefined();

  // 源缺失(CBOE 404 / 空 CSV)→ 那一格不出,不画空线
  expect(buildRegimeSpecs({ series: {}, unavailable: ['vix6m'] }, 'vol', '1D').some((s) => s.key === 'vix6m')).toBe(
    false,
  );
});
