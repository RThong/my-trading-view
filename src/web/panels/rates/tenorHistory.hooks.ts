// 期限走势图数据层:把某一期限的历史序列喂给图,按全局 interval 聚合。
// 纯函数在此,图表实例管理见下方 useTenorChart。
import { useEffect, useRef } from 'react';
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  PriceScaleMode,
  type IChartApi,
  type IPaneApi,
  type ISeriesApi,
  type Time,
} from 'lightweight-charts';
import { aggregate, aggregateBars, CHART_OPTIONS, type Bar, type LinePoint } from '../../lib/chart';
import type { YPoint } from './yieldCurve.hooks';
import type { Interval } from '../../hooks/interval';
import { useStable } from '../../hooks/useStable';

// 各 source 的默认勾选期限(短/前端/中/长各取锚点)。
// treasury 前端用信息量更大的 2Y;OIS 档位对齐 Eris 真实点,12M 而非 1Y。
export const DEFAULT_TENORS: Record<string, string[]> = {
  // 美债默认只开**差值那几条腿**(1Y / 10Y / 30Y):这格的主角是下方的 10Y−1Y 与 30Y−10Y,
  // 上面只需要它们的腿好对着看。其余期限默认关掉 —— 六条线挤在一起反而看不出腿在动哪条。
  // 要看别的期限点一下就开,是用户侧状态,不必预置。
  treasury: ['1Y', '10Y', '30Y'],
  sofr_ois: ['1M', '3M', '6M', '12M', '2Y', '10Y'],
  bei: ['5Y', '10Y', '30Y'],
  // 实际收益率与 bei 同档位、刻意同一组默认勾选 —— 两格并排就是「名义 − BEI = 实际」的两边。
  real: ['5Y', '10Y', '30Y'],
  // JGB 没有差值 pane:2Y 是日本银行股的主变量(见「银行」那格),10Y 是长端锚。
  jgb: ['2Y', '10Y'],
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

/** 默认勾选:取表内该 source 的期限并过滤到真实可用;无表则回退前 4 个可用期限。 */
export function pickDefaultTenors(source: string, available: string[]): string[] {
  const table = DEFAULT_TENORS[source];
  if (!table) return available.slice(0, 4);
  return table.filter((t) => available.includes(t));
}

// ── 图表实例:单图,每个选中期限一条线 ────────────────────────────
export type TenorSpec = { tenor: string; color: string; data: LinePoint[] };

export type SpreadSpec = { label: string; color: string; data: LinePoint[] };

/** 现货参照 pane(蜡烛)。给利率那几格当"曲线在动的时候,风险资产在干什么"的对照物。 */
export type SpotSpec = { label: string; data: Bar[] };

/** 建图挂 containerRef;期限线 → pane 0;spreads 每条一个 pane 画利差线 + 0 基线;
 *  spot 非 null → 再一个 pane 画现货蜡烛(共享时间轴、联动)。
 *  从 spreads 里拿掉某条 = 收起它那格(不重建图,故缩放/平移保留)。
 *
 *  ⚠️ **pane 一律用 addPane() 返回的句柄定位,不写死下标** —— 下标随别的 pane 显隐而变,
 *  写死会在收起某格差值时删掉现货那个 pane(或反之)。句柄式没有这个耦合。 */
export function useTenorChart(
  containerRef: React.RefObject<HTMLDivElement | null>,
  rawSpecs: TenorSpec[],
  rawSpreads: SpreadSpec[],
  rawSpot: SpotSpec | null = null,
) {
  // 引用稳定化在 hook 内部扛:调用方传新数组字面量不该让 sync effect 每帧重跑 fitContent。
  const specs = useStable(rawSpecs);
  const spreads = useStable(rawSpreads);
  const spot = useStable(rawSpot);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<Map<string, ISeriesApi<'Line'>>>(new Map());
  // 差值格按 label 索引(每格一条线,pane 随线增删)。
  const spreadsRef = useRef<Map<string, ISeriesApi<'Line'>>>(new Map());
  const spotRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const spotPaneRef = useRef<IPaneApi<Time> | null>(null);
  const showSpot = spot !== null;

  // 挂载建一次,卸载销毁。
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, CHART_OPTIONS);
    // 期限格(pane 0)不许被自动删:期限全取消时库会摘掉空 pane,差值格顶到 0 号 →
    // 之后按定义序 moveTo 越界崩,再勾回期限也会被 addSeries 默认塞进差值格。
    chart.panes()[0].setPreserveEmptyPane(true);
    chartRef.current = chart;
    // 同一 Map(useRef 只建一次),捕获供 cleanup 用
    const seriesMap = seriesRef.current;
    const spreadMap = spreadsRef.current;
    return () => {
      chart.remove();
      seriesMap.clear();
      spreadMap.clear();
      chartRef.current = null;
      spotRef.current = null;
      spotPaneRef.current = null;
    };
  }, [containerRef]);

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
      } else {
        // 颜色按当前显示的线依次分配,勾 / 取消别的期限会让这条换色 → 复用的线也要同步颜色。
        s.applyOptions({ color: spec.color });
      }
      s.setData(spec.data);
    }

    chart.timeScale().fitContent();
  }, [specs]);

  // 差值格同步:按 label 增删 pane,已有的只换数据。这里不碰 timeScale,否则显隐差值会把用户的缩放/平移 fit 掉。
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const live = spreadsRef.current;
    const keysNow = new Set(spreads.map((s) => s.label));
    for (const [k, series] of live) {
      if (keysNow.has(k)) continue;
      // 只 removeSeries:pane 空了 v5.2 会自动摘掉(addPane 默认不 preserveEmptyPane)。
      // 再手动 removePane 会拿到已失效的下标 → `Invalid pane index` 崩整个面板。
      chart.removeSeries(series);
      live.delete(k);
    }

    let added = false;
    for (const spec of spreads) {
      let series = live.get(spec.label);
      if (!series) {
        const pane = chart.addPane();
        pane.setStretchFactor(1);
        // ⚠️ 显式回到库默认:现货格对 'right' 刻度的设置会并进图表全局选项,之后新建的 pane 照单全收
        // —— 对数刻度让差值穿 0 时画成方波,0.05 留白让重新展开的格跟首次渲染不一样。
        pane.priceScale('right').applyOptions({
          mode: PriceScaleMode.Normal,
          scaleMargins: { top: 0.2, bottom: 0.1 },
        });
        series = chart.addSeries(
          LineSeries,
          { color: spec.color, title: spec.label, lineWidth: 2, priceLineVisible: false },
          pane.paneIndex(),
        );
        // 穿 0 = 倒挂。只在建线时加一次。
        series.createPriceLine({
          price: 0,
          color: '#71717a',
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: '',
        });
        live.set(spec.label, series);
        added = true;
      }
      // 复用的线不会重读 spec 颜色:颜色由调用方决定(现为中性常量),仍每次同步,改色不必重建。
      series.applyOptions({ color: spec.color });
      series.setData(spec.data);
    }

    // addPane 总是追加到末尾:收起再展开会排到别的格(甚至现货)后面。按定义序归位到 1..n,现货自然落在最后。
    // 已在位的不调 moveTo:新建的 pane 控件要等下一帧才同步,对它调 moveTo 会撞库里的下标断言。
    spreads.forEach((spec, i) => {
      const pane = live.get(spec.label)?.getPane();
      if (pane && pane.paneIndex() !== i + 1) pane.moveTo(i + 1);
    });

    // 主图 2、每格差值 1 的高度比。只在新建过格时设:每次数据同步都设会把用户拖过的分隔条弹回去。
    if (added) chart.panes()[0].setStretchFactor(2);
  }, [spreads]);

  // 现货 pane(同样 1 的高度比)。与差值 pane 各自独立:两者显隐互不影响,下标各自从句柄取。
  // **必须声明在差值 effect 之后**:同一次提交里先建差值格、后建现货格,差值格天然落在 1..n,首帧不用 moveTo。
  // 反过来(现货已在 SWR 缓存里、首帧就到)差值格得往前挪,而 addPane 后 pane 控件要等下一帧才同步,
  // moveTo 的下标断言会失败 → 整页崩(实测:先看 BTC 期权 tab 再进期限走势)。
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !showSpot) return;

    const pane = chart.addPane();
    spotPaneRef.current = pane;
    pane.setStretchFactor(1);

    return () => {
      const alive = chartRef.current;
      // 只 removeSeries:空 pane 由库自动摘掉(见差值格同步处的说明)。
      if (alive && spotRef.current) alive.removeSeries(spotRef.current);
      spotRef.current = null;
      spotPaneRef.current = null;
    };
  }, [showSpot]);

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

    // ⚠️ **只在建线那一次** fitContent:现货是异步到的,它一来就多一个 pane、主图变矮,
    // 而 bar spacing 不变 → 可见区间被压掉一大截(实测默认视窗从 2018 起缩到 2021 起)。
    // 重取一次视窗把它拉回全历史。之后不再碰 timeScale,否则每次数据刷新都会把用户的缩放 fit 掉。
    if (first) chart.timeScale().fitContent();
  }, [spot]);
}
