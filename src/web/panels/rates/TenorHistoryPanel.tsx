// src/web/panels/TenorHistoryPanel.tsx
import { useRef, useState } from 'react';
import { useYieldCurve } from './yieldCurve.hooks';
import { SERIES_COLORS } from '../../lib/palette';
import {
  tenorSeriesData,
  pickDefaultTenors,
  useTenorChart,
  type TenorSpec,
  type SpreadSpec,
} from './tenorHistory.hooks';
import { spreadSeries } from './rateSpread.hooks';
import { aggregate } from '../../lib/chart';
import { InfoTip } from '../../components/InfoTip';
import type { Interval } from '../../hooks/interval';

// 视图说明(按 source):同一曲线换时间横轴看各期限走势 + 利差。
const VIEW_DESC: Record<string, { title: string; desc: string }> = {
  treasury: {
    title: '期限走势',
    desc: [
      '定义:美债各期限收益率的时间走势。松紧读法与阈值都在下方 10Y−3M 差值 pane 的 ⓘ 里。',
      '',
      '⚠️ 判松紧刻意不用绝对利率水平,用差值——绝对水平只说贵不贵,不说在松还是在紧。',
      '   这几条期限线的用处是看「谁在动」(是短端被政策推,还是长端在重定价),方向判断交给差值。',
      '',
      '两端含义不对称,不是同一个东西的长短版:',
      '  · 短端 = 本国维度(美国经济 + 通胀 + 就业薪资 + 储蓄者补偿)',
      '  · 长端 = 全球维度(全球持有者的预期回报 = 全球无风险投资回报率)',
      '这就是美债曲线之所以是「全世界的锚」:短端反映美国本国,长端反映全球资产的隐含定价基准。',
    ].join('\n'),
  },
  sofr_ois: {
    title: 'OIS 走势',
    desc: [
      '定义:SOFR OIS(Eris par OIS)各期限的时间走势。下方是 1Y−3M 差值 pane,读法见那格的 ⓘ。',
      '',
      '⚠️ 是定价、不是预测,随数据反复改口。松紧看整条曲线,不看单点加减。',
      '⚠️ 降息定价 ≠ 宽松:短端降息 + 长期缩表 = P 松而 Q 紧,总流动性仍在收',
      '   → 判 PQ 象限须与净流动性并读。',
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
    '定义:10Y − 3M(虚线 = 0)。负 = 倒挂。',
    '',
    '⭐ 首要用途 = 读松紧,而且刻意不看绝对利率水平。',
    '  加息 / 降息是单一点,松 / 紧是整条曲线;衡量金融资产(尤其估值)要用曲线、不用单点。',
    '  正值(contango)= 松;负值(倒挂 / back)= 紧;',
    '  线往上(倒挂修复 / 陡峭化)= 由紧变松;线往下(走向倒挂)= 由松变紧。',
    '',
    '⭐ 同一条差值也是生产力 / 生产关系的浓缩温度计:',
    '  · 长端(10Y)= 生产力——已投下去的上游 AI 基建、相关电力与通胀。',
    '    生产力未被证明 / 证伪前长端不下来,故长端低位横住、走收敛三角。',
    '  · 短端(3M)= 生产关系——还没被生产力改变的资源分配 / 分工 / 就业 / 消费。',
    '  · 由此「冰火两重天」:上面投资热,下面消费冷。债商股汇的问题都压在这条曲线的证明 / 证伪上。',
    '  陡峭化只有两种收尾:生产力被证伪(基建全是债务)→ 崩;或生产关系被证明、短端 / 下游被带上去。',
    '',
    '⚠️ 「倒挂 = 衰退前兆」有前提,别当铁律。',
    '  该规律成立靠凯恩斯式逆周期:央行见倒挂就前置宽松 → 倒挂幅度始终有限 → 利差交易屡试不爽。',
    '  2022 起范式转向「以短端为锚」(供给侧通胀 + 薪资螺旋 + 服务黏性,央行主导控通胀、不被衰退呼声吓倒)',
    '  → 变成长端偏离短端(而非反之)→ 深度倒挂可长期持续 → 倒挂不再是可交易的衰退计时器。',
    '  副作用:「10Y 实际利率拟合黄金」这类方法在该周期失效,改用长短利差拟合度更高。',
    '',
    '⚠️ 转松(由负转正)未必是好消息:联储「预防式」只动短端、不碰长端时曲线同样会转松',
    '  ——那是在压波动率、为下游兑现换时间(爆金币后走了两波,每波压一次波动率),不是衰退已解除。',
    '  代价是在证明 / 证伪之间风险偏好略抬、估值越来越贵。',
    '',
    '循环(与波动率同步):扁平 / 倒挂(紧)→ 压低各类资产波动率 → 但同时积累风险',
    '  → 风险暴露、政策匆忙拉阔曲线(转松)→ 修复各部门资产负债表 → 再走向下一轮扁平。',
    '  低波周期尾声的观察特征(非铁律):曲线只剩几十 bp 倒挂,波动率却创历史新低。',
    '⚠️ 压到过低 + 过扁时,曲线本身就是脆弱性来源:凸性陷阱、长端买盘缺失、股债双杀。',
  ].join('\n'),
  sofr_ois: [
    '定义:OIS 1Y − 3M(虚线 = 0)。',
    '口径:3M ≈ 当前政策利率的近端锚,1Y = 未来一年隐含路径 → 价差 = 市场定价的政策方向与幅度。',
    '',
    '临界(三档阶梯):',
    '  · 负值 = 降息定价占主导',
    '  · 由负转正、约 +0.1 = 方向已转,市场「逐步靠近」隐含加息预期(尚未确认)',
    '  · ⭐ 超过 +0.25 = 开始计入加息预期(确认门槛)',
    '    条件语境:该门槛以「地缘 / 油价问题持续不解决」为前提——油价不退 → 通胀不退 → 短端被迫重定价。',
    '',
    '⚠️ 转负常是联储「只动短端」的预防式兜底在被定价(压波动率、换时间),非衰退已确认;',
    '   反向约束是通胀黏性:薪资 / Sticky CPI 不落,降息定价会被迫回吐。',
  ].join('\n'),
  jgb: '定义:10Y − 2Y(虚线 = 0)。看 BOJ 政策与 YCC 松绑向长端的传导:走阔 = 长端先松绑。',
  bei: '定义:10Y − 5Y BEI(虚线 = 0)。远端通胀补偿相对近端的差:正 = 市场把通胀风险定价在更远端。',
  ai_cds:
    '定义:Oracle − Apple 的 5Y CDS 特质溢价(bp,虚线 = 0)。剥掉宏观信用共同因子,只留甲骨文因 AI 举债被额外索取的那部分。',
};

// 时间横轴 × 每条线一个期限(pane 0)+ 利差(pane 1),共享时间轴。数据/存储不改,复用收益率曲线序列。
export function TenorHistoryPanel({
  source,
  interval,
  long,
  short,
  spreadLabel,
}: {
  source: string;
  interval: Interval;
  long: string;
  short: string;
  spreadLabel: string;
}) {
  const { data, isLoading, error, maxDate } = useYieldCurve(source);
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

  // 收起时传 null:hook 会摘掉 pane 1,期限线独占全高。
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

  useTenorChart(containerRef, specs, spread);

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
