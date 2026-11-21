// 「出清(试行)」灯的取数:防御(XLP)与进攻(XLK)板块收盘走 Yahoo 现拉(同图表编辑器的 yh: 序列),判定在 shared/calc/stampede。
import { useMemo } from 'react';
import { type Point, flushSeries, recentFlush, type SeriesMap } from '../../../shared/calc/stampede';
import type { LinePoint } from '../../chart/core';
import { requestKey, type SeriesRequest, useSeriesData } from '../../views/chartDoc/useSeriesData';

const REQS: SeriesRequest[] = [
  { series: 'yh:XLP', shift: 0, daily: true },
  { series: 'yh:XLK', shift: 0, daily: true },
];

function toPoints(rows: LinePoint[] | undefined): Point[] {
  return (rows ?? []).map((p) => ({ date: p.time, value: p.value }));
}

/** 最近 10 个交易日内最后一次出清的日期;板块数据还没到 → ready = false。 */
export function useFlush(s: SeriesMap): { ready: boolean; date: string | null } {
  const { points } = useSeriesData(REQS, '1D');
  const xlp = points[requestKey(REQS[0])];
  const xlk = points[requestKey(REQS[1])];

  return useMemo(() => {
    if (!xlp?.length || !xlk?.length) return { ready: false, date: null };
    const flush = flushSeries(s, toPoints(xlp), toPoints(xlk));
    // 板块数据比 SKEW 落后时,交集的末日是旧日子:按它取「最近 10 日」会把过期信号当成还亮着 → 当无数据
    if (flush.at(-1)?.date !== s.skew?.at(-1)?.date) return { ready: false, date: null };
    return { ready: true, date: recentFlush(flush) };
  }, [s, xlp, xlk]);
}
