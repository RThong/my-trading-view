// regime 视图(各视角共用)的数据层:取数 + pane 配置的类型 + spec 构造。
// 各 dim 的 pane 配置按视角放在 pages/<视角>/dims.ts,汇总与 dim → panes 查表在 pages/regimeDims.ts(视图不反向依赖页面)。
// 图表引擎(usePaneChart/usePaneLayout/useCrosshairLegend)与展示壳(PaneChartView)全复用期权侧。
import useSWR from 'swr';
import { useServerRefresh } from '../../hooks/useServerRefresh';
import { aggregate, aggregateBars, type LinePoint, type Bar } from '../../chart/core';
import { percentile, percentileRank } from '../../../shared/calc/stats';
import type { SeriesKey } from '../../../shared/regimeSeries';
import type { Interval } from '../../hooks/interval';
import type { PaneDef, LineSpec, HistoSpec, HistoPoint, Spec } from '../../chart/paneChart.types';
import { rollMismatchDates, type RollMismatchKind } from '../../../shared/calc/oilRoll';
import type { Calc, ChartDoc, RefLine } from '../chartDoc/chartDoc';
import { seriesDef, seriesLabel } from '../chartDoc/registry';
import { isAggregateMember, type FundTrim, type SecFiled, type SecLag } from '../../../shared/aiChain';
import { getJson, SWR_OPTS } from '../../lib/http';

// 分位带阈值(自身历史):想改 5/95 更严就动这里。
const PCTL_LO = 5;
const PCTL_HI = 95;
// 极端期背景带的半透明色:风险端红、机会端绿(方向由各序列 riskTail 决定)。
const BG_RED = 'rgba(239,68,68,0.45)';
const BG_GREEN = 'rgba(34,197,94,0.45)';
const BG_NONE = 'rgba(0,0,0,0)';
// 期货错月背景:中性灰蓝,刻意不与红 / 绿(风险 / 机会)同色系;画在分位带下层。
// 刻意调淡:错月偏差平时只有线本身波动的零头,这是「在这里算涨跌 / 市场紧时多看一眼」的提醒,
// 不是「这段数据不能用」—— 0.28 时全历史视图满屏条纹,读起来像大半数据都坏了。
const BG_ROLL = 'rgba(148,163,184,0.14)';
// 符号柱状图(期限结构):正=backwardation 绿、负=contango 红。
const SIGNED_UP = '#22c55e';
const SIGNED_DOWN = '#ef4444';
export type RegimePoint = { date: string; value: number };
export type RegimeData = {
  series: Record<string, RegimePoint[]>;
  unavailable: string[];
  /** 本次现拉失败、服务端用上一份成功数据顶上的序列(面板标「沿用上次」)。 */
  fallback?: string[];
  /** 服务端缓存过期、后台刷新中(见 server/routes/swrCache):先给的是旧数据。 */
  refreshing?: boolean;
  /** 服务端缓存值不完整(有源没拉到,等重试)。 */
  partial?: boolean;
  ohlc?: Record<string, Bar[]>;
  secLag?: SecLag[];
  secTrim?: FundTrim[];
  /** 每家最新一期的期末与申报日(ticker → …),见 storage/repository 的 getSecLatestFiled。 */
  secFiled?: Record<string, SecFiled>;
};
const NO_DATA: RegimeData = { series: {}, unavailable: [] }; // 稳定空引用,避免 render 抖动
/** 三个 regime 视角共用;SWR 按 URL 去重,只发一次 /api/regime。 */
/** enabled = false 时不发请求(图表编辑器图上没用到 regime 序列时,不拉这份大响应)。 */
export function useRegimeData(enabled = true) {
  const {
    data = NO_DATA,
    error,
    isLoading,
    mutate,
  } = useSWR(enabled ? '/api/regime' : null, getJson<RegimeData>, SWR_OPTS);
  useServerRefresh('/api/regime', data, mutate);
  return { data, error: error as Error | undefined, isLoading };
}
export type RegimeDim =
  | 'credit'
  | 'liquidity'
  | 'sentiment'
  | 'macro'
  | 'ism'
  | 'vol'
  | 'ratesVol'
  | 'inflSource'
  | 'policyRepricing'
  | 'ratesDecomp'
  | 'jpy'
  | 'jgbVol'
  | 'jpBanks'
  | 'jpInflation'
  | 'jpGap'
  | 'jpTermPremium'
  | 'valuation'
  | 'concentration'
  | 'oil'
  | 'refinery'
  | 'pump'
  | 'btc'
  | 'btcOnchain'
  | 'compute'
  // 基本面按启用名单派生:一家一个 dim(三格),外加一条买方合计。见 dimPanes / companyPanes。
  | `fundamentals:${string}`;
