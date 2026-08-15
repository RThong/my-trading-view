// src/web/panels/TenorHistoryPanel.tsx
import { useRef, useState } from 'react';
import useSWR from 'swr';
import { useYieldCurve } from './yieldCurve.hooks';
import { SERIES_COLORS } from '../../lib/palette';
import {
  tenorSeriesData,
  pickDefaultTenors,
  spotBars,
  useTenorChart,
  type TenorSpec,
  type SpreadSpec,
  type SpotSpec,
} from './tenorHistory.hooks';
import type { PriceBar } from '../asset/assetChart.hooks';
import { spreadSeries } from './rateSpread.hooks';
import { aggregate } from '../../lib/chart';
import { InfoTip } from '../../components/InfoTip';
import type { Interval } from '../../hooks/interval';

// 视图说明(按 source):同一曲线换时间横轴看各期限走势 + 利差。
const VIEW_DESC: Record<string, { title: string; desc: string }> = {
  treasury: {
    title: '期限走势',
    desc: [
      '定义:美债各期限收益率的时间走势。这几条线看「谁在动」——是短端被政策推,还是长端在重定价。',
      '两端不对称:短端 = 美国本国(经济 + 通胀 + 就业),长端 = 全球(全球无风险回报基准)。',
      '',
      '⚠️ 松紧判断不看这里,看下方差值 pane —— 绝对水平只说贵不贵,不说在松还是在紧。',
    ].join('\n'),
  },
  sofr_ois: {
    title: 'OIS 走势',
    desc: [
      '定义:SOFR OIS(Eris par OIS)各期限的时间走势 = 市场对未来隔夜利率(≈美联储路径)的定价。',
      '',
      '⚠️ 是定价、不是预测,会随数据反复改口。',
      '⚠️ 降息定价 ≠ 宽松:短端降息 + 长期缩表 = 利率松而总量紧,须与净流动性并读。',
    ].join('\n'),
  },
  jgb: {
    title: 'JGB 走势',
    desc: '定义:日本国债各期限收益率的时间走势。看 BOJ 政策与 YCC 松绑的传导;差值读法见下方 pane 的 ⓘ。',
  },
  bei: {
    title: '通胀走势',
    desc: '定义:盈亏平衡通胀率(BEI)各期限的时间走势。\nBEI = 名义 − TIPS 实际收益率 = 市场通胀补偿(含通胀风险溢价),可作预期代理但非纯预期。\n差值读法见下方 pane 的 ⓘ。',
  },
  ai_cds: {
    title: 'AI CDS',
    desc: '定义:AI 资本开支巨头 + 甲骨文的 5Y 单名 CDS 利差(bp)时间走势。\n数据:ICE Clear Credit 免费 EOD 结算价,由合约价线性近似成约定 spread(annuity=4.7 校准)。\n利差越高 = 市场定价的违约风险越大;甲骨文因 AI 举债显著高于同类,是 AI 信用风险风向标。\n特质溢价读法见下方 pane 的 ⓘ。',
  },
};

// 差值 pane(pane 1)自己的说明:利差的读法与阈值都归这里,别塞进上方视图说明。
const SPREAD_DESC: Record<string, string> = {
  treasury: [
    '定义:10Y − 1Y(虚线 = 0)。**读松紧的主指标** —— 松紧是整条曲线的事,不是加息降息那个单点。',
    '正值 = 松,负值(倒挂)= 紧;线往上(陡峭化)= 由紧变松,线往下 = 由松变紧。',
    '',
    '⚠️ 「倒挂 = 衰退前兆」不是铁律 —— 它靠央行见倒挂就前置宽松才成立。',
    '2022 起转成「以短端为锚」,深度倒挂可长期持续,不再是可交易的衰退计时器。',
    '⚠️ 转正未必是好消息:联储只动短端的预防式宽松同样会让曲线转松,那是换时间不是警报解除。',
    '⚠️ 短腿用 1Y 而非 3M(实测进场同日、出场早十个月);NY Fed 的衰退概率模型用 10Y−3M,口径不同。',
  ].join('\n'),
  sofr_ois: [
    '定义:OIS 1Y − 3M(虚线 = 0)= 市场定价的政策方向与幅度(3M ≈ 当前政策利率,1Y = 隐含路径)。',
    '  · 负值 = 降息定价占主导',
    '  · 转正、约 +0.1 = 方向已转,尚未确认',
    '  · ⭐ 超过 +0.25 = 开始计入加息预期(确认门槛;仅适用于油价 / 地缘压力持续不解的语境)',
    '',
    '⚠️ 是定价不是预测,会随数据反复改口;通胀黏性不落,降息定价会被迫回吐。',
  ].join('\n'),
  jgb: [
    '定义:10Y − 1Y(虚线 = 0)。看 BOJ 政策与 YCC 松绑向长端的传导。',
    '走阔 = 长端先松绑;收窄 / 转负 = 短端相对更高,或长端重新被压住。',
    '',
    '⚠️ 短腿刻意与美债那格统一成 1Y,为的是两边能并排读同一个东西(换掉 2Y 对形状几乎无影响)。',
  ].join('\n'),
  bei: '定义:10Y − 5Y BEI(虚线 = 0)。远端通胀补偿相对近端的差:正 = 市场把通胀风险定价在更远端。',
  ai_cds:
    '定义:Oracle − Apple 的 5Y CDS 特质溢价(bp,虚线 = 0)。剥掉宏观信用共同因子,只留甲骨文因 AI 举债被额外索取的那部分。',
};

