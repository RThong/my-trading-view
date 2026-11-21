// 「踩踏监控」视角:期权结构 / 流动性踩踏的状态背景板(与恐慌同步,不是择时信号)。
// 版面一比一照付鹏原页(v3,见 docs/options-structure-panel-handoff.md §11):页头(维度分 + 判定)→ 情景按钮 → 四阶段卡
// → 三张图卡 → 五维度卡 → 复盘清单 → 历史图(默认展开,可收起)。情景按钮载入付鹏的模板值、整页随之重算,只作参照。
// 判定都在 shared/calc/stampede 与 dims,这里只取数和摆放。
import { RotateCcw } from 'lucide-react';
import { useMemo, useState } from 'react';
import { InfoTip } from '../../components/InfoTip';
import { Button } from '../../components/ui/button';
import type { Interval } from '../../hooks/interval';
import { cn } from '../../lib/utils';
import { DocChart } from '../../views/chartDoc/DocChart';
import { useRegimeData } from '../../views/regime/regimeChart.hooks';
import {
  type CheckItem,
  dimScore,
  type Stage,
  STRESS_KEYS,
  stressPeak,
  stressScore,
} from '../../../shared/calc/stampede';
import { DealerCard, FlowCard, TermCard } from './ChartCards';
import { DimCards, Score } from './DimCards';
import { DIMS } from './dims';
import { STAMPEDE_HISTORY } from './historyDoc';
import { SCENARIO_KEYS, SCENARIOS, type ScenarioKey } from './scenarios';
import { CARD, md, Pill, SectionTitle, STAGE_TONE, TONE, type Tone } from './ui';
import { useFlush } from './useFlush';
import { dimLevels, liveView, templateView, type View } from './view';

const RULES = [
  '定位:与恐慌同步的状态背景板,不是择时信号。回测里进入阶段三平均只领先恐慌起点 1~3 个交易日。',
  '',
  '阶段(每日独立判定、无记忆,优先级 三 → 一 → 四 → 二):',
  '  三 风暴:VIX ≥ 26 且(VIX/VIX3M ≥ 1 或 VVIX ≥ 110)',
  '  一 稳态:VIX < 18 且 SKEW < 158',
  '  四 风暴暂歇:VIX/VIX3M < 1 且 VVIX < 110 且 SKEW < 155 且 VIXEQ/VIX < 2.0',
  '  二 预警 / 过渡:其余',
  '付鹏原规则另有的条款我们没有数据,已删去:三的「DealerGamma ≤ −4.5 且 GEX ≤ −50B」、一的「DealerGamma ≥ 1.5 且 GEX ≥ 25B」、四的「NetDelta ≥ 0 且 GEX < 25B」。',
  '',
  '断崖:VIXEQ/VIX 分位在前 20 个交易日里最高 ≥ 90,当日 ≤ 50(常比阶段三早几天:2024-08-02→08-05、2026-03-03→03-06)。模板没有时间序列,断崖不适用。',
  '升级:指数 P/C ≥ 1.25 且个股 P/C ≥ 0.80(P/C 晚一天发,判最近有数据的那天)。',
  '',
  '历史分布(2018-01 ~ 2026-11,标普 21 日前瞻;基准:收益中位 +1.7%、回撤 ≥5% 占 18%):',
  '  一 稳态        占 47.8%   收益中位 +1.4%   回撤 ≥5% 14%',
  '  二 预警 / 过渡  占 23.2%   收益中位 +1.4%   回撤 ≥5% 18%',
  '  三 风暴        占 10.5%   收益中位 +5.1%   回撤 ≥5% 23%',
  '  四 风暴暂歇     占 18.5%   收益中位 +1.5%   回撤 ≥5% 28%',
  '读法:阶段三 = 已在风暴里、两头放大(多数随后反弹,不是卖出信号);阶段四 = 风暴暂歇、不是见底确认(2022 年 5–6 月 VIX 28–30 时多次闪现,之后回撤比例高于基准)。',
  '15 次恐慌中阶段三命中 12 次(漏 2018-04、2023-10 两次纯回撤与 2018-11 晚 18 天),误报 7 段、每段 1–2 天。样本小,只作方向参考。',
].join('\n');

