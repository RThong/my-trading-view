import { assetTab, regimeTab, type Perspective } from '../tabs';

export const BTC: Perspective = {
  id: 'btc',
  label: 'BTC',
  // BTC 的全部格子收在这一个视角里(现货/夏普 + 链上 + 期权),不在「期权」视角另开一个 BTC 横 tab ——
  // 见 marketCatalog 里 BTC 条目为何不配 tab。
  tabs: [
    regimeTab('btc', '现货/夏普', 'btc'),
    regimeTab('btc_onchain', '链上', 'btcOnchain'),
    assetTab('btc_options', '期权', 'BTC', 'BTC'),
    // IBIT:美股盘的 BTC 敞口(moomoo 期权 + Yahoo 现货),与上面 Deribit 那格是两个市场,单独一格。
    assetTab('ibit', 'IBIT', 'IBIT', 'IBIT'),
  ],
};