const getJson = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(String(r.status));
    return r.json();
  });
const SWR_OPTS = { revalidateOnFocus: false, revalidateIfStale: false, revalidateOnReconnect: false };

// 时间横轴 × 每条线一个期限 + 利差(+ 可选的现货蜡烛),共享时间轴。
// 数据/存储不改,复用收益率曲线序列;现货走已有的 /api/price/:underlying。
export function TenorHistoryPanel({
  source,
  interval,
  long,
  short,
  spreadLabel,
  spot,
}: {
  source: string;
  interval: Interval;
  long: string;
  short: string;
  spreadLabel: string;
  /** 现货参照标的(如 'BTC')。省略 = 不画这一格 —— 只有真的相关的那个 tab 才配。 */
  spot?: string;
}) {
  const { data, isLoading, error, maxDate } = useYieldCurve(source);
  // 只有配了 spot 的 tab 才发这个请求(SWR 的 key 传 null = 不请求)。
  const spotRes = useSWR<PriceBar[]>(spot ? `/api/price/${spot}` : null, getJson, SWR_OPTS);
  const containerRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showSpread, setShowSpread] = useState(true);

  // 数据到位后种一次默认勾选(按 source)。渲染中条件 setState + seeded 单调标志替代 effect。
  const [seeded, setSeeded] = useState(false);
  if (!seeded && maxDate && selected.size === 0) {
    setSelected(new Set(pickDefaultTenors(source, data.tenors)));
    setSeeded(true);
  }

  // 期限固定配色:按 tenors 序号取色(勾/取消不改色)。
  const colorOf = (tenor: string) => SERIES_COLORS[data.tenors.indexOf(tenor) % SERIES_COLORS.length];

  const specs: TenorSpec[] = data.tenors
    .filter((t) => selected.has(t))
    .map((t) => ({ tenor: t, color: colorOf(t), data: tenorSeriesData(data.series[t], interval) }));

  // 收起时传 null:hook 会摘掉那个 pane,期限线独占全高。
  const spread: SpreadSpec | null = showSpread
    ? {
        label: spreadLabel,
        color: SERIES_COLORS[0],
        data: aggregate(
          spreadSeries(data.series[long], data.series[short]).map((p) => ({ time: p.date, value: p.value })),
          interval,
        ),
      }
    : null;

  // 没配 spot、或数据还没到 → null,不建那个 pane(而不是建一个空 pane 占着高度)。
  const spotBarsData = spotBars(spotRes.data, interval);
  const spotSpec: SpotSpec | null = spot && spotBarsData.length ? { label: spot, data: spotBarsData } : null;

  useTenorChart(containerRef, specs, spread, spotSpec);

  const toggle = (t: string) =>
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(t)) n.delete(t);
      else n.add(t);
      return n;
    });

  // 容器必须常驻:三态若提前 return 会卸载 containerRef,建图 effect 首帧拿不到节点、
  // 数据到位后依赖没变又不重跑 → 图永远建不出。故 loading/error/无数据一律作浮层,对齐 PaneChartView。
  const view = VIEW_DESC[source];

  return (
    <div className="flex h-full flex-col gap-3">
      {/* 工具条:视图说明(label + ⓘ)+ 差值 pane(▾ 显隐 + label + ⓘ) */}
      <div className="flex flex-wrap items-center gap-1.5 self-start text-xs">
        {view && (
          <div className="flex items-center gap-0.5 rounded border border-neutral-700 px-1 py-0.5">
            <span className="text-neutral-300">{view.title}</span>
            <InfoTip text={view.desc} />
          </div>
        )}
        <div className="flex items-center gap-0.5 rounded border border-neutral-700 px-1 py-0.5">
          <button
            onClick={() => setShowSpread((v) => !v)}
            title={showSpread ? '收起差值' : '展开差值'}
            className="px-1 text-neutral-300"
          >
            {showSpread ? '▾' : '▸'}
          </button>
          <span className={showSpread ? 'text-neutral-300' : 'text-neutral-600'}>{spreadLabel}</span>
          {SPREAD_DESC[source] && <InfoTip text={SPREAD_DESC[source]} />}
        </div>
      </div>
      {/* 期限 chip 多选:颜色 = 线色 */}
      <div className="flex flex-wrap gap-1.5">
        {data.tenors.map((t) => {
          const on = selected.has(t);
          return (
            <button
              key={t}
              onClick={() => toggle(t)}
              className={`flex items-center gap-1 rounded border px-2 py-0.5 text-xs ${on ? 'border-neutral-500 text-neutral-200' : 'border-neutral-800 text-neutral-600'}`}
            >
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: on ? colorOf(t) : '#3f3f46' }} />
              {t}
            </button>
          );
        })}
      </div>
      <div className="relative min-h-0 flex-1">
        <div ref={containerRef} className="h-full w-full" />
        {error && <p className="absolute left-2 top-2 text-xs text-red-400">加载失败:{error.message}</p>}
        {isLoading && <p className="absolute left-2 top-2 text-xs text-neutral-500">加载中…</p>}
        {!isLoading && !error && !maxDate && (
          <p className="absolute left-2 top-2 text-xs text-amber-500">
            暂无数据{data.unavailable.length ? `(全部序列缺失:${data.unavailable.join(', ')})` : ''}
          </p>
        )}
      </div>
    </div>
  );
}
