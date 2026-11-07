import { describe, expect, test } from 'bun:test';
import { isMarkLayer, moveLayer, parseChartDoc } from '../chartDoc/chartDoc';
import { seriesDef } from '../chartDoc/registry';
import { CONCENTRATION } from '../../pages/featured/concentration';
import { REGIME_DOCS } from '../../pages/regimeDims';
import type { FixedDim } from './regimeChart.hooks';

const FIXED_DIMS = Object.keys(REGIME_DOCS) as FixedDim[];

// 固定面板的配置是 ChartDoc(TS 常量):编译期的拼写检查只剩一半(序列 id 是字符串),这里补回来。
describe('固定面板的 ChartDoc', () => {
  test.each(Object.entries(REGIME_DOCS))('%s:导出成 JSON 再解析,与原文档完全相同', (_, doc) => {
    expect(parseChartDoc(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
  });

  test.each(Object.entries(REGIME_DOCS))('%s:每个图层的序列(含计算图层的第二条腿)都在注册表里', (_, doc) => {
    const ids = doc.panes.flatMap((p) => p.layers.flatMap((l) => [l.series, ...(l.calc ? [l.calc.series] : [])]));
    expect(ids.filter((id) => !seriesDef(id))).toEqual([]);
  });

  test('编辑器里把一格唯一的线拖到新格:格子的说明跟着走,不丢', () => {
    const moved = moveLayer(CONCENTRATION, 'l1', 'new');
    const pane = moved.panes.find((p) => p.layers.some((l) => l.id === 'l1'))!;
    expect(pane.desc).toBe(CONCENTRATION.panes[0].desc);
    expect(moved.panes.length).toBe(3);
  });

  test('拖进已有格(两格并成一格):只留目标格自己的说明', () => {
    const merged = moveLayer(CONCENTRATION, 'l2', 'p1');
    expect(merged.panes.map((p) => p.desc)).toEqual([CONCENTRATION.panes[0].desc, CONCENTRATION.panes[2].desc]);
  });

  // 口径隔离。**这条守的是一个已经犯过的错**:r* 曾被叠在「预期短端」同格,而两者一个实际、一个名义,
  // 图上比高低得到的结论正好是反的(实际 0.72 < 名义 1.70 → 误判成「政策已高于中性」)。
  // 分格是唯一有效的防线 —— desc 拦不住「两条线摆在一起就去比」。
  // **反着钉,不维护「名义白名单」**:实际口径的序列是封闭的三条,约束写成「含 r* 的格,线必须恰好是这三条」,
  // 覆盖全部 tab 的全部格,不需要知道别的序列是什么口径。
  test('实际口径的 r* 只准独占自己那一格', () => {
    const REAL = ['jpRstar10Nakajima', 'jpRstar10NakajimaLo', 'jpRstar10NakajimaHi'];
    const panesWithReal = FIXED_DIMS.flatMap((dim) =>
      REGIME_DOCS[dim].panes
        .map((p) => ({ at: `${dim}.${p.id}`, ids: p.layers.filter((l) => !isMarkLayer(l)).map((l) => l.series) }))
        .filter((p) => p.ids.some((id) => REAL.includes(id))),
    );

    // 恰好一格,且那一格里除了这三条没有别的线 —— 混进任何名义序列都会在这里红
    expect(panesWithReal.map((p) => p.at)).toEqual(['jpTermPremium.p3']);
    expect(new Set(panesWithReal[0].ids)).toEqual(new Set(REAL));
  });

  // 断言「同一个对象引用」而不是「深相等」:这一格的存在意义就是不被抄成两份 ——
  // 深相等会放过「复制粘贴且内容恰好一样」,而那正是本仓库反复踩的「改一处漏一处」。BTC 现货同理
  test.each([
    ['qqq', 'vol', 'sentiment'],
    ['btc', 'btc', 'btcOnchain'],
  ] as const)('%s 现货格是两个 tab 共用的同一份定义', (series, a, b) => {
    const spot = (dim: FixedDim) => REGIME_DOCS[dim].panes.find((p) => p.layers[0]?.series === series);
    expect(spot(a)).toBeDefined();
    expect(spot(b)).toBe(spot(a));
    // 价格参照物不是判据:蜡烛 + 不套分位(套了会出徽标和红绿背景带,读成风险信号)
    expect(spot(a)?.layers[0].render).toEqual({ kind: 'candle' });
    expect(spot(a)?.layers[0].percentile).toBeUndefined();
  });

  // REGIME_DOCS 由各视角的 docs 展开拼成:同一 key 出现在两个文件里,后者会静默盖掉前者(类型查不出来)。
  // 这里扫全部 pages/*/docs.ts,既查重名,也查有没有哪个文件漏拼进 REGIME_DOCS(集中度单独一个文件,另算)。
  test('各视角 docs 的 key 不重名,且全部拼进 REGIME_DOCS', async () => {
    const files = [...new Bun.Glob('../../pages/*/docs.ts').scanSync(import.meta.dir)];
    const modules = await Promise.all(files.map((f) => import(f)));
    const keys = modules.flatMap((m) =>
      Object.entries(m).flatMap(([name, v]) => (name.endsWith('_DOCS') ? Object.keys(v as object) : [])),
    );
    const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);

    expect(files.length).toBeGreaterThan(0);
    expect(dupes).toEqual([]);
    expect([...keys, 'concentration'].toSorted()).toEqual(Object.keys(REGIME_DOCS).toSorted());
  });
});