/** 固定维度(配置写死那些);基本面维度是按名单派生的,不进这张表。 */
export type FixedDim = Exclude<RegimeDim, `fundamentals:${string}`>;
// 每个 pane 自带完整定义:单一 key 既是 pane 身份,也是 data.series[key]/data.ohlc[key] 的数据键。
// 取代原来 ~10 张按同一 key 索引的平行 map(paneDefs/seriesName/colors/baseline/riskTail/
// signed/candle/pctlSince/bands/desc)——避免 key desync 与"signed 却忘配颜色"这类不可表达状态。
/** 计算格的身份键(「A|运算|B」,见 docToPaneSpecs):只有 ChartDoc 里的计算图层会生成这种键。 */
export type CalcPaneKey = `${string}|${string}|${string}`;

export type PaneSpec = {
  /** 既是 pane 身份,也是 data.series[key] 的数据键 —— 收窄成后端对外名的全集,拼错即编译错误。 */
  key: SeriesKey | CalcPaneKey;
  /**
   * 计算格:这一格的数不读服务端的 key,而是前端按注册表取两条腿现算「series 运算 calc.series」
   * (写法同 ChartDoc 图层,两条腿都是注册表 id;算好填回 data.series[key],见 RegimeChart)。
   * 手写的格子用它时 key 仍是原来的派生名(格子顺序 / 折叠的存档按 key 认,不丢)。
   */
  from?: { series: string; calc: Calc };
  label: string; // 工具条 chip 名
  title: string; // 图例 / 命名
  color?: string; // 线色 / 图例色;符号柱与部分蜡烛不需要(留空则图例用默认色)
  desc?: string; // hover ⓘ 说明(谦虚版读法)
  render?: // 图形,默认 line
  // baseline:会穿零的序列画 0 基线(如回购压力 / YoY)。step:低频序列画阶梯(季频 r*),见 LineSpec.step
    | { kind: 'line'; baseline?: number; step?: boolean }
    | { kind: 'signed' } // 符号柱状图(正绿负红,0 基线),不套分位/徽标
    | { kind: 'candle' }; // 蜡烛(用 data.ohlc[key]),不套分位/背景带;价格轴线性/对数按数据自判
  /** 参考线:有绝对含义的阈值(常态带用 normalBand,如供应密度的警戒 / 高风险就自己写)。配了它,percentile 只染背景 */
  refLines?: RefLine[];
  /** 轴至少覆盖这段(见 LineSpec.expandVisibleTo):让 refLines 在数据还没走到时也看得见。 */
  expandVisibleTo?: [number, number];
  /**
   * 价格轴上限框 `[lo, hi]`(见 LineSpec.clampVisibleTo):只夹轴,不改数据。
   * 给「日常很窄 + 真实极端单点」的格子用;**有 overlay 时两条线都要夹** —— 同 pane 共用一条轴,
   * 只夹主线的话 overlay 的极值照样把整幅撑开。
   */
  clampVisibleTo?: [number, number];
  percentile?: { riskTail?: 'low' | 'high'; since?: string }; // 有=画 P5/P95+徽标;riskTail 决定背景带红/绿方向;since 限定分位窗口
  /**
   * 同格叠画的其它线。给「几个量只能并排读、不能相减」的格子用(见 A vs L 缺口):
   * 相减成单序列会把「谁在上面」这个稳健信息,换成一个不可识别的量级。
   * 也给「总量 + 各项贡献度」这种同尺分解用(日银潜在增速那格,四项相加 ≈ 总量)。
   * 主 key 缺失 → 整格不建;某条 overlay 自己缺失 → 只少那条线,主线照画。
   */
  overlays?: { key: SeriesKey; title: string; color: string; step?: boolean; hidden?: boolean }[];
  /** 事件竖线:序列里每个点的日期画一根满高细柱(发布日这类「哪天发生」的标记,值不画)。 */
  events?: { key: SeriesKey; title: string; color: string }[];
  /** 两条期货腿相减的格子:灰蓝背景标出合约月份对不上的日子(见 shared/calc/oilRoll)。 */
  rollMismatch?: RollMismatchKind;
};
export type DimConfig = { panes: PaneSpec[] };
/** 一个 regime 图要的全部配置:dim(存储键 / SEC 提示按它认公司)与它的 panes 绑在一起传,不会配错对。 */
export type RegimeView = { dim: RegimeDim; panes: PaneSpec[] };
/** 一个视角贡献的那几个 dim 的配置(pages/<视角>/dims.ts 用 satisfies 对齐)。 */
export type RegimeDims = Partial<Record<Exclude<FixedDim, DocDim>, DimConfig>>;
/**
 * 已迁成 ChartDoc 的 tab(与图表编辑器同一格式,序列引注册表 id;见 ./docs)。
 * 逐 tab 往这里挪:挪一个,就从 pages/regimeDims 的 REGIME_DIMS 删掉对应的手写 panes —— 两边同时有,类型会报错。
 */