const SCORE_NOTE = [
  '综合压力分(0–100):照付鹏原页「综合压力指数」的分段线性给分(VIX 14→36、VVIX 85→135、两个期限比值 0.88→1.12、VIXEQ/VIX 2.5→1.35、三个 P/C 各自区间)。',
  '与原页的区别:做市商 30 分里我们只有 GEX —— GEX 保留原页的 12 分,改按自身滚动 5 年分位给(P50 以上 0 分、P5 及以下满分;原页按 $B 的公式套到 Squeezemetrics 口径上几乎恒为 1~2 分);Dealer Gamma / Net Delta 的 18 分没数据,按原权重比例匀给其余各项(×88/70)。',
  '2019-10 起回测:0–20 分之后 21 日回撤 ≥5% 约 9%,20–60 约 20%,60 以上约 28%;分数越高之后反弹也越大 —— 高分 = 已在风暴里,不是卖出信号。',
  '',
  '维度分 = 本维度每个指标按付鹏线计分(触发红线 100、警戒 50、正常 0)后取平均,和总分是两套口径:总分看压力多大,维度分看几条线亮了。',
  '缺数的指标不计入平均,分数旁标「缺 n 项」;全缺显示 —。DSPX、SKEW 的红线要看同日 VIX,VIX 缺时这两行算缺数。',
  'GEX 没有可用的付鹏线,按滚动 5 年分位:≤ 5 记红、≤ 20 记黄。',
  '分数只表示「本维度几条线亮了」,不是概率。',
  '',
  '卡片横条 = 截至前一交易日的滚动 5 年分位(0–100),圆点 = 当前分位,细竖线 = 付鹏红线在 2018 起历史上的分位。悬停一行看原值、分位与 20 日变化。',
  '模板下的分位 = 模板值在当前实盘序列最近 5 年分布里的位置。',
].join('\n');

// 四阶段卡照付鹏原文案;阶段四改名「风暴暂歇」(回测里它之后的回撤比例高于基准,不是修复)
const STAGE_CARD: Record<Stage, { name: string; desc: string }> = {
  1: { name: '缩圈与离散稳态期', desc: '卖指数波 + 买个股波压低相关性;做市商正 Gamma 充当阻尼器,机械买盘托举权重股。' },
  2: {
    name: '拥挤见顶与先遣撤退期',
    desc: 'CBOE SKEW 飙升至 160~170 抢买尾部险;个股 P/C 率先筑底抬头,龙头上升通道松动。',
  },
  3: {
    name: '负反馈翻转与 Vanna 踩踏加速期',
    desc: '离散平仓、VIX > 28 且期限倒挂、VVIX 破红线;负 Gamma 与 Vanna 双重逼迫做市商砸盘。',
  },
  4: { name: '风暴暂歇', desc: '月度 OPEX 交割重置叠加 Put 获利了结;VVIX 回落与倒挂收窄,空头回补。暂歇不是见底确认。' },
};
const STAGES: Stage[] = [1, 2, 3, 4];
const CN_NUM = ['一', '二', '三', '四'];

const CHAIN = [
  { text: '相关性抬升' },
  { text: '离散交易亏损平仓' },
  { text: '机械买盘消失 & 负 Gamma / 负 Delta 挤压' },
  { text: 'VIX / VVIX 跳升 & 期限倒挂' },
  { text: 'Vanna 触发', tone: 'amber' as Tone },
  { text: '机械式砸盘加速器', tone: 'red' as Tone },
];

