// 期限走势图数据层:把某一期限的历史序列喂给图,按全局 interval 聚合。
// 纯函数在此,图表实例管理见下方 useTenorChart。
import { useEffect, useRef } from 'react';
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  PriceScaleMode,
  type IChartApi,
  type IPaneApi,
  type ISeriesApi,
  type Time,
} from 'lightweight-charts';
import { aggregate, aggregateBars, periodKey, CHART_OPTIONS, type Bar, type LinePoint } from '../../lib/chart';
import type { YPoint } from './yieldCurve.hooks';
import type { Interval } from '../../hooks/interval';
import { useStable } from '../../hooks/useStable';

// 各 source 的默认勾选期限(短/前端/中/长各取锚点)。
// treasury 前端用信息量更大的 2Y;OIS 档位对齐 Eris 真实点,12M 而非 1Y。
export const DEFAULT_TENORS: Record<string, string[]> = {
  // 美债 / JGB 默认只开**差值那两条腿**(1Y 与 10Y):这两格的主角是下方的 10Y−1Y,
  // 上面只需要它的两条腿好对着看。其余期限默认关掉 —— 六条线挤在一起反而看不出腿在动哪条。
  // 要看别的期限点一下就开,是用户侧状态,不必预置。
  treasury: ['1Y', '10Y'],
  sofr_ois: ['1M', '3M', '6M', '12M', '2Y', '10Y'],
  bei: ['5Y', '10Y', '30Y'],
  jgb: ['1Y', '10Y'],
  // AI CDS:默认展示除 Broadcom/Dell/Intel 外的 7 家(这三条较次要,留 chip 按需勾)。
  // 须与 rateCurves.ts AI_CDS 的 core 名单一致(core 缺失会让每日 job failed 告警)。
  ai_cds: ['Oracle', 'Microsoft', 'Alphabet', 'Amazon', 'Apple', 'Nvidia', 'Meta'],
};

/** 某期限的 {date,value}[] → 图用的 {time,value}[],按 interval 聚合。缺该期限 → []。 */
export function tenorSeriesData(rows: YPoint[] | undefined, interval: Interval): LinePoint[] {
  if (!rows) return [];
  return aggregate(
    rows.map((p) => ({ time: p.date, value: p.value })),
    interval,
  );
}

/**
 * 现货 bars({date,open,high,low,close}) → 图用 Bar[],按 interval 聚合。open/high/low 可能为 null。
 *
 * ⚠️ **只留周一~周五**:BTC 是 7×24,而这张图的主体(国债收益率)只有交易日。周末也放进来会给
 * 时间轴凭空多出约 900 根,1D 下超过图宽在最小 bar 间距能画的量 —— 实测默认视窗因此从 2018 起
 * 缩到 2020 年中,等于为两根周末柱子丢掉两年半的曲线历史(1W 及以上无此问题,聚合后根数够少)。
 * 代价:周末行情不单独成柱。这一格是**参照物**(利率在动时风险资产在哪),不是拿来交易 BTC 的。
 */
/** 只留周一~周五。**spotBars 与 spotVolume 必须共用这一个** —— 抄两份的话,
 *  哪天只改了一边,1W 及以上的量会把周末行加进周一桶而蜡烛不含它:总量静默对不上,不报错。 */
const weekdayOnly = <T extends { date: string }>(rows: T[]): T[] =>
  rows.filter((b) => {
    const dow = new Date(`${b.date}T00:00:00Z`).getUTCDay();
    return dow !== 0 && dow !== 6;
  });

export function spotBars(
  rows:
    | Array<{
        date: string;
        open: number | null;
        high: number | null;
        low: number | null;
        close: number;
        volume?: number | null;
      }>
    | undefined,
  interval: Interval,
): Bar[] {
  if (!rows?.length) return [];
  const weekday = weekdayOnly(rows);
  return aggregateBars(
    weekday.map((b) => ({
      time: b.date,
      open: b.open ?? b.close,
      high: b.high ?? b.close,
      low: b.low ?? b.close,
      close: b.close,
    })),
    interval,
  );
}

