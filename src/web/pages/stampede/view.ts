// 「踩踏监控」整页读数:实盘(各序列最新值)与情景模板(单日快照)整理成同一个形状,页面只认它。
// 判定全在 shared/calc/stampede(阶段、升级、清单)与 dims(亮灯),这里只取值、换口径。
import {
  type CheckItem,
  currentRun,
  escalateOn,
  latestStat,
  metricLevel,
  pauseChecklist,
  pauseChecklistAt,
  pctlOf,
  riskChecklist,
  riskChecklistAt,
  skewCollapse,
  type SeriesMap,
  type Stage,
  stageAt,
  stageSeries,
} from '../../../shared/calc/stampede';
import { DIMS, type Level } from './dims';
import { SCENARIOS, type ScenarioKey, scenarioSnapshot } from './scenarios';

/** 一条指标的读数;实盘另带数据日与 20 日变化 */
export type Reading = { value: number; pctl: number; date?: string; chg20?: number };

export type View = {
  template: ScenarioKey | null;
  read: Partial<Record<string, Reading>>;
  stage: Stage | null;
  /** 实盘:第 N 天、本轮起点、数据日 */
  run: { days: number; since: string; date: string } | null;
  /** null = 模板下不适用(断崖要看前 20 日,模板没有时间序列) */
  cliff: boolean | null;
  escalate: { on: boolean | null; date?: string };
  /** 实盘阶段四且 SKEW 刚坍塌:假暂歇风险偏高,页面加一行提示(模板没有时间序列,恒 false) */
  pauseAfterCollapse: boolean;
  risk: CheckItem[];
  pause: CheckItem[];
};

// 期限结构图另要 VIX9D / VIX3M 原值
const KEYS = [...DIMS.flatMap((d) => d.metrics.map((m) => m.key)), 'vix9d', 'vix3m'];

export function liveView(s: SeriesMap): View {
  const run = currentRun(stageSeries(s));
  const esc = s.stEscalate?.at(-1);
  const read = Object.fromEntries(
    KEYS.flatMap((k) => {
      const st = latestStat(s[k]);
      return st ? [[k, { value: st.value, pctl: st.pctl, date: st.date, chg20: st.chg20 }]] : [];
    }),
  );

  return {
    template: null,
    read,
    stage: run?.stage ?? null,
    run,
    cliff: run ? (s.stCliff ?? []).some((p) => p.date === run.date) : null,
    // P/C 缺 → null(无数据),别当「未触发」
    escalate: { on: esc ? esc.value === 1 : null, date: esc?.date },
    pauseAfterCollapse: run?.stage === 4 && !!skewCollapse(s.skew ?? [])?.collapsed,
    risk: riskChecklist(s),
    pause: pauseChecklist(s),
  };
}

/** 模板值的分位按当前实盘序列最近 5 年分布现算;GEX 只有给定分位、没有原值。 */
export function templateView(s: SeriesMap, key: ScenarioKey): View {
  const sc = SCENARIOS[key];
  const snap = scenarioSnapshot(key);
  const read: Record<string, Reading> = {
    ...Object.fromEntries(Object.entries(snap).map(([k, v]) => [k, { value: v, pctl: pctlOf(s[k] ?? [], v) }])),
    gex: { value: NaN, pctl: sc.gexPctl },
  };

  return {
    template: key,
    read,
    stage: stageAt(snap),
    run: null,
    cliff: null,
    escalate: { on: escalateOn(sc.values) },
    pauseAfterCollapse: false,
    risk: riskChecklistAt(snap, sc.gexPctl),
    pause: pauseChecklistAt(snap),
  };
}

/** 维度里每行的亮灯(undefined = 没数据);DSPX、SKEW 要看同一读法下的 VIX。 */
export function dimLevels(v: View): (Level | undefined)[][] {
  const vix = v.read.vix?.value ?? NaN;
  return DIMS.map((d) =>
    d.metrics.map((m) => {
      const r = v.read[m.key];
      return r ? metricLevel(m, r.value, r.pctl, vix) : undefined;
    }),
  );
}
