import { useRef } from 'react';
import type { IChartApi } from 'lightweight-charts';
import type { Bar } from '../../lib/chart';
import { type AxisSync, type OscId, useMainChartForOscillators, useOscillatorChart } from './oscillator.hooks';

// 主图下方的副图指标区(MACD / RSI),逐张叠放;同步与对齐逻辑见 ./oscillator.hooks。
export function OscillatorPanel({
  ids,
  bars,
  mainChartRef,
}: {
  ids: OscId[];
  bars: Bar[];
  mainChartRef: React.RefObject<IChartApi | null>;
}) {
  useMainChartForOscillators(mainChartRef);
  const axisSync = useRef<AxisSync>({ width: 0, charts: new Set() });

  return (
    <div className="flex flex-col">
      {ids.map((id, i) => (
        <OscillatorChart
          key={id}
          id={id}
          bars={bars}
          mainChartRef={mainChartRef}
          axisSync={axisSync}
          showTimeAxis={i === ids.length - 1}
        />
      ))}
    </div>
  );
}

function OscillatorChart({
  id,
  bars,
  mainChartRef,
  axisSync,
  showTimeAxis,
}: {
  id: OscId;
  bars: Bar[];
  mainChartRef: React.RefObject<IChartApi | null>;
  axisSync: React.RefObject<AxisSync>;
  showTimeAxis: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { title, readings } = useOscillatorChart(containerRef, mainChartRef, axisSync, bars, id, showTimeAxis);

  return (
    <div className="mt-1 border-t border-neutral-800 pt-1">
      <div className="flex gap-3 px-2 text-xs text-neutral-300">
        <span>{title}</span>
        {readings.map((r) => (
          <span key={r.key} style={{ color: r.color }}>
            {r.label}: {r.value === undefined ? '—' : r.value.toFixed(3)}
          </span>
        ))}
      </div>
      <div ref={containerRef} className={showTimeAxis ? 'h-36' : 'h-28'} />
    </div>
  );
}
