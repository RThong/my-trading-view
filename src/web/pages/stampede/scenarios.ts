// 「踩踏监控」情景模板:付鹏原页 SCENARIOS 的 stage1 / stage2 / stage3_ext / stage4,只取我们有的键(vixVxv 即 vixVix3m)。
// GEX 原值是付鹏的 $B 朴素口径,和 Squeezemetrics 不同,改为直接给分位(docs/options-structure-panel-handoff.md §11)。
import type { Stage } from '../../../shared/calc/stampede';

export type ScenarioKey = 'stage1' | 'stage2' | 'stage3' | 'stage4';

type Values = Record<
  'vixeqVix' | 'dspx' | 'vix' | 'vvix' | 'vixVix3m' | 'vix9dVix' | 'skew' | 'pcEquity' | 'pcTotal' | 'pcIndex',
  number
>;

export type Scenario = {
  label: string;
  /** 按钮上写的阶段;按 §2 规则判出的阶段若对不上,在模板旁注明,不改规则 */
  stage: Stage;
  values: Values;
  gexPctl: number;
};

export const SCENARIOS: Record<ScenarioKey, Scenario> = {
  stage1: {
    label: '阶段一:离散繁荣稳态',
    stage: 1,
    values: {
      vixeqVix: 2.65,
      dspx: 44.5,
      vix: 14.2,
      vvix: 84,
      vixVix3m: 0.86,
      vix9dVix: 0.88,
      skew: 146,
      pcEquity: 0.52,
      pcTotal: 0.82,
      pcIndex: 1.05,
    },
    gexPctl: 80,
  },
  stage2: {
    label: '阶段二:偏度与个股预警',
    stage: 2,
    values: {
      vixeqVix: 2.12,
      dspx: 41,
      vix: 18.8,
      vvix: 102,
      vixVix3m: 0.96,
      vix9dVix: 0.98,
      skew: 166,
      pcEquity: 0.71,
      pcTotal: 1.01,
      pcIndex: 1.12,
    },
    gexPctl: 40,
  },
  stage3: {
    label: '阶段三升级:宏观全面防御',
    stage: 3,
    values: {
      vixeqVix: 1.35,
      dspx: 31.5,
      vix: 35.8,
      vvix: 142,
      vixVix3m: 1.14,
      vix9dVix: 1.11,
      skew: 132,
      pcEquity: 0.88,
      pcTotal: 1.34,
      pcIndex: 1.42,
    },
    gexPctl: 3,
  },
  stage4: {
    label: '阶段四:风暴暂歇',
    stage: 4,
    values: {
      vixeqVix: 1.72,
      dspx: 36,
      vix: 22.6,
      vvix: 101,
      vixVix3m: 0.96,
      vix9dVix: 0.94,
      skew: 134,
      pcEquity: 0.74,
      pcTotal: 1.08,
      pcIndex: 1.22,
    },
    gexPctl: 25,
  },
};

export const SCENARIO_KEYS = Object.keys(SCENARIOS) as ScenarioKey[];

/** 模板的完整快照:补上期限结构图要的 VIX3M = VIX ÷ (VIX/VIX3M)、VIX9D = VIX × (VIX9D/VIX)。 */
export function scenarioSnapshot(key: ScenarioKey): Record<string, number> {
  const v = SCENARIOS[key].values;
  return { ...v, vix3m: v.vix / v.vixVix3m, vix9d: v.vix * v.vix9dVix };
}
