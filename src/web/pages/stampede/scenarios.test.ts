import { describe, expect, it } from 'bun:test';
import { SCENARIO_KEYS, SCENARIOS, scenarioSnapshot } from './scenarios';
import { dimLevels, templateView } from './view';

describe('情景模板', () => {
  it('按 §2 规则判出的阶段 = 按钮上的阶段', () => {
    expect(SCENARIO_KEYS.map((k) => templateView({}, k).stage)).toEqual(SCENARIO_KEYS.map((k) => SCENARIOS[k].stage));
  });

  it('阶段一模板五维度全正常', () => {
    expect(dimLevels(templateView({}, 'stage1')).flat()).toEqual(Array(11).fill(null));
  });

  it('阶段三模板升级灯亮、断崖不适用', () => {
    const v = templateView({}, 'stage3');
    expect(v.escalate.on).toBe(true);
    expect(v.cliff).toBeNull();
  });

  it('VIX3M / VIX9D 由比值反推', () => {
    const x = scenarioSnapshot('stage3');
    expect(x.vix3m).toBeCloseTo(35.8 / 1.14, 6);
    expect(x.vix9d).toBeCloseTo(35.8 * 1.11, 6);
  });
});
