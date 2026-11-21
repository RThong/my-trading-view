import { describe, expect, it } from 'bun:test';
import { GEX_PCTL, RED_LINES } from '../../../shared/calc/stampede';
import { DIMS } from './dims';

// 红线说明文字是照付鹏原样手写的(用户定:不自动拼),这里核对文字里的数字和计算层阈值一致,改了阈值忘了改文字会报错
describe('五维度卡的红线文字与计算层阈值一致', () => {
  const red = (key: string) => DIMS.flatMap((d) => d.metrics).find((m) => m.key === key)!.red;

  it('VIX / P/C 的红线', () => {
    expect(red('vix')).toContain(`红线 ≥ ${RED_LINES.vix}`);
    expect(red('pcEquity')).toContain(`红线 ≥ ${RED_LINES.pcEquity.toFixed(2)}`);
    expect(red('pcTotal')).toContain(`红线 ≥ ${RED_LINES.pcTotal.toFixed(2)}`);
    expect(red('pcIndex')).toContain(`红线 ≥ ${RED_LINES.pcIndex.toFixed(2)}`);
  });

  it('GEX 的分位线', () => {
    expect(red('gex')).toContain(`≤ ${GEX_PCTL.red} 记红`);
    expect(red('gex')).toContain(`≤ ${GEX_PCTL.yellow} 记黄`);
  });
});
