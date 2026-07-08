import { useEffect, useRef, useState } from 'react';
import { useYieldCurve, curveForDate, snapToTradingDay } from './yieldCurve.hooks';
import { YieldCurveChart, type Curve } from './YieldCurveChart';
import { DatePickerWithPresets } from '../components/DatePickerWithPresets';
import { SERIES_COLORS } from '../lib/palette';
const DEFAULT_LABELS = ['Current', '1 month ago', '1 year ago'];

type Row = { id: number; date: string; visible: boolean };

export function YieldCurvePanel({ source }: { source: string }) {
  const { data, isLoading, error, datesAsc, maxDate, presets } = useYieldCurve(source);
  const [rows, setRows] = useState<Row[]>([]);
  const idRef = useRef(0);
  const nextId = () => ++idRef.current;

  // 数据到位后,首次种入默认三行(Current / 1月前 / 1年前),均勾选。
  useEffect(() => {
    if (maxDate && rows.length === 0) {
      const seed = presets.filter((p) => DEFAULT_LABELS.includes(p.label));
      setRows(seed.map((p) => ({ id: nextId(), date: p.date, visible: true })));
    }
  }, [maxDate]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <div className="flex h-full items-center justify-center text-red-400">加载失败:{error.message}</div>;
  if (isLoading) return <div className="flex h-full items-center justify-center text-neutral-500">加载中…</div>;
  // 加载完但无任何期限数据(如 FRED key 缺 / 全部失败):显示降级结果而非一直"加载中"。
  if (!maxDate) return (
    <div className="flex h-full items-center justify-center text-amber-500">
      暂无收益率数据{data.unavailable.length ? `(全部期限缺失:${data.unavailable.join(', ')})` : ''}
    </div>
  );

  const setDate = (id: number, date: string) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, date } : r)));
  const toggle = (id: number) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, visible: !r.visible } : r)));
  const remove = (id: number) => setRows((rs) => rs.filter((r) => r.id !== id));
  const addRow = () => setRows((rs) => [...rs, { id: nextId(), date: maxDate, visible: true }]);

  const presetLabelOf = (date: string) => presets.find((p) => p.date === date)?.label;
  const labelOf = (date: string) => (presetLabelOf(date) ? `${presetLabelOf(date)}: ${date}` : date);
  const colorOf = (i: number) => SERIES_COLORS[i % SERIES_COLORS.length];

  // 每行算好值 + 颜色(按行序,与显隐无关,勾掉再勾回颜色不变);图只画勾选的。
  const enriched = rows.map((r, i) => ({ row: r, color: colorOf(i), values: curveForDate(data.series, data.tenors, r.date) }));
  const curves: Curve[] = enriched
    .filter((e) => e.row.visible)
    .map((e) => ({ date: e.row.date, label: labelOf(e.row.date), color: e.color, values: e.values }));

  return (
    <div className="flex h-full flex-col gap-3">
      {data.unavailable.length > 0 && <div className="text-xs text-amber-500">缺失期限:{data.unavailable.join(', ')}</div>}

      {/* 图 */}
      <div className="min-h-0 flex-1">
        <YieldCurveChart tenors={data.tenors} curves={curves} />
      </div>

      {/* 数据表即控制器:每行行内改日期 / 勾选显隐 / 单独删除 */}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs tabular-nums">
          <thead>
            <tr className="text-neutral-500">
              <th className="px-2 py-1 text-left font-normal">日期</th>
              {data.tenors.map((t) => <th key={t} className="px-2 py-1 text-right font-normal">{t}</th>)}
              <th className="px-2 py-1" />
            </tr>
          </thead>
          <tbody>
            {enriched.map(({ row, color, values }) => (
              <tr key={row.id} className="border-t border-neutral-800">
                <td className="whitespace-nowrap px-2 py-1">
                  <div className="flex items-center gap-1.5">
                    <input type="checkbox" checked={row.visible} onChange={() => toggle(row.id)} />
                    <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
                    {/* 融合预设 + 日历的选择器(shadcn Popover + react-day-picker) */}
                    <DatePickerWithPresets
                      value={row.date}
                      presets={presets}
                      min={datesAsc[0]}
                      max={maxDate}
                      snap={(t) => snapToTradingDay(datesAsc, t)}
                      onChange={(d) => setDate(row.id, d)}
                    />
                  </div>
                </td>
                {values.map((v, i) => (
                  <td key={i} className={`px-2 py-1 text-right ${row.visible ? 'text-neutral-300' : 'text-neutral-600'}`}>
                    {v != null ? `${v.toFixed(3)}%` : '—'}
                  </td>
                ))}
                <td className="px-2 py-1 text-right">
                  <button onClick={() => remove(row.id)} className="text-neutral-500 hover:text-red-400" title="删除">✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button onClick={addRow} className="mt-2 rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800">
          + 添加时间点
        </button>
      </div>
    </div>
  );
}
