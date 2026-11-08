import { describe, expect, test } from 'bun:test';
import { MARKET_CATALOG } from '../../shared/marketCatalog';
import { parseChartDoc } from '../views/chartDoc/chartDoc';
import { seriesDef } from '../views/chartDoc/registry';
import { assetDoc } from './assetDoc';

// 期权视角 6 个标的 + BTC 期权 + IBIT(与 pages/options、pages/btc 的 assetTab 调用一致)
const TABS = [
  ...MARKET_CATALOG.filter((a) => a.tab).map((a) => [a.underlying, !!a.vrp] as const),
  ['BTC', true] as const,
  ['IBIT', true] as const,
];

describe('期权 / 现货 tab 的 ChartDoc', () => {
  test.each(TABS)('%s:JSON 往返无损、序列都在注册表、图层 id 不重复', (u, vrp) => {
    const doc = assetDoc(u, vrp);
    expect(parseChartDoc(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
    const layers = doc.panes.flatMap((p) => p.layers);
    expect(layers.filter((l) => !seriesDef(l.series)).map((l) => l.series)).toEqual([]);
    expect(new Set(layers.map((l) => l.id)).size).toBe(layers.length);
  });

  test.each(TABS)('%s:现货蜡烛 + EMA / 布林带默认隐藏;有 VRP 才有隐含/RV、VRP 两格', (u, vrp) => {
    const doc = assetDoc(u, vrp);
    expect(doc.panes).toHaveLength(vrp ? 5 : 3);
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
  });

  test('BTC 现货跨数量级走对数轴,其余不', () => {
    expect(assetDoc('BTC', true).panes[0].scales[0].log).toBe(true);
    expect(assetDoc('SPY', true).panes[0].scales[0].log).toBeUndefined();
  });
});