export type DocDim = 'concentration';

/**
 * ChartDoc → 固定面板的格子定义。图层的序列 id 经注册表解析成 /api/regime 的键,下游(渲染规格、分位徽标、
 * 缺失提示)照旧按格子走。目前只支持「一格一条 regime 序列」(已迁的 tab 都是这种);不符合就是 doc 写错了,
 * 直接抛 —— 模块加载时就炸,不会静默少一格或静默不照画。叠加线 / 事件线 / 蜡烛等等迁到用它们的 tab 时再加。
 */
export function docToPaneSpecs(doc: ChartDoc): PaneSpec[] {
  const panes = doc.panes.map((p): PaneSpec => {
    if (p.layers.length !== 1) throw new Error(`ChartDoc 格 ${p.id}:固定面板目前只支持一格一条线`);
    const [l] = p.layers;
    const def = seriesDef(l.series);
    // 普通图层读 /api/regime 的现成键;计算图层两条腿按注册表取数现算,只要都在注册表里
    const legsOk = l.calc ? !!def && !!seriesDef(l.calc.series) : def?.source.kind === 'regime';
    if (!def || !legsOk)
      throw new Error(
        `ChartDoc 图层 ${l.id}:${l.series}${l.calc ? ` / ${l.calc.series}` : ''} 不在注册表里或不是 /api/regime 的序列`,
      );
    // 固定面板画不了的设定:写了却不照画比报错更糟(看图的人以为生效了)。
    // 格高(stretch)不在此列(用户定):只关乎好不好看、不影响读数,固定面板各格一律等高,高度靠折叠 / 展开调
    const scale = p.scales.find((sc) => sc.id === l.scale);
    if (l.shift || l.fit || l.scale !== 'right' || scale?.invert || scale?.log)
      throw new Error(`ChartDoc 图层 ${l.id}:固定面板只画右轴原值,不支持平移 / 叠加 / 左轴 / 独立轴 / 倒轴 / 对数`);

    const name = seriesLabel(l.series, l.calc);
    return {
      key: l.calc
        ? (`${l.series}|${l.calc.op}${l.calc.fill ? 'f' : ''}|${l.calc.series}` as const)
        : (def.source as { key: SeriesKey }).key,
      ...(l.calc && { from: { series: l.series, calc: l.calc } }),
      label: p.label ?? name,
      title: l.title ?? name,
      color: l.color,
      ...(p.desc !== undefined && { desc: p.desc }),
      ...(l.render && { render: l.render }),
      ...(l.refLines && { refLines: l.refLines }),
      ...(l.percentile && { percentile: l.percentile }),
    };
  });

  // 格子按序列键做身份(说明 / 名称 / 配色的表、图上的线都按键存):同一序列占两格,后一格会悄悄盖掉前一格
  const dup = panes.map((p) => p.key).find((k, i, keys) => keys.indexOf(k) !== i);
  if (dup) throw new Error(`ChartDoc:序列 ${dup} 出现在不止一格,固定面板一格对应一条序列`);

  return panes;
}
/** 从 panes[] 派生 PaneChartView 需要的平行 map(pane 定义 / 命名 / 配色 / 说明)。 */
export function derivePaneMeta(panes: PaneSpec[]) {
  return {
    paneDefs: panes.map((p) => ({
      key: p.key,
      label: p.label,
      series: [p.key, ...(p.overlays ?? []).map((o) => o.key)],
    })) as PaneDef[],
    seriesName: Object.fromEntries(
      panes.flatMap((p) => [
        [p.key, p.title],
        ...(p.overlays ?? []).map((o) => [o.key, o.title]),
        ...(p.events ?? []).map((e) => [e.key, e.title]),
      ]),
    ),
    colors: Object.fromEntries(
      panes.flatMap((p) => [
        ...(p.color ? [[p.key, p.color]] : []),
        ...(p.overlays ?? []).map((o) => [o.key, o.color]),
      ]),
    ),
    desc: Object.fromEntries(panes.flatMap((p) => (p.desc ? [[p.key, p.desc]] : []))),
  };
}
function toLine(rows: RegimePoint[]): LinePoint[] {
  return rows.map((r) => ({ time: r.date, value: r.value }));
}
/** 一序列一 pane:pane 下标 = panes 索引;缺失的序列(unavailable)不建 spec,该 pane 留空。
 *  percentile 的 pane:按原始日频值算 P5/P95 作参考线(与显示 interval 无关)。 */
