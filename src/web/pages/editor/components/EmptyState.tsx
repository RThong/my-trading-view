import { ChartLine } from 'lucide-react';
import { SERIES_COLORS } from '../../../chart/palette';
import {
  EMPTY_DOC,
  addLayer,
  moveLayer,
  nextColor,
  setLayerScale,
  type ChartDoc,
} from '../../../views/chartDoc/chartDoc';

// 起手示例:各演示一种用法(同格独立轴叠加 / 同格同轴 / 分两格比先后)。只是快捷入口,载入后照常编辑。
function add(d: ChartDoc, series: string) {
  return addLayer(d, series, nextColor(d, SERIES_COLORS));
}
function lastLayerId(d: ChartDoc) {
  return d.panes.flatMap((p) => p.layers).at(-1)!.id;
}

const PRESETS: { label: string; hint: string; build: () => ChartDoc }[] = [
  {
    label: 'SPY × VIX',
    hint: '同一格,VIX 挂独立轴',
    build: () => {
      const d = add(add(EMPTY_DOC, 'SPY'), 'vix');
      return setLayerScale(d, lastLayerId(d), 'newOverlay');
    },
  },
  {
    label: '美债 10Y × 日债 10Y',
    hint: '同一格同一根轴',
    build: () => add(add(EMPTY_DOC, 'dgs10'), 'jgb10y'),
  },
  {
    label: 'BTC × 净流动性',
    hint: '分两格看先后',
    build: () => {
      const d = add(add(EMPTY_DOC, 'btc'), 'netLiquidity');
      return moveLayer(d, lastLayerId(d), 'new');
    },
  },
];

export function EmptyState({ onLoad }: { onLoad: (doc: ChartDoc) => void }) {
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-neutral-950">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <ChartLine size={32} className="text-neutral-600" />
        <h2 className="text-base font-medium text-neutral-200">空白图表</h2>
        <p className="text-sm leading-relaxed text-neutral-500">
          在右侧搜索并勾选序列，再把卡片拖进不同的格：同一格比走势，不同格比先后。所有格共用同一根时间轴。
        </p>
        <div className="mt-2 flex flex-col gap-1.5 self-stretch">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => onLoad(p.build())}
              className="flex items-baseline justify-between rounded border border-neutral-800 px-3 py-2 text-left hover:border-neutral-600 hover:bg-neutral-900"
            >
              <span className="text-sm text-neutral-200">{p.label}</span>
              <span className="text-xs text-neutral-500">{p.hint}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
