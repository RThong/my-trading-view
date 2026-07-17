import { useEffect, useRef, useState } from 'react';
import { useYieldCurve, curveForDate, snapToTradingDay } from './yieldCurve.hooks';
import { YieldCurveChart, type Curve } from './YieldCurveChart';
import { DatePickerWithPresets } from '../components/DatePickerWithPresets';
import { InfoTip } from '../components/InfoTip';
import { SERIES_COLORS } from '../lib/palette';

type Row = { id: number; date: string; visible: boolean };

// 视图说明(按 source):某几个时间点的曲线(横轴 = 期限)。
const VIEW_DESC: Record<string, { title: string; desc: string }> = {
  treasury: { title: '收益曲线', desc: '定义:某几个时间点的美债收益率曲线(横轴 = 期限)。\n看形状:陡峭 / 平坦 / 倒挂,及随时间的移动。' },
  sofr_ois: { title: 'SOFR OIS', desc: '定义:SOFR OIS 曲线(Eris par OIS 固定利率,横轴 = 期限)。\n主要反映市场对未来隔夜利率(≈美联储路径)的预期,并含期限 / 流动性溢价。\n下弯 / 短端高于长端 = 降息定价占主导,非确定预测。' },
  jgb: { title: 'JGB 曲线', desc: '定义:日本国债收益率曲线。\n看 BOJ / YCC 对曲线形状的压制与松绑。' },
  bei: { title: 'BEI 曲线', desc: '定义:盈亏平衡通胀率(BEI)曲线,= 名义 − TIPS 实际收益率。\n是市场通胀补偿(含通胀风险溢价 + 名义债/TIPS 流动性差异),可作预期代理但非纯预期。' },
  credit_rating: { title: '评级利差', desc: '定义:不同信用评级债券相对美债的期权调整利差(OAS,横轴 = 评级)。\n评级越低 OAS 通常越宽 = 信用风险溢价的阶梯。' },
  credit_term: { title: '信用期限', desc: '定义:同一投资级公司债指数、不同剩余期限分组的期权调整利差(OAS)。\n是信用利差自身的期限结构,不是收益率曲线。' },
};

export function YieldCurvePanel({ source }: { source: string }) {
  const { data, isLoading, error, datesAsc, maxDate, presets } = useYieldCurve(source);
  const [rows, setRows] = useState<Row[]>([]);
  const idRef = useRef(0);
  const nextId = () => ++idRef.current;

  // 数据到位后,首次种入全部预设时间点(今天/昨天/前天/上周/上个月/半年前/一年前),均勾选。
  useEffect(() => {
    if (maxDate && rows.length === 0) {
      setRows(presets.map((p) => ({ id: nextId(), date: p.date, visible: true })));
    }
  }, [maxDate]); 

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

  const view = VIEW_DESC[source];

  return (
    <div className="flex h-full flex-col gap-3">
      {/* 视图说明:左上角精简工具条(label + ⓘ,无 ↑↓/显隐) */}
      {view && (
        <div className="flex items-center gap-0.5 self-start rounded border border-neutral-700 px-1 py-0.5 text-xs">
          <span className="text-neutral-300">{view.title}</span>
          <InfoTip text={view.desc} />
        </div>
      )}
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