export function buildRegimeSpecs(data: RegimeData, panes: PaneSpec[], interval: Interval): Spec[] {
  return panes.flatMap((p, pane): Spec[] => {
    const key = p.key;
    if (data.unavailable.includes(key)) return []; // unavailable 权威:不建 spec
    const render = p.render ?? { kind: 'line' as const };

    // 蜡烛:用 ohlc(按 interval 聚合 OHLC),涨绿跌红(addSeries 内置)。不套分位/背景带。
    if (render.kind === 'candle') {
      const bars = data.ohlc?.[key];
      if (!bars?.length) return [];
      return [{ key, pane, kind: 'candle', title: p.title, data: aggregateBars(bars, interval) }];
    }

    const rows = data.series[key];
    if (!rows) return [];
    const line = aggregate(toLine(rows), interval);

    // 符号柱状图(期限结构):正绿负红、0 基线,不套分位带/徽标。
    if (render.kind === 'signed') {
      const bars: HistoPoint[] = line.map((pt) => ({
        time: pt.time,
        value: pt.value,
        color: pt.value >= 0 ? SIGNED_UP : SIGNED_DOWN,
      }));
      return [{ key, pane, kind: 'histogram', title: p.title, data: bars, baseline: 0 }];
    }

    const lineSpec: LineSpec = {
      key,
      pane,
      kind: 'line',
      color: p.color ?? '#a3a3a3',
      title: p.title,
      data: line,
      ...(render.baseline !== undefined ? { baseline: render.baseline } : {}),
      ...(render.step ? { step: true } : {}),
      ...(p.clampVisibleTo ? { clampVisibleTo: p.clampVisibleTo } : {}),
      ...(p.expandVisibleTo ? { expandVisibleTo: p.expandVisibleTo } : {}),
    };
    if (p.refLines) lineSpec.refLines = p.refLines;

    // 叠画的其它线(同 pane 下标)。某条 overlay 缺失只少那条,主线照画。
    // 有 overlay 的格子刻意不配 percentile:多条线并排读的是「谁在上面」,给其中一条套分位带
    // 会把视觉重心压回单条线上。
    const overlaySpecs: LineSpec[] = (p.overlays ?? [])
      .filter((o) => !data.unavailable.includes(o.key) && data.series[o.key]?.length)
      .map((o) => ({
        key: o.key,
        pane,
        kind: 'line',
        color: o.color,
        title: o.title,
        data: aggregate(toLine(data.series[o.key]), interval),
        ...(o.step ? { step: true } : {}),
        ...(o.hidden ? { hidden: true } : {}),
        // 同 pane 共用一条价格轴 → 框必须每条都夹,否则 overlay 的极值照样撑开整幅。
        ...(p.clampVisibleTo ? { clampVisibleTo: p.clampVisibleTo } : {}),
      }));

    // 事件竖线:各自一条独立 overlay 轴(同 bg 带的画法),先建 → 画在线的下层。
    // 裁到主线的起点:竖线比主线早开始的话,时间轴会给那段只有竖线的日子留位置,把主线挤到一边。
    const eventSpecs: HistoSpec[] = (p.events ?? [])
      .filter((e) => data.series[e.key]?.length)
      .map((e) => ({
        key: `${key}-ev-${e.key}`,
        pane,
        kind: 'histogram',
        title: '',
        data: data.series[e.key]
          .filter((r) => r.date >= rows[0].date)
          .map((r) => ({ time: r.date, value: 1, color: e.color })),
        priceScaleId: `ev-${e.key}`,
      }));
    // 错月背景:按原始日频逐日判定(同分位带,与显示 interval 无关);最先建 → 在最底层,分位红 / 绿压在它上面。
    const mismatch =
      p.rollMismatch &&
      rollMismatchDates(
        rows.map((r) => r.date),
        p.rollMismatch,
      );
    const rollSpecs: HistoSpec[] = mismatch
      ? [
          {
            key: `${key}-roll`,
            pane,
            kind: 'histogram',
            title: '',
            // 每个交易日都要有点(非错月日填透明):各格共享时间轴按点排位,只放错月日的话
            // 1W / 1M 下主线已聚合成稀疏点,错月段会被撑得不成比例(同分位背景带的做法)
            data: rows.map((r) =>
              mismatch.has(r.date)
                ? { time: r.date, value: 1, color: BG_ROLL }
                : { time: r.date, value: 0, color: BG_NONE },
            ),
            priceScaleId: `roll-${key}`,
          },
        ]
      : [];
    if (!p.percentile) return [...rollSpecs, ...eventSpecs, lineSpec, ...overlaySpecs];

    // 分位:P5/P95 参考线用原始日频算(与显示 interval 无关);极端期画满高背景带。
    // since 给了则只用该子窗口算阈值(线仍画全部 rows);阈值再铺回整条线。
    const since = p.percentile.since;
    const vals = (since ? rows.filter((r) => r.date >= since) : rows).map((r) => r.value);
    const lo = percentile(vals, PCTL_LO);
    const hi = percentile(vals, PCTL_HI);
    // **配了参考线就不画 P5/P95**:两者都配时不覆盖。
    // 覆盖过一次 —— 库存季节 z 两格同时配了常态带 ±2 和 percentile,结果图上画的是 P5/P95,
    // 那条常态带是彻底的死配置;同屏另外两格 z 却画着 ±2,读者对着两套尺互相串读。
    // 现在的分工:**参考线由 refLines 定(有绝对含义时),背景带仍由 percentile 染**(见 riskTail)。
    if (!lineSpec.refLines)
      lineSpec.refLines = [
        { price: lo, title: `P${PCTL_LO}` },
        { price: hi, title: `P${PCTL_HI}` },
      ];
    const risk = p.percentile.riskTail;
    // 背景带 = 风险/机会信号,需已知风险端;无 riskTail(如 10Y 收益率,高低方向不单一)只留 P5/P95 线,不染背景。
    if (risk === undefined) return [...rollSpecs, ...eventSpecs, lineSpec, ...overlaySpecs];
    // 背景带按原始日频逐日判定极端(不用聚合点),保证与显示 interval 无关。
    const bgData: HistoPoint[] = rows.map((r) => {
      if (r.value < lo) return { time: r.date, value: 1, color: risk === 'low' ? BG_RED : BG_GREEN };
      if (r.value > hi) return { time: r.date, value: 1, color: risk === 'high' ? BG_RED : BG_GREEN };
      return { time: r.date, value: 0, color: BG_NONE };
    });
    const bgSpec: HistoSpec = {
      key: `${key}-bg`,
      pane,
      kind: 'histogram',
      title: '',
      data: bgData,
      priceScaleId: `bg-${key}`,
    };
    return [...rollSpecs, ...eventSpecs, bgSpec, lineSpec, ...overlaySpecs]; // bg 先建 → 画在线的下层
  });
}
/**
 * 「公司已申报、SEC 还没提供那一期」的滞后提示(基本面维度专用)。
 *
 * 判据**不看期末日期差** —— 各家财年季末天然错开两三个月(实测 NVDA 的最新期落后 AMZN 整季
 * 是正常的:它下一季 8 月底才申报),日期差分不清「还没到财报期」和「交了但 SEC 没吃进」。
 * 只有后端拿 submissions 的 filed 与库里 MAX(filed) 比出来的才是确定结论,即 data.secLag。
 *
 * 为什么必须显示:滞后时那条线的末端是三个月前的读数,而这组判据全在读「最新一季转没转负」,
 * 不标注就会把旧点当成最新(实测 META 停在 2026Q1 的 +13.2B,而 Q2 实际是 +1.7B)。
 * 合计那格是**全员齐才出点**,任何一家滞后都顶住整条线的末端,故照样提示。
 */
