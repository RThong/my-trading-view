import { MARKET_CATALOG } from '../../../shared/marketCatalog';
import { assetTab, type Perspective } from '../tabs';

export const OPTIONS: Perspective = {
  id: 'options',
  label: '期权',
  // 期权标的 tab 由标的目录派生(有 tab 的条目);vrpUnderlying 有 VRP 才传(否则只 2-pane)。
  tabs: MARKET_CATALOG.filter((a) => a.tab).map((a) =>
    assetTab(a.tab!.id, a.tab!.label, a.underlying, a.vrp ? a.underlying : undefined),
  ),
};
