// 固定面板的图层从报警规则表取分位背景带 / 参考线(shared/alertRules):阈值只在规则表里写一份,
// 画图和以后的每日扫描读的是同一条规则。用法:图层里写 `...ruleMarks('vix')`,替代手写 percentile / refLines。
import { type AlertRuleId, alertRule } from '../../../shared/alertRules';
import type { Layer } from './chartDoc';

export function ruleMarks(id: AlertRuleId): Pick<Layer, 'percentile' | 'refLines'> {
  const rule = alertRule(id);

  return {
    ...(rule.percentile && { percentile: rule.percentile }),
    ...(rule.levels && { refLines: rule.levels }),
  };
}