export function secLagNote(data: RegimeData, dim: RegimeDim): string | undefined {
  if (!data.secLag?.length || !dim.startsWith('fundamentals:')) return undefined;

  const who = dim.slice('fundamentals:'.length);
  const mine = data.secLag.filter((l) => (who === 'buyer' ? isAggregateMember(l.ticker) : l.ticker === who));
  if (!mine.length) return undefined;

  const one = (l: SecLag) => `${l.ticker} 截至 ${l.latestPeriodEnd ?? '无数据'}(${l.remoteFiled} 已申报,SEC 未提供)`;
  return `⚠️ 数据滞后:${mine.map(one).join(';')}`;
}
/**
 * 单家公司 tab 的「最新一期 + 申报日」(工具条末尾那行)。季频线看不出末端是不是刚发的那季。
 * 合计 tab 不标(多家拼的,dim 不是 ticker,查不到)。
 */
export function secFiledNote(data: RegimeData, dim: RegimeDim): string | undefined {
  const f = dim.startsWith('fundamentals:') ? data.secFiled?.[dim.slice('fundamentals:'.length)] : undefined;
  return f && `截至 ${f.periodEnd} · ${f.filed} 申报`;
}
/**
 * 「这一格被断档裁短了」的提示。**裁剪本身是对的,静默才是问题**。
 *
 * 折线只连点,断档两端会被连成一条斜率是编的直线,而这组判据全在读斜率 —— 所以必须裁。
 * 但裁完不说,用户看到的只是一条短线,分不清是「这家上市晚」还是「中间缺了几个季度、
 * TTM 因为凑不满四季而整段作废」。实测量级足以误导:AMZN capex 66 点裁到 33、
 * NVDA 16 裁到 11、买方合计 40 裁到 33。
 *
 * 缺口的成因在源侧(companyfacts 那几期压根没有 capex 行,补 tag 链没用),所以
 * **只在这里说,不在 job 里报警** —— 那会是一盏永远修不掉的常驻黄灯。
 */
