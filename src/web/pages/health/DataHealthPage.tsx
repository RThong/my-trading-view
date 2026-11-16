// 「数据健康」(ROADMAP L0-1,同参考站的数据健康页):注册表里每条序列的最新日期、落后多久、状态,异常的排最前。
// 旁路功能:取数复用图表那套 useSeriesData(同一接口、同一份服务端缓存),判定是 shared/calc/freshness 的纯函数,
// 不改任何现有图表 / job / 状态灯。顶栏状态灯只看「这次抓没抓成功」,这页补的是「源安静停更」:接口照常成功、数据却停在几周前。
import { useState } from 'react';
import { Checkbox } from '../../components/ui/checkbox';
import { cn } from '../../lib/utils';
import { type Health, seriesHealth } from '../../../shared/calc/freshness';
import { REGISTRY } from '../../views/chartDoc/registry';
import { requestKey, type SeriesRequest, useSeriesData } from '../../views/chartDoc/useSeriesData';
import { HEALTH_OVERRIDES } from './overrides';

// 状态 → 文案、颜色、排序(越靠前越要紧)
const STATUS: Record<Health, { text: string; cls: string; rank: number }> = {
  stale: { text: '过期', cls: 'text-red-500', rank: 0 },
  late: { text: '偏晚', cls: 'text-amber-500', rank: 1 },
  flat: { text: '疑似填平', cls: 'text-amber-500', rank: 2 },
  empty: { text: '无数据', cls: 'text-neutral-500', rank: 3 },
  unknown: { text: '不判', cls: 'text-neutral-500', rank: 4 },
  ok: { text: '正常', cls: 'text-green-500', rank: 5 },
};
const ISSUES: Health[] = ['stale', 'late', 'flat', 'empty'];
// 页面上的读法说明(写成一个字符串:JSX 里折行会在中文句子中间多出空格)
const NOTE =
  '落后天数:日频按工作日算(周五的点周一看 = 0),其余按日历天;月 / 季的日期记在数据所属期的第一天,门槛已把发布滞后算进去。' +
  '「疑似填平」= 日频末尾连续 5 个点完全相同(源停了、被前值填上的典型样子),政策利率这类阶梯序列不查。' +
  '以打开页面时取到的数据为准(部分接口在浏览器里只取一次),跨天看请刷新页面。';

// 派生 / 同值腿(hidden)不列:它们跟着源序列走,源有问题这里已经报了
const DEFS = REGISTRY.filter((d) => !d.hidden);
// 原始日线、不按页头周期聚合;7×24 的留周末(BTC 周日的点也算最新)
const REQUESTS: SeriesRequest[] = DEFS.map((d) => ({
  series: d.id,
  shift: 0,
  daily: true,
  ...(d.weekends && { weekends: true as const }),
}));

export function DataHealthPage() {
  const { points, isLoading, error, stale } = useSeriesData(REQUESTS, '1D');
  const [issuesOnly, setIssuesOnly] = useState(true);

  if (isLoading) return <p className="text-sm text-neutral-500">加载中…(约 {DEFS.length} 条序列)</p>;
  if (error) return <p className="text-sm text-amber-500">取数失败:{error.message}</p>;

  const today = new Date().toLocaleDateString('sv-SE');
  const rows = DEFS.map((d, i) => {
    const key = requestKey(REQUESTS[i]);
    const o = HEALTH_OVERRIDES[d.id];
    const notes = [stale.includes(key) && '源这次没拉到,沿用上次', o?.note].filter(Boolean);
    return { def: d, ...seriesHealth(points[key] ?? [], d.freq, today, o), note: notes.join(';') };
  }).sort((a, b) => STATUS[a.status].rank - STATUS[b.status].rank);
  const counts = Object.groupBy(rows, (r) => r.status);
  const shown = issuesOnly ? rows.filter((r) => ISSUES.includes(r.status)) : rows;

  return (
    <div className="flex h-full flex-col gap-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {(Object.keys(STATUS) as Health[]).map((s) => (
          <span key={s} className={STATUS[s].cls}>
            {STATUS[s].text} {counts[s]?.length ?? 0}
          </span>
        ))}
        <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-neutral-400">
          <Checkbox checked={issuesOnly} onCheckedChange={setIssuesOnly} />
          只看异常
        </label>
      </div>
      <p className="text-xs text-neutral-500">{NOTE}</p>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse">
          <thead className="sticky top-0 bg-neutral-950 text-left text-xs text-neutral-500">
            <tr>
              {['状态', '序列', '分类', '频率', '最新日期', '落后', '备注'].map((h) => (
                <th key={h} className="border-b border-neutral-800 px-2 py-1.5 font-normal">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.def.id} className="border-b border-neutral-900 hover:bg-neutral-900">
                <td className={cn('px-2 py-1 whitespace-nowrap', STATUS[r.status].cls)}>{STATUS[r.status].text}</td>
                <td className="px-2 py-1 text-neutral-200">
                  {r.def.label}
                  <span className="ml-1.5 text-xs text-neutral-600">{r.def.id}</span>
                </td>
                <td className="px-2 py-1 whitespace-nowrap text-neutral-400">{r.def.category}</td>
                <td className="px-2 py-1 text-neutral-400">{r.def.freq}</td>
                <td className="px-2 py-1 tabular-nums text-neutral-300">{r.latest ?? '—'}</td>
                <td className="px-2 py-1 whitespace-nowrap tabular-nums text-neutral-400">
                  {r.lag === undefined ? '—' : `${r.lag} ${r.def.freq === '日' ? '个工作日' : '天'}`}
                </td>
                <td className="px-2 py-1 text-xs text-neutral-500">{r.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length === 0 && <p className="py-6 text-center text-neutral-500">没有异常</p>}
      </div>
    </div>
  );
}
