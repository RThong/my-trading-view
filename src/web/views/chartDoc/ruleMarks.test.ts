import { describe, expect, test } from 'bun:test';
import { ALERT_RULES } from '../../../shared/alertRules';
import { REGIME_DOCS } from '../../pages/regimeDims';
import { ruleMarks } from './ruleMarks';

// 固定面板里带阈值(分位带 / 参考线)的图层,连同所在面板
const MARKED = Object.entries(REGIME_DOCS).flatMap(([at, doc]) =>
  doc.panes.flatMap((p) => p.layers.filter((l) => l.percentile || l.refLines).map((layer) => ({ at, layer }))),
);

// 守「阈值只写一份」:面板里的阈值必须来自规则表,规则写了就得有地方用,输入 / 面板对得上
describe('报警规则表与固定面板', () => {
  test.each(MARKED.map((m) => [`${m.at}:${m.layer.title ?? m.layer.series}`, m] as const))(
    '%s 的阈值来自一条规则(输入、面板、画法都对得上)',
    (_, { at, layer }) => {
      const input = {
        series: layer.series,
        ...(layer.calc && { calc: { op: layer.calc.op, series: layer.calc.series } }),
      };
      const rules = ALERT_RULES.filter((r) => r.at === at && JSON.stringify(r.input) === JSON.stringify(input));
      expect(rules).toHaveLength(1);
      expect({ percentile: layer.percentile, refLines: layer.refLines }).toEqual({
        percentile: undefined,
        refLines: undefined,
        ...ruleMarks(rules[0].id),
      });
    },
  );

  test('每条规则都挂在某个面板上,id 不重复', () => {
    expect(new Set(ALERT_RULES.map((r) => r.id)).size).toBe(ALERT_RULES.length);
    expect(ALERT_RULES.length).toBe(MARKED.length);
  });
});