export function secTrimNote(data: RegimeData, panes: PaneSpec[]): string | undefined {
  if (!data.secTrim?.length) return undefined;

  const keys = new Set(panes.map((p) => p.key));
  const mine = data.secTrim.filter((t) => keys.has(t.key));
  if (!mine.length) return undefined;

  const label = (key: string) => panes.find((p) => p.key === key)?.label ?? key;
  const one = (t: FundTrim) => `${label(t.key)} 少 ${t.dropped} 点(断在 ${t.gapFrom} → ${t.gapTo})`;

  return `⚠️ 已裁断档:${mine.map(one).join(';')}`;
}
/** 各序列最新值在自身历史里的百分位(徽标用,如 { cor1m: 'P3' })。仅 percentile 的 pane 产出。 */
export function regimePercentiles(data: RegimeData, panes: PaneSpec[]): Record<string, string> {
  return Object.fromEntries(
    panes.flatMap((p) => {
      if (!p.percentile) return []; // 无分位 pane(含 signed / candle)无徽标
      if (data.unavailable.includes(p.key)) return [];
      const rows = data.series[p.key];
      if (!rows?.length) return [];
      // 徽标 = 最新值在分位窗口内的排名(since 给了就只对子窗口排,与 buildRegimeSpecs 阈值同源)。
      const since = p.percentile.since;
      const base = since ? rows.filter((r) => r.date >= since) : rows;
      const rank = percentileRank(
        base.map((r) => r.value),
        rows[rows.length - 1].value,
      );
      return Number.isNaN(rank) ? [] : [[p.key, `P${rank}`]];
    }),
  );
}