// 清单每项下面一行灰字(照原页的 sub),与 shared/calc 里清单的顺序一一对应
const RISK_SUB = [
  '确认拥挤个股去杠杆向全市场扩散',
  '机构宏观防御全面打满',
  '做市商缓冲击穿历史低位(按 GEX 自身分位)',
  'Vanna 螺旋持续强化,对冲工具维持挤兑',
];
const PAUSE_SUB = [
  '交割重置后做市商敞口回拉',
  '对 VIX 看涨期权的抢筹退潮',
  '期限结构由倒挂恢复升水,解除 Vanna 倒挂条件',
  '离散交易平仓止血,隐含相关性停止飙升',
];

function stageTitle(v: View) {
  if (v.stage === null) return '阶段判定所需序列暂缺';
  const upgraded = v.stage === 3 && v.escalate.on;
  return upgraded ? '阶段三升级:Vanna 踩踏与宏观全面防御' : `阶段${CN_NUM[v.stage - 1]}:${STAGE_CARD[v.stage].name}`;
}

/** naText:on 为 null 时写什么(模板下的断崖 = 不适用;实盘缺 P/C = 无数据) */
function Lamp({ label, on, title, naText }: { label: string; on: boolean | null; title: string; naText: string }) {
  return (
    <span className="flex items-center gap-1 text-xs text-neutral-400" title={title}>
      {label}
      <span
        className={cn(
          'inline-block h-2.5 w-2.5 rounded-full',
          on === null ? 'border border-dashed border-neutral-600' : on ? 'bg-red-500' : 'border border-neutral-500',
        )}
      />
      {on === null && <span className="text-[10px] text-neutral-500">{naText}</span>}
    </span>
  );
}

/** 总分要的读数:各指标原值 + GEX 分位(模板下 GEX 只有分位) */
function stressRead(v: View): Partial<Record<string, number>> {
  return Object.fromEntries(
    STRESS_KEYS.map((k) => [k, k === 'gexPctl' ? (v.read.gex?.pctl ?? NaN) : (v.read[k]?.value ?? NaN)]),
  );
}

