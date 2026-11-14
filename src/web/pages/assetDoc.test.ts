import { describe, expect, test } from 'bun:test';
import { MARKET_CATALOG } from '../../shared/marketCatalog';
import { parseChartDoc } from '../views/chartDoc/chartDoc';
import { seriesDef } from '../views/chartDoc/registry';
import { assetDoc } from './assetDoc';

// 期权视角各标的 + BTC 期权 + IBIT(与 pages/options、pages/btc 的 assetTab 调用一致):[标的, 有 VRP, 抓期权链]
const TABS = [
  ...MARKET_CATALOG.filter((a) => a.tab).map((a) => [a.underlying, !!a.vrp, a.optionSource !== 'none'] as const),
  ['BTC', true, true] as const,
  ['IBIT', true, true] as const,
];
// 标的专属附加格的数量(见 assetDoc 的 EXTRA)
const EXTRA_PANES: Record<string, number> = { SMH: 1 };

describe('期权 / 现货 tab 的 ChartDoc', () => {
  test.each(TABS)('%s:JSON 往返无损、序列都在注册表、图层 id 不重复', (u, vrp, options) => {
    const doc = assetDoc(u, vrp, options);
    expect(parseChartDoc(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
    const layers = doc.panes.flatMap((p) => p.layers);
    expect(layers.filter((l) => !seriesDef(l.series)).map((l) => l.series)).toEqual([]);
    expect(new Set(layers.map((l) => l.id)).size).toBe(layers.length);
  });

  test.each(TABS)(
    '%s:现货蜡烛 + EMA / 布林带默认隐藏;有期权链才有 25Δ 两格、有 VRP 才有隐含/RV、VRP 两格',
    (u, vrp, options) => {
      const doc = assetDoc(u, vrp, options);
      expect(doc.panes).toHaveLength(1 + (options ? 2 : 0) + (vrp ? 2 : 0) + (EXTRA_PANES[u] ?? 0));
      const [spot, ema, bb] = doc.panes[0].layers;
      expect(spot.render).toEqual({ kind: 'candle' });
      expect(seriesDef(spot.series)?.ohlc).toBe(true); // 画得出蜡烛
      expect([ema.indicator?.id, ema.hidden, bb.indicator?.id, bb.hidden]).toEqual(['ema', true, 'bb', true]);
      expect([ema.series, bb.series]).toEqual([spot.series, spot.series]);
      // 不占 MACD / RSI 格(用户定:期权页已 5 格)
      expect(
        doc.panes
          .flatMap((p) => p.layers)
          .filter((l) => l.indicator && l.indicator.id !== 'ema' && l.indicator.id !== 'bb'),
      ).toEqual([]);
    },
  );

  test('SMH 不抓期权链:没有 25Δ 两格,末格是 VXSMH − VXN', () => {
    const doc = assetDoc('SMH', true, false);
    const series = doc.panes.flatMap((p) => p.layers.map((l) => l.series));
    expect(series.filter((s) => s.startsWith('opt:'))).toEqual([]);
    expect(doc.panes.at(-1)?.layers[0].calc).toEqual({ op: '-', series: 'vrp:QQQ:iv' });
  });

  test('BTC 现货跨数量级走对数轴,其余不', () => {
    expect(assetDoc('BTC', true).panes[0].scales[0].log).toBe(true);
    expect(assetDoc('SPY', true).panes[0].scales[0].log).toBeUndefined();
  });
});
