import { expect, test } from 'bun:test';
import { REGISTRY } from '../../views/chartDoc/registry';
import { healthOverride, PATTERNS } from './overrides';

test('每条规则至少对上一条注册表 id(拼错了会悄悄失效)', () => {
  const ids = REGISTRY.map((d) => d.id);
  const dead = PATTERNS.filter(([re]) => !ids.some((id) => re.test(id))).map(([re]) => String(re));

  expect(dead).toEqual([]);
});

test('规则表与逐条表合并,逐条的优先;都没有 → undefined', () => {
  expect(healthOverride('jgb10y')?.rule).toEqual({ late: 4, stale: 7 });
  expect(healthOverride('jpCallMinusDeposit')).toMatchObject({ flatOk: true, rule: { late: 4, stale: 7 } });
  expect(healthOverride('credit:AAA')).toEqual({ flatOk: true });
  expect(healthOverride('spy')).toBeUndefined();
});