/**
 * 现货成交量,**按与蜡烛完全相同的周期键聚合并逐根对齐**。
 *
 * 必须和 spotBars 走同一套周期键:周/月视图下一根蜡烛要配那一整周/整月的**合计量**,
 * 配成最后一天的量,同一根 K 线上量和价就在讲两件事。
 * 做法是复用 aggregateBars 用的那个 `periodKey`(周期内所有日期 → 同一个规范日期),
 * 分组累加后按蜡烛逐根取。**不要**自己按「最后一根的日期」推边界 —— 那不是它的语义。
 *
 * 源没给量(走 price_eod 的标的整个不带这个字段)→ 返回空数组,调用方据此不建这条线。
 */
export function spotVolume(
  rows: Array<{ date: string; close: number; volume?: number | null }> | undefined,
  candles: Bar[],
  interval: Interval,
): Array<{ time: string; value: number }> {
  if (!rows?.length || !candles.length) return [];
  if (!rows.some((r) => r.volume != null)) return [];

  const weekday = weekdayOnly(rows);

  // 用**和 aggregateBars 同一个 periodKey** 分组 —— 它把周期内所有日期映射到同一个规范日期
  // (周一 / 月初),聚合后蜡烛的 time 就是这个键。自己按"最后一根的日期"推边界会错位:
  // 那不是 aggregateBars 的语义(实测第一周只归到 1 根)。
  const sums = new Map<string, number>();
  for (const r of weekday) {
    const key = periodKey(r.date, interval);
    sums.set(key, (sums.get(key) ?? 0) + (r.volume ?? 0));
  }

  // 按蜡烛逐根取,缺的补 0 —— 长度与顺序必须与蜡烛完全一致,否则量价错位。
  return candles.map((c) => ({ time: c.time, value: sums.get(c.time) ?? 0 }));
}

/** 默认勾选:取表内该 source 的期限并过滤到真实可用;无表则回退前 4 个可用期限。 */
export function pickDefaultTenors(source: string, available: string[]): string[] {
  const table = DEFAULT_TENORS[source];
  if (!table) return available.slice(0, 4);
  return table.filter((t) => available.includes(t));
}

/** 成交量柱色:涨绿跌红,与蜡烛同色系但压低透明度 —— 它是背景信息,不该抢价格的视觉权重。 */
const VOL_UP = 'rgba(34,197,94,0.5)';
const VOL_DOWN = 'rgba(239,68,68,0.5)';

// ── 图表实例:单图,每个选中期限一条线 ────────────────────────────
export type TenorSpec = { tenor: string; color: string; data: LinePoint[] };

export type SpreadSpec = { label: string; color: string; data: LinePoint[] };

/** 现货参照 pane(蜡烛 + 可选成交量)。给利率那几格当"曲线在动的时候,风险资产在干什么"的对照物。 */
export type SpotSpec = {
  label: string;
  data: Bar[];
  /** 与 data 逐根对齐的成交量;空数组 = 该源没有量(走 price_eod 的标的都没有),不画这条线。 */
  volume?: Array<{ time: string; value: number }>;
};

/** 建图挂 containerRef;期限线 → pane 0;spread 非 null → 一个 pane 画利差线 + 0 基线;
 *  spot 非 null → 再一个 pane 画现货蜡烛(共享时间轴、联动)。
 *  spread 传 null = 收起差值 pane(不重建图,故缩放/平移保留)。
 *
 *  ⚠️ **pane 一律用 addPane() 返回的句柄定位,不写死下标** —— 下标随另一个 pane 的显隐而变,
 *  写死会在收起差值时删掉现货那个 pane(或反之)。句柄式没有这个耦合。 */
