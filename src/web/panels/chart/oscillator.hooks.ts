// 主图下方的副图指标(MACD / RSI):每个指标一张独立的小 lightweight-charts,跟随主图。
// 刻意不进主图的 pane 栈:主图 pane 数每实例固定、布局 hook 三个面板共用,动它代价远大于另起一张图。
// 对齐前提:主图时间轴 = 现货蜡烛的日期(期权 / VRP 日期都是其子集,2026-10 实测),
// 故两图逻辑序号只差副图预热掉的那几根(offset)。
import { useEffect, useMemo, useState } from 'react';
import type { IChartApi, LogicalRange, MouseEventParams, Time } from 'lightweight-charts';
import { fmtDate, type Bar } from '../../lib/chart';
import { macd, rsi } from '../../lib/indicators';
import { usePaneChart } from './paneChart.hooks';
import type { Spec } from './paneChart.types';

type OscDef = {
  /** 「指标」下拉里的选项名。 */
  label: string;
  /** 副图左上角标题。 */
  title: string;
  /** 图例项:key 对应 build 产出的 spec。 */
  legend: { key: string; label: string; color: string }[];
  build: (bars: Bar[]) => Spec[];
};

const UP = '#22c55e99';
const DOWN = '#ef444499';

// 副图指标的唯一登记处:加一个副图 = 这里一条记录(下拉选项、勾选、绘制都由它派生)。
// 配色照 moomoo:DIF 橙 / DEA 蓝;RSI 6 橙 / 12 蓝 / 24 紫。
const OSC_DEFS = {
  macd: {
    label: 'MACD 12,26,9',
    title: 'MACD(12,26,9)',
    legend: [
      { key: 'dif', label: 'DIF', color: '#d89050' },
      { key: 'dea', label: 'DEA', color: '#3a72ce' },
      { key: 'hist', label: 'MACD', color: '#c04fd6' },
    ],
    build: (bars) => {
      const pts = macd(bars, 12, 26, 9);
      const line = (key: 'dif' | 'dea', color: string): Spec => ({
        key,
        pane: 0,
        kind: 'line',
        color,
        title: '',
        overlay: true,
        data: pts.map((p) => ({ time: p.time, value: p[key] })),
      });
      return [
        {
          key: 'hist',
          pane: 0,
          kind: 'histogram',
          title: '',
          data: pts.map((p) => ({ time: p.time, value: p.hist, color: p.hist >= 0 ? UP : DOWN })),
        },
        line('dif', '#d89050'),
        line('dea', '#3a72ce'),
      ];
    },
  },
  rsi: {
    label: 'RSI 6/12/24',
    title: 'RSI',
    legend: [
      { key: 'rsi6', label: 'RSI6', color: '#d89050' },
      { key: 'rsi12', label: 'RSI12', color: '#3a72ce' },
      { key: 'rsi24', label: 'RSI24', color: '#c04fd6' },
    ],
    build: (bars) =>
      (
        [
          [6, '#d89050'],
          [12, '#3a72ce'],
          [24, '#c04fd6'],
        ] as const
      ).map(([n, color], i) => ({
        key: `rsi${n}`,
        pane: 0,
        kind: 'line' as const,
        color,
        title: '',
        overlay: true,
        data: rsi(bars, n),
        // 超买 / 超卖参考线挂一条就够
        ...(i === 0
          ? {
              refLines: [
                { price: 70, title: '70' },
                { price: 30, title: '30' },
              ],
            }
          : {}),
      })),
  },
} satisfies Record<string, OscDef>;

export type OscId = keyof typeof OSC_DEFS;
export const OSC_IDS = Object.keys(OSC_DEFS) as OscId[];
/** 下拉选项(只占勾选位,不产叠加线,故 series 为空)。 */
export const OSC_OPTIONS = OSC_IDS.map((id) => ({ id, label: OSC_DEFS[id].label, series: [] }));

/** 同一副图区里所有副图共享的右轴宽度状态(只增不减)+ 已挂载的副图;渲染不读,由 OscillatorPanel 用 ref 持有。 */
export type AxisSync = { width: number; charts: Set<IChartApi> };