function Header({
  v,
  stress,
  peak,
  scores,
  missing,
  liveDate,
  onPick,
}: {
  v: View;
  stress: { total: number; missing: number };
  /** 实盘阶段三时:近 20 个交易日综合压力峰值与已回落多少(其余时候 null,不显示) */
  peak: ReturnType<typeof stressPeak>;
  scores: number[];
  missing: number[];
  liveDate?: string;
  onPick: (k: ScenarioKey | null) => void;
}) {
  const tone = v.stage === null ? null : TONE[STAGE_TONE[v.stage]];
  const sc = v.template && SCENARIOS[v.template];
  const pcDate = v.read.pcIndex?.date;
  const btn = (active: boolean) =>
    cn(
      'rounded-md border px-3 py-1.5 text-xs font-medium transition-colors',
      active
        ? 'border-neutral-100 bg-neutral-100 font-semibold text-neutral-900'
        : 'border-neutral-800 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100',
    );

  return (
    <header className={cn(CARD, 'py-3.5')}>
      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="rounded bg-neutral-100 px-2 py-0.5 text-[11px] font-semibold tracking-wider text-neutral-900">
              STAMPEDE MONITOR
            </span>
            <h1 className="text-lg font-bold tracking-tight text-neutral-100">美股期权微观结构与流动性踩踏监控</h1>
            <InfoTip text={RULES} />
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-500">
            <span>
              数据基准:
              <strong className="font-medium text-neutral-300">
                {sc ? `模板「${sc.label}」` : v.run ? `${v.run.date}${pcDate ? `(P/C 截至 ${md(pcDate)})` : ''}` : '—'}
              </strong>
            </span>
            <span className="text-neutral-700">|</span>
            <span>口径:CBOE / Squeezemetrics,分位 = 滚动 5 年</span>
          </p>
        </div>

        <div className="flex flex-wrap items-stretch gap-3">
          {/* 原页「综合压力指数」的位置:总分(方案 A)+ 五个维度分并排 */}
          <div className="flex items-center gap-3 rounded-lg border border-neutral-800 bg-neutral-900 px-3.5 py-2">
            <div className="border-r border-neutral-800 pr-3">
              <div className="text-[10px] leading-none whitespace-nowrap text-neutral-500">综合压力</div>
              <div className="mt-1 flex items-baseline gap-1">
                <Score score={stress.total} missing={stress.missing} size="xl" />
                <span className="text-[10px] text-neutral-500">/ 100</span>
              </div>
              {peak && (
                <div className="mt-1 text-[10px] leading-none whitespace-nowrap text-neutral-500">
                  {peak.drop > 0
                    ? `近 20 日峰值 ${peak.peak}(${md(peak.date)}),已回落 ${peak.drop}`
                    : '近 20 日峰值即最新'}
                </div>
              )}
            </div>
            <div className="flex items-center text-[11px] font-medium leading-tight text-neutral-500">
              维度分
              <InfoTip text={SCORE_NOTE} className="ml-1 h-3.5 w-3.5 text-[9px]" />
            </div>
            {DIMS.map((d, i) => (
              <div key={d.title} className="min-w-12">
                <div className="text-[10px] leading-none whitespace-nowrap text-neutral-500">{d.title}</div>
                <div className="mt-1">
                  <Score score={scores[i]} missing={missing[i]} size="xl" />
                </div>
              </div>
            ))}
          </div>
          <div className={cn('rounded-lg border px-3.5 py-2', tone ? [tone.soft, tone.border] : 'border-neutral-800')}>
            <div className="text-[11px] font-medium leading-none text-neutral-500">系统自动判定阶段</div>
            <div className="mt-1.5 flex items-center gap-2">
              <span className={cn('h-2 w-2 rounded-full', tone ? tone.dot : 'bg-neutral-600')} />
              <span className={cn('text-sm font-bold leading-none', tone ? tone.text : 'text-neutral-500')}>
                {stageTitle(v)}
              </span>
            </div>
            <div className="mt-1.5 text-[11px] leading-none text-neutral-500">
              {v.run
                ? `第 ${v.run.days} 天,本轮自 ${md(v.run.since)} 起${v.pauseAfterCollapse ? ` · ${COLLAPSE_HINT}` : ''}`
                : !sc
                  ? '' // 标题已写「暂缺」,这里不重复
                  : v.stage !== sc.stage
                    ? `按 §2 规则判出与按钮(阶段${CN_NUM[sc.stage - 1]})不符,未改规则`
                    : '模板单日判定,无「本轮」'}
            </div>
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-neutral-800 pt-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-xs font-medium text-neutral-500">情景推演:</span>
          <button type="button" className={btn(v.template === null)} onClick={() => onPick(null)}>
            {liveDate ? `当前实盘(${md(liveDate)})` : '当前实盘'}
          </button>
          {SCENARIO_KEYS.map((k) => (
            <button key={k} type="button" className={btn(v.template === k)} onClick={() => onPick(k)}>
              {SCENARIOS[k].label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-md border border-neutral-700 px-3 py-1.5 text-xs font-semibold text-neutral-300 hover:bg-neutral-800"
          onClick={() => onPick(null)}
        >
          <RotateCcw className="h-3.5 w-3.5 text-neutral-500" />
          重置为实盘
        </button>
      </div>
    </header>
  );
}

function TemplateBanner({ k }: { k: ScenarioKey }) {
  const sc = SCENARIOS[k];
  return (
    <div className="rounded-lg border border-amber-400/60 bg-amber-400/10 px-4 py-2.5 text-sm text-amber-400">
      <strong>模板示例,非实盘数据</strong>
      <span className="ml-2 text-xs">
        {`「${sc.label}」取自付鹏原页的情景值;分位按当前实盘序列最近 5 年分布现算;GEX 直接给分位 P${sc.gexPctl};断崖要看前 20 日,模板下不适用。`}
      </span>
    </div>
  );
}

const COLLAPSE_HINT = '偏斜坍塌后的暂歇:历史上约 3 成之后 21 日内又跌 ≥5%';
const COLLAPSE_NOTE = [
  'SKEW 较前 60 个交易日高点已回落 ≥ 20 点。付鹏 2026-11-21「SKEW 先行 VIX 后至」:冲击落地后机构了结尾部 Put,偏斜溢价坍塌 —— 这时阶段四里「SKEW < 155」这一条是保护被平掉,不是风险消退。',
  '2018 起回测阶段四共 79 段:进入时偏斜坍塌的 27 段里 8 段之后 21 日又跌 ≥ 5%(30%),其余 52 段只有 7 段(13%)。典型:2025-03-14 ~ 03-27 判暂歇,4 月关税冲击又跌约 10%。',
  '只做提示、不改阶段(阶段规则照付鹏原版)。样本小,只作方向参考。',
].join('\n');

const FLUSH_NOTE = [
  '出清(试行,只做提示、不改阶段):SKEW 较前 60 日高点回落 ≥ 20 点(尾部 Put 了结、偏斜坍塌)+ VIX ≥ 25 + 防御(XLP)与进攻(XLK)板块 10 日都跌 ≥ 3%(高切低转通杀)。最近 10 个交易日内触发过就亮。',
  '依据:付鹏 2026-11-21「SKEW 先行 VIX 后至」、11-20「高切低转通杀」。',
  '2018 起回测 7 次:5 次两周内见局部低点、之后只再跌 1%~8%;2020-02、2022-05 两次之后又大跌(熊市里通杀一轮接一轮),所以不代表阶段结束。2024-08(防御板块没跌)没触发。',
].join('\n');

/** flush:实盘下最近一次出清日(null = 近 10 日没有),模板下不适用 */
function StageSection({ v, flush }: { v: View; flush: { ready: boolean; date: string | null } }) {
  const flushOn = v.template || !flush.ready ? null : flush.date !== null;
  return (
    <section className={CARD}>
      <SectionTitle
        right={
          <span className="flex flex-wrap items-center gap-3">
            {v.escalate.on && <Pill tone="red">已触发:宏观全面防御升级</Pill>}
            <Lamp
              label="断崖"
              on={v.cliff}
              naText={v.template ? '不适用' : '无数据'}
              title="VIXEQ/VIX 分位在前 20 个交易日里最高 ≥ 90、当日 ≤ 50(高位断崖回落)"
            />
            <Lamp
              label={`升级${v.escalate.date && v.run && v.escalate.date !== v.run.date ? `(${md(v.escalate.date)})` : ''}`}
              on={v.escalate.on}
              naText="无数据"
              title="指数 P/C ≥ 1.25 且个股 P/C ≥ 0.80"
            />
            <Lamp
              label={`出清(试行)${flushOn && flush.date !== v.run?.date ? `(${md(flush.date ?? '')})` : ''}`}
              on={flushOn}
              naText={v.template ? '不适用' : '无数据'}
              title={FLUSH_NOTE}
            />
          </span>
        }
      >
        期权微观结构四阶段演化与负反馈闭环
      </SectionTitle>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {STAGES.map((n) => {
          const current = v.stage === n;
          const t = TONE[STAGE_TONE[n]];
          return (
            <div
              key={n}
              className={cn(
                'rounded-lg border p-3',
                current ? [t.border, t.soft, 'ring-1 ring-inset'] : 'border-neutral-800 opacity-75',
              )}
            >
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold tracking-wider text-neutral-500">STAGE 0{n}</span>
                <span
                  className={cn(
                    'rounded px-2 py-0.5 text-[11px]',
                    current ? [t.fill, t.text, 'font-semibold'] : 'bg-neutral-800 text-neutral-500',
                  )}
                >
                  {current ? '当前激活' : v.stage !== null && n < v.stage ? '已演进' : '观察中'}
                </span>
              </div>
              <div className="mt-1 text-sm font-bold text-neutral-100">{STAGE_CARD[n].name}</div>
              <p className="mt-1 text-xs leading-relaxed text-neutral-500">{STAGE_CARD[n].desc}</p>
              {n === 4 && current && v.pauseAfterCollapse && (
                <p className="mt-1.5 flex items-center text-xs text-amber-500">
                  {COLLAPSE_HINT}
                  <InfoTip text={COLLAPSE_NOTE} className="h-3.5 w-3.5 text-[9px]" />
                </p>
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-y-1.5 rounded-md border border-neutral-800 bg-neutral-900 px-3.5 py-2.5 text-xs">
        <span className="mr-2 shrink-0 font-bold text-neutral-200">核心负反馈传导链:</span>
        <div className="flex flex-wrap items-center gap-1.5 font-medium text-neutral-300">
          {CHAIN.map((c, i) => (
            <span key={c.text} className="flex items-center gap-1.5">
              {i > 0 && <span className="text-neutral-600">→</span>}
              <span
                className={cn(
                  'rounded border px-2 py-0.5',
                  c.tone
                    ? [TONE[c.tone].soft, TONE[c.tone].border, TONE[c.tone].text, 'font-semibold']
                    : 'border-neutral-700',
                )}
              >
                {c.text}
              </span>
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

function tagOf(x: CheckItem, tone: Tone) {
  if (x.na) return { text: '不适用', cls: 'border-neutral-700 text-neutral-500' };
  if (x.on === null) return { text: '无数据', cls: 'border-amber-400/50 text-amber-400' };
  if (!x.on) return { text: '未触发', cls: 'border-neutral-700 text-neutral-500' };
  return { text: '已触发', cls: cn(TONE[tone].fill, TONE[tone].text, TONE[tone].border, 'font-semibold') };
}

function Checklist({
  title,
  hint,
  tone,
  items,
  subs,
}: {
  title: string;
  hint: string;
  tone: Tone;
  items: CheckItem[];
  subs: string[];
}) {
  const t = TONE[tone];
  return (
    <div className={cn('rounded-lg border p-3.5', t.border, 'bg-neutral-900/40')}>
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
        <h3 className={cn('flex items-center gap-1.5 text-xs font-bold tracking-wide', t.text)}>
          <span className={cn('h-2 w-2 rounded-full', t.dot)} />
          {title}
        </h3>
        <span className={cn('text-[11px] font-medium', t.text)}>{hint}</span>
      </div>
      <div className="space-y-2">
        {items.map((x, i) => {
          const tag = tagOf(x, tone);
          const note = [x.date && `判定日 ${x.date}`, x.proxy, x.na].filter(Boolean).join('\n');
          return (
            <div
              key={x.label}
              title={note}
              className={cn(
                'rounded-md border p-2.5',
                x.on ? [t.border, t.soft] : 'border-neutral-800 bg-neutral-950/40',
              )}
            >
              <div className="flex flex-wrap items-center justify-between gap-1.5">
                <span
                  className={cn('text-xs font-semibold leading-snug', x.on ? 'text-neutral-100' : 'text-neutral-300')}
                >
                  {x.label}
                  {x.proxy && <span className="ml-1.5 text-[11px] font-normal text-neutral-500">替代</span>}
                </span>
                <span className={cn('shrink-0 rounded border px-1.5 py-0.5 text-[10px]', tag.cls)}>{tag.text}</span>
              </div>
              <div className="mt-0.5 text-[11px] text-neutral-500">{x.na ? `${subs[i]} · ${x.na}` : subs[i]}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ChecklistSection({ v }: { v: View }) {
  const count = (items: CheckItem[]) => items.filter((x) => x.on).length;
  return (
    <section className={CARD}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-neutral-800 pb-2.5">
        <div>
          <SectionTitle>每日复盘 Checklist(指标自动判定)</SectionTitle>
          <p className="-mt-2 text-[11px] text-neutral-500">
            左侧监控「踩踏向宏观全面防御扩散」,右侧监控「交割重置与风暴暂歇」;「替代」= 原条款无数据,换成我们有的指标
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Pill tone="red" className="text-xs tabular-nums">
            风险触发 {count(v.risk)}/{v.risk.length}
          </Pill>
          <Pill tone="green" className="text-xs tabular-nums">
            暂歇触发 {count(v.pause)}/{v.pause.length}
          </Pill>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Checklist
          title="风险升级确认项(向全市场扩散)"
          hint="满足越多,下行加速风险越高"
          tone="red"
          items={v.risk}
          subs={RISK_SUB}
        />
        <Checklist
          title="风暴暂歇确认项(空头回补)"
          hint="满足越多,空头回补概率越高"
          tone="green"
          items={v.pause}
          subs={PAUSE_SUB}
        />
      </div>
    </section>
  );
}

export function StampedePage({ interval }: { interval: Interval }) {
  const { data, isLoading, error } = useRegimeData();
  const [template, setTemplate] = useState<ScenarioKey | null>(null);
  const [showHistory, setShowHistory] = useState(true);
  const s = data.series;
  // 实盘要扫全段序列判阶段、算分位,切模板时不必重算
  const live = useMemo(() => liveView(s), [s]);
  const flush = useFlush(s);
  const v = template ? templateView(s, template) : live;
  const levels = dimLevels(v);
  const scores = levels.map(dimScore);
  const missing = levels.map((ls) => ls.filter((l) => l === undefined).length);
  const dealer = DIMS.findIndex((d) => d.title === '做市商');

  if (isLoading) return <p className="text-sm text-neutral-500">加载中…</p>;
  if (error) return <p className="text-sm text-amber-500">取数失败:{error.message}</p>;
  return (
    // 宽屏限宽居中,两边留白(内容区超过 1600px 时)
    <div className="h-full overflow-y-auto pr-1 pb-4">
      <div className="mx-auto max-w-[1600px] space-y-5">
        <Header
          v={v}
          stress={stressScore(stressRead(v))}
          peak={!template && live.stage === 3 ? stressPeak(s.stStress ?? []) : null}
          scores={scores}
          missing={missing}
          liveDate={live.run?.date}
          onPick={setTemplate}
        />
        {template && <TemplateBanner k={template} />}
        <StageSection v={v} flush={flush} />
        <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <TermCard v={v} />
          <FlowCard v={v} levels={levels} />
          <DealerCard v={v} gexLevel={levels[dealer][0]} />
        </section>
        <section>
          <SectionTitle
            right={
              <span className="flex items-center gap-3 text-[11px] text-neutral-500">
                {(['green', 'amber', 'red'] as const).map((t) => (
                  <span key={t} className="inline-flex items-center gap-1">
                    <span className={cn('h-2 w-2 rounded-full', TONE[t].dot)} />
                    {{ green: '正常', amber: '警戒', red: '触发红线' }[t]}
                  </span>
                ))}
              </span>
            }
          >
            五大维度核心指标监控{template ? '(模板值)' : ''}
          </SectionTitle>
          <DimCards read={v.read} levels={levels} scores={scores} template={!!template} />
        </section>
        <ChecklistSection v={v} />
        <section>
          <Button variant="ghost" size="sm" onClick={() => setShowHistory((x) => !x)}>
            {showHistory ? '收起历史' : '看历史(标普 + 阶段三红底 + 综合压力分)'}
          </Button>
          {showHistory && (
            <div className="mt-2 h-[420px]">
              <DocChart doc={STAMPEDE_HISTORY} interval={interval} pageScroll />
            </div>
          )}
        </section>
        <footer className="py-2 text-center text-[11px] text-neutral-600">
          状态背景板,与恐慌同步、不是择时信号;仅作复盘参考,不构成投资建议
        </footer>
      </div>
    </div>
  );
}