export function useTenorChart(
  containerRef: React.RefObject<HTMLDivElement | null>,
  rawSpecs: TenorSpec[],
  rawSpread: SpreadSpec | null,
  rawSpot: SpotSpec | null = null,
) {
  // 引用稳定化在 hook 内部扛:调用方传新数组字面量不该让 sync effect 每帧重跑 fitContent。
  const specs = useStable(rawSpecs);
  const spread = useStable(rawSpread);
  const spot = useStable(rawSpot);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<Map<string, ISeriesApi<'Line'>>>(new Map());
  const spreadRef = useRef<ISeriesApi<'Line'> | null>(null);
  const spreadPaneRef = useRef<IPaneApi<Time> | null>(null);
  const spotRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const spotVolRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const spotPaneRef = useRef<IPaneApi<Time> | null>(null);
  const showSpread = spread !== null;
  const showSpot = spot !== null;

  // 挂载建一次,卸载销毁。
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, CHART_OPTIONS);
    chartRef.current = chart;
    const seriesMap = seriesRef.current; // 同一 Map(useRef 只建一次),捕获供 cleanup 用
    // 重建/卸载时清理:seriesMap 用捕获的局部;spreadRef 置空供重建时重新识别。
    return () => {
      chart.remove();
      seriesMap.clear();
      chartRef.current = null;
      spreadRef.current = null;
      spreadPaneRef.current = null;
      spotRef.current = null;
      spotPaneRef.current = null;
    };
  }, [containerRef]);

  // 差值 pane(主图 2、它 1 的高度比)随显隐增删。单独一个 effect:挂在建图 effect 上会让每次
  // 切换重建整张图、丢缩放。
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !showSpread) return;

    const pane = chart.addPane();
    spreadPaneRef.current = pane;
    chart.panes()[0].setStretchFactor(2);
    pane.setStretchFactor(1);

    return () => {
      // 卸载时建图 effect 的 cleanup 先跑过、chart 已销毁 → 用 ref 判活,别用捕获的局部。
      const alive = chartRef.current;
      // removePane 只是把 pane 从数组里 splice 掉,不销毁 pane 内的 series(v5.2 实现如此)
      // → 必须自己先 removeSeries,否则反复显隐会把旧差值线连 0 基线一起攒在 chart 里。
      if (alive && spreadRef.current) alive.removeSeries(spreadRef.current);
      spreadRef.current = null;
      // 用句柄现取下标:现货 pane 可能排在它前面,写死 1 会删错人。
      if (alive && spreadPaneRef.current) alive.removePane(spreadPaneRef.current.paneIndex());
      spreadPaneRef.current = null;
    };
  }, [showSpread]);

  // 现货 pane(同样 1 的高度比)。与差值 pane 各自独立:两者显隐互不影响,下标各自从句柄取。
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !showSpot) return;

    const pane = chart.addPane();
    spotPaneRef.current = pane;
    pane.setStretchFactor(1);

    return () => {
      const alive = chartRef.current;
      if (alive && spotVolRef.current) alive.removeSeries(spotVolRef.current);
      spotVolRef.current = null;
      if (alive && spotRef.current) alive.removeSeries(spotRef.current);
      spotRef.current = null;
      if (alive && spotPaneRef.current) alive.removePane(spotPaneRef.current.paneIndex());
      spotPaneRef.current = null;
    };
  }, [showSpot]);

  // 期限线(pane 0)同步。fitContent 留在这里:期限勾选 / interval 变化才重取视窗。
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const keysNow = new Set(specs.map((s) => s.tenor));
    for (const [k, s] of seriesRef.current) {
      if (!keysNow.has(k)) {
        chart.removeSeries(s);
        seriesRef.current.delete(k);
      }
    }
    for (const spec of specs) {
      let s = seriesRef.current.get(spec.tenor);
      if (!s) {
        s = chart.addSeries(LineSeries, {
          color: spec.color,
          title: spec.tenor,
          lineWidth: 2,
          priceLineVisible: false,
        });
        seriesRef.current.set(spec.tenor, s);
      }
      s.setData(spec.data);
    }

    chart.timeScale().fitContent();
  }, [specs]);

  // 差值线同步。独立于期限线:这里不碰 timeScale,否则显隐差值会把用户的缩放/平移 fit 掉。
  useEffect(() => {
    const chart = chartRef.current;
    const pane = spreadPaneRef.current;
    if (!chart || !spread || !pane) return;

    if (!spreadRef.current) {
      spreadRef.current = chart.addSeries(
        LineSeries,
        { color: spread.color, title: spread.label, lineWidth: 2, priceLineVisible: false },
        pane.paneIndex(),
      );
      // 穿 0 = 倒挂。只在建线时加一次。
      spreadRef.current.createPriceLine({
        price: 0,
        color: '#71717a',
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: '',
      });
    }
    spreadRef.current.setData(spread.data);
  }, [spread]);

  // 现货蜡烛同步。
  useEffect(() => {
    const chart = chartRef.current;
    const pane = spotPaneRef.current;
    if (!chart || !spot || !pane) return;

    const first = !spotRef.current;
    if (first) {
      spotRef.current = chart.addSeries(CandlestickSeries, { title: spot.label }, pane.paneIndex());
      // ⚠️ 对数刻度是必须的不是好看:BTC 这条从 $4.23 走到 $124,786(**29500 倍**,现货已回填到 2012),
      // 线性刻度下 2021 年之前会被压成一条贴底的平线,等于白画。
      //
      // scaleMargins 必须跟着收紧:默认 0.2 的留白是在**对数空间**里取的,跨 4.5 个数量级时
      // 上边界会超出实际最高价近一个数量级(轴顶标到 $2,000,000 这种没意义的数),刻度也只剩一条。
      pane
        .priceScale('right')
        .applyOptions({ mode: PriceScaleMode.Logarithmic, scaleMargins: { top: 0.05, bottom: 0.05 } });
    }
    spotRef.current?.setData(spot.data);

    // 成交量:**同 pane 的独立 overlay 轴**,压在底部四分之一,不另开 pane。
    // 不共用右轴:量的量级(千万股)比价格(千日元)大好几个数量级,共轴会把蜡烛压成一条线;
    // 而那条右轴还是对数的,量一进去更没法看。overlay 轴自己缩放,互不干扰。
    // 不另开 pane 是因为量和价必须并排读 —— 隔一个 pane 就得来回扫视。
    const vol = spot.volume ?? [];
    if (vol.length && !spotVolRef.current) {
      spotVolRef.current = chart.addSeries(
        HistogramSeries,
        // priceLineVisible / lastValueVisible 必须关:overlay 直方图开着会在现货 pane 底部
        // 拉一条横贯全宽的价格线、右侧再挂一个末值标签(库里默认 true)。
        // 同 paneChart.hooks 里 histogram 分支的既有约定。
        {
          priceScaleId: 'spot-vol',
          priceFormat: { type: 'volume' },
          title: '',
          priceLineVisible: false,
          lastValueVisible: false,
        },
        pane.paneIndex(),
      );
      pane.priceScale('spot-vol').applyOptions({ scaleMargins: { top: 0.78, bottom: 0 } });
    }
    // 柱色跟随该周期涨跌,与蜡烛同口径(收 ≥ 开为绿)。逐根对齐由 spotVolume 保证。
    spotVolRef.current?.setData(
      vol.map((v, i) => {
        const c = spot.data[i];
        return { time: v.time as Time, value: v.value, color: !c || c.close >= c.open ? VOL_UP : VOL_DOWN };
      }),
    );

    // ⚠️ **只在建线那一次** fitContent:现货是异步到的,它一来就多一个 pane、主图变矮,
    // 而 bar spacing 不变 → 可见区间被压掉一大截(实测默认视窗从 2018 起缩到 2021 起)。
    // 重取一次视窗把它拉回全历史。之后不再碰 timeScale,否则每次数据刷新都会把用户的缩放 fit 掉。
    if (first) chart.timeScale().fitContent();
  }, [spot]);
}