/** 一张副图:建图、喂数据、跟随主图的可视范围与十字线、右轴与主图及其它副图等宽;返回图例读数。 */
export function useOscillatorChart(
  containerRef: React.RefObject<HTMLDivElement | null>,
  mainChartRef: React.RefObject<IChartApi | null>,
  axisSync: React.RefObject<AxisSync>,
  bars: Bar[],
  id: OscId,
  showTimeAxis: boolean,
) {
  const def = OSC_DEFS[id];
  const specs = useMemo(() => def.build(bars), [def, bars]);
  const { chartRef, seriesRef, seriesVersion } = usePaneChart(containerRef, 1, specs);
  const [hoverTime, setHoverTime] = useState<string | null>(null);

  // 读数表:key → (time → value);副图最早一根在主图里的序号 = 预热掉的根数。
  const valueAt = useMemo(
    () => new Map(specs.map((s) => [s.key, new Map(s.data.map((p) => [p.time, 'value' in p ? p.value : p.close]))])),
    [specs],
  );
  const offset = useMemo(() => {
    const first = specs
      .map((s) => s.data[0]?.time)
      .filter(Boolean)
      .sort()[0];
    return Math.max(
      0,
      bars.findIndex((b) => b.time === first),
    );
  }, [specs, bars]);

  // 副图不自己拖拽缩放(只跟主图),时间轴只在最下面那张显示。
  useEffect(() => {
    // 署名标志主图留一个即可(lightweight-charts 许可要求页面上有署名)。
    chartRef.current?.applyOptions({
      handleScroll: false,
      handleScale: false,
      timeScale: { visible: showTimeAxis },
      layout: { attributionLogo: false },
    });
  }, [chartRef, showTimeAxis]);

  // 主图可视范围 → 副图(按序号平移 offset)。seriesVersion:副图换数据后 usePaneChart 会 fitContent,要重新对齐。
  useEffect(() => {
    const main = mainChartRef.current;
    const osc = chartRef.current;
    if (!main || !osc) return;
    const apply = (r: LogicalRange | null) => {
      if (r) osc.timeScale().setVisibleLogicalRange({ from: r.from - offset, to: r.to - offset });
    };
    apply(main.timeScale().getVisibleLogicalRange());
    main.timeScale().subscribeVisibleLogicalRangeChange(apply);
    return () => main.timeScale().unsubscribeVisibleLogicalRangeChange(apply);
  }, [mainChartRef, chartRef, offset, seriesVersion]);

  // 主图十字线 → 副图竖线 + 图例读数;副图自身悬停也更新读数。
  useEffect(() => {
    const main = mainChartRef.current;
    const osc = chartRef.current;
    if (!main || !osc) return;
    const onMain = (p: MouseEventParams<Time>) => {
      const t = p.time == null ? null : fmtDate(p.time);
      setHoverTime(t);
      // 竖线要挂在一条该日有值的 series 上(取其值当横线位置);各线预热长度不同,逐条找第一条有值的。
      const key = t ? specs.find((sp) => valueAt.get(sp.key)?.get(t) !== undefined)?.key : undefined;
      const s = key ? seriesRef.current.get(key) : undefined;
      const v = t && key ? valueAt.get(key)?.get(t) : undefined;
      if (t && s && v !== undefined) osc.setCrosshairPosition(v, t as Time, s);
      else osc.clearCrosshairPosition();
    };
    const onOsc = (p: MouseEventParams<Time>) => {
      if (p.sourceEvent) setHoverTime(p.time == null ? null : fmtDate(p.time)); // 只认真实鼠标,别被上面的程序化定位回灌
    };
    main.subscribeCrosshairMove(onMain);
    osc.subscribeCrosshairMove(onOsc);
    return () => {
      main.unsubscribeCrosshairMove(onMain);
      osc.unsubscribeCrosshairMove(onOsc);
    };
  }, [mainChartRef, chartRef, seriesRef, specs, valueAt]);

  // 登记到副图区,供等宽同步遍历;卸下即注销。
  useEffect(() => {
    const osc = chartRef.current;
    const sync = axisSync.current;
    if (!osc) return;
    sync.charts.add(osc);
    return () => {
      sync.charts.delete(osc);
    };
  }, [chartRef, axisSync]);

  // 右轴等宽:主图与所有副图取同一宽度,绘图区同宽,同一逻辑范围下 K 线才能上下逐根对齐。
  // 宽度只增不减:几张副图同一帧先后算、width() 还没重排时,也不会把别人刚抬上去的值压回去。
  // 主图的复原由 OscillatorPanel 卸载时负责。
  useEffect(() => {
    const main = mainChartRef.current;
    const sync = axisSync.current;
    if (!main || seriesVersion === 0) return;
    const raf = requestAnimationFrame(() => {
      sync.width = Math.max(
        sync.width,
        main.priceScale('right').width(),
        ...[...sync.charts].map((c) => c.priceScale('right').width()),
      );
      main.panes().forEach((_, i) => {
        main.priceScale('right', i).applyOptions({ minimumWidth: sync.width });
      });
      sync.charts.forEach((c) => {
        c.priceScale('right').applyOptions({ minimumWidth: sync.width });
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [mainChartRef, axisSync, seriesVersion]);

  // 图例:悬停那天的值,不悬停给最新值。
  const lastTime = specs[0]?.data[specs[0].data.length - 1]?.time ?? null;
  const t = hoverTime ?? lastTime;
  const readings = def.legend.map((l) => ({ ...l, value: t ? valueAt.get(l.key)?.get(t) : undefined }));
  return { title: def.title, readings };
}

/** 副图整体挂上 / 卸下时对主图做的事:隐藏主图时间轴(只留最下面副图那条),卸下时复原轴与右轴宽度。 */
export function useMainChartForOscillators(mainChartRef: React.RefObject<IChartApi | null>) {
  useEffect(() => {
    const main = mainChartRef.current;
    if (!main) return;
    main.timeScale().applyOptions({ visible: false });
    return () => {
      main.timeScale().applyOptions({ visible: true });
      main.panes().forEach((_, i) => {
        main.priceScale('right', i).applyOptions({ minimumWidth: 0 });
      });
    };
  }, [mainChartRef]);
}
