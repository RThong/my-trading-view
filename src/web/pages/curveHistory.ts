// 曲线期限走势 tab 的 ChartDoc 生成器(美债 / OIS / 实际 / BEI / 日债 / AI CDS 共用):
// 第 1 格 = 该曲线每个期限一条线(默认只显示几条,其余隐藏、图例里点一下就出来),之后每个差值一格(长腿 − 短腿,0 基线),
// 可选再挂一格现货蜡烛当对照。期限清单取注册表同族的全部序列,曲线加了期限这里自动跟上。
import { SERIES_COLORS } from '../chart/palette';
import type { ChartDoc, Layer, Pane } from '../views/chartDoc/chartDoc';
import { REGISTRY, type SeriesDef, type SeriesFamily } from '../views/chartDoc/registry';

type Spread = { long: string; short: string; title: string; desc?: string };
type Options = {
  family: SeriesFamily;
  /** 默认显示的期限(其余隐藏);图例名 = 期限名 */
  shown: string[];
  desc: string;
  spreads?: Spread[];
  /** 现货蜡烛对照(注册表 id)。只给真的相关的那个 tab 配 —— 不是每格都该挂一条风险资产 */
  spot?: { series: string; title: string };
  /** 纵轴从 0 起(CDS:读的是「涨了几成」,自动缩放只包数据那段会把小幅变化放大成满格);利率不加,钉 0 会把 10bp 级的动作压扁 */
  zeroBase?: true;
};

const RIGHT = [{ id: 'right', side: 'right' as const }];

function tenorOf(d: SeriesDef): string {
  return d.source.kind === 'curve' ? d.source.tenor : d.id;
}

export function curveHistoryDoc({ family, shown, desc, spreads = [], spot, zeroBase }: Options): ChartDoc {
  const defs = REGISTRY.filter((d) => d.family === family);
  const idOf = (tenor: string) => {
    const def = defs.find((d) => tenorOf(d) === tenor);
    if (!def) throw new Error(`curveHistoryDoc:${family} 没有期限 ${tenor}`);
    return def.id;
  };
  // 颜色按期限在曲线里的位置取(固定,不随勾选变),区分色表 32 色,OIS 24 档也不撞
  const color = (i: number) => SERIES_COLORS[i % SERIES_COLORS.length];

  const tenorLayers: Layer[] = defs.map((d, i) => ({
    id: `l${i + 1}`,
    series: d.id,
    scale: 'right',
    color: color(i),
    title: tenorOf(d),
    ...(!shown.includes(tenorOf(d)) && { hidden: true as const }),
  }));
  const tenorPane: Pane = {
    id: 'p1',
    stretch: 2,
    scales: zeroBase ? [{ ...RIGHT[0], expandVisibleTo: [0, 0] }] : RIGHT,
    layers: tenorLayers,
    desc,
  };

  const spreadPanes: Pane[] = spreads.map((s, j) => ({
    id: `p${j + 2}`,
    stretch: 1,
    scales: RIGHT,
    layers: [
      {
        id: `l${defs.length + j + 1}`,
        series: idOf(s.long),
        // 不加 fill:两腿都是日频 → 同一天都有数才出点。实测与旧面板「按长腿日期取短腿」逐点相同(短腿只会缺在
        // 它开始之前);加了 fill 反而错 —— 美债 30Y 2002-02 ~ 2006-02 停发,30Y − 10Y 会把 2002 年的值前向拖四年
        calc: { op: '-', series: idOf(s.short) },
        scale: 'right',
        color: color(defs.length + j),
        title: s.title,
        render: { kind: 'line', baseline: 0 },
      },
    ],
    ...(s.desc && { desc: s.desc }),
  }));

  // 现货跨数量级(BTC 2012 起约 2.9 万倍)→ 对数轴
  const spotPane: Pane[] = spot
    ? [
        {
          id: `p${spreads.length + 2}`,
          stretch: 1,
          scales: [{ ...RIGHT[0], log: true }],
          layers: [
            {
              id: `l${defs.length + spreads.length + 1}`,
              series: spot.series,
              scale: 'right',
              color: '#f7931a',
              title: spot.title,
              render: { kind: 'candle' },
            },
          ],
        },
      ]
    : [];

  return { v: 1, panes: [tenorPane, ...spreadPanes, ...spotPane] };
}
