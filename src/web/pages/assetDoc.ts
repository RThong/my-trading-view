// 期权 / 现货 tab 的 ChartDoc 生成器(期权视角 6 个标的 + BTC 期权 + IBIT 共用):
// 现货蜡烛(叠 EMA 一组与布林带,默认隐藏、图例点开)→ 25Δ IV(call / put)→ Skew → 有 VRP 的再加 隐含/RV、VRP 两格。
// MACD / RSI 不占格(期权页已 5 格,用户定;要看在图表编辑器里给现货加)。
import { ivIndexByUnderlying } from '../../shared/marketCatalog';
import type { ChartDoc, Layer, Pane } from '../views/chartDoc/chartDoc';

// 标的 → 现货 K 线的注册表 id(price_eod 的 ETF 按代码;BTC 走 Bitstamp 的 btc;VIX 收盘在 regime、K 线从 Yahoo ^VIX 取)
const SPOT: Record<string, string> = { QQQ: 'qqq', '.VIX': 'vix', BTC: 'btc' };
// 期权 / VRP 序列 id 里的标的名(注册表不带 VIX 前面的点)
function optKey(underlying: string) {
  return underlying.replace(/^\./, '');
}

const RIGHT = [{ id: 'right', side: 'right' as const }];
// 各线颜色沿用旧期权页
const COLORS = { call: '#22c55e', put: '#ec4899', skew: '#3b82f6', iv: '#3b82f6', rv: '#f59e0b', vrp: '#22c55e' };
const IV_INDEX = ivIndexByUnderlying();

const DESC = {
  price:
    '定义:标的现货价(蜡烛)。\n期权指标的锚;和下面 IV / skew / VRP 对照看价格与波动的关系。\nEMA 一组与布林带默认隐藏,在图例里点名字显示。',
  iv: '定义:25Δ 看涨 / 看跌期权隐含波动率。\n市场对该标的未来波动的定价。\nCall vs Put 的高低差就是 skew 的来源。',
  skew: '定义:25Δ 风险逆转(put IV − call IV)。\n符号:高 = 25Δ put 比 call 贵;低 / 负 = call 比 put 贵。\n情绪含义按标的分:普通权益(SPY/QQQ/GLD 等)高 = 抢下行保护 / 避险;但 VIX 等波动率标的 call 常被抢(赌波动上冲),负值不等于自满。\n注意:高 IV 标的采样点被推出活跃区,skew 偏噪声。',
  ivrv: '定义:隐含波动率(IV)vs 截至当日的历史已实现波动率(RV)。\nIV 持续高于近期 RV = 期权偏贵;能否变成卖方收益还要看随后实现的波动 + 成本。',
  vrp: '定义:当日 IV − 近期历史 RV 的价差(不是前瞻可实现收益)。\n正 = IV 高于近期 RV(通常卖方占优,但要与随后实现波动比才算数);负 = IV 低于近期 RV / 应激。',
};

/** 一格:图层 id 先留空,assetDoc 末尾统一编号 */
function pane(layers: Omit<Layer, 'id' | 'scale'>[], desc: string, log?: true, stretch = 1): Pane {
  return {
    id: '',
    stretch,
    scales: log ? [{ ...RIGHT[0], log }] : RIGHT,
    layers: layers.map((l) => ({ ...l, id: '', scale: 'right' })),
    desc,
  };
}

/** vrp:有 VRP 配方的标的(.VIX 没有)才加 隐含/RV、VRP 两格 */
export function assetDoc(underlying: string, vrp: boolean): ChartDoc {
  const spot = SPOT[underlying] ?? underlying;
  const k = optKey(underlying);
  const ivName = IV_INDEX[underlying] ?? 'IV';

  const panes: Pane[] = [
    pane(
      [
        { series: spot, color: '#d4d4d8', title: '现货', render: { kind: 'candle' } },
        { series: spot, color: '#d4d4d8', indicator: { id: 'ema' }, hidden: true },
        { series: spot, color: '#a1a1aa', indicator: { id: 'bb' }, hidden: true },
      ],
      DESC.price,
      // BTC 跨 4 个数量级(2012 起约 2.9 万倍),普通坐标下早年全压在底部
      spot === 'btc' ? true : undefined,
      // 现货是主图(图例常有三行),给两倍高;其余各格等高
      2,
    ),
    pane(
      [
        { series: `opt:${k}:callIv`, color: COLORS.call, title: 'Call IV' },
        { series: `opt:${k}:putIv`, color: COLORS.put, title: 'Put IV' },
      ],
      DESC.iv,
    ),
    pane([{ series: `opt:${k}:skew`, color: COLORS.skew, title: 'Skew' }], DESC.skew),
    ...(vrp
      ? [
          pane(
            [
              { series: `vrp:${k}:iv`, color: COLORS.iv, title: `隐含 (${ivName})` },
              { series: `vrp:${k}:rv`, color: COLORS.rv, title: '已实现 RV' },
            ],
            DESC.ivrv,
          ),
          pane([{ series: `vrp:${k}:vrp`, color: COLORS.vrp, title: 'VRP' }], DESC.vrp),
        ]
      : []),
  ];

  // 格与图层按顺序编号(p1 / l1 起,图层全图连号)
  const offsets = panes.map((_, i) => panes.slice(0, i).reduce((n, p) => n + p.layers.length, 0));
  return {
    v: 1,
    panes: panes.map((p, i) => ({
      ...p,
      id: `p${i + 1}`,
      layers: p.layers.map((l, j) => ({ ...l, id: `l${offsets[i] + j + 1}` })),
    })),
  };
}
