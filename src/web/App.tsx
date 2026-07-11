import { useState, type ReactNode } from 'react';
import { Header } from './components/Header';
import { TabBar } from './components/TabBar';
import { AssetChart } from './panels/AssetChart';
import { RegimeChart } from './panels/RegimeChart';
import { YieldCurvePanel } from './panels/YieldCurvePanel';
import { TenorHistoryPanel } from './panels/TenorHistoryPanel';
import { RateSpreadPanel } from './panels/RateSpreadPanel';
import { AttackDefensePanel } from './panels/AttackDefensePanel';
import type { RegimeDim } from './panels/regimeChart.hooks';
import type { Interval } from './hooks/interval';

// 一个资产一个横 tab,tab 名即资产名;该资产的所有期权指标都在这个 tab 内。
const ASSET_TABS = [
  { id: 'spy', label: 'SPY', underlying: 'SPY', vrpUnderlying: 'SPY' },
  { id: 'qqq', label: 'QQQ', underlying: 'QQQ', vrpUnderlying: 'QQQ' },
  { id: 'vix', label: 'VIX', underlying: '.VIX' },
  { id: 'tlt', label: 'TLT', underlying: 'TLT' }, // 无免费波动率指数,只 2-pane
  { id: 'gld', label: 'GLD', underlying: 'GLD', vrpUnderlying: 'GLD' },
  { id: 'uso', label: 'USO', underlying: 'USO', vrpUnderlying: 'USO' },
  { id: 'btc', label: 'BTC', underlying: 'BTC', vrpUnderlying: 'BTC' },
];

// 竖 tab = 视角;每个视角自带自己的横 tab 列表和渲染方式(各视角内容异构)。
// 目前只有「期权」视角有真内容;流动性/拥挤度等视角等数据到位后按同样形状 push 一条。
type Perspective = {
  id: string;
  label: string;
  tabs: { id: string; label: string }[];
  render: (tabId: string, interval: Interval) => ReactNode;
};

// 宏观 regime 视角:每个维度一个竖视角,单视图(无横 tab)。
const regimePersp = (id: RegimeDim, label: string): Perspective => ({
  id, label,
  tabs: [{ id, label }],
  render: (_tabId, interval) => <RegimeChart dim={id} interval={interval} />,
});

// 走势视角通用:上「期限随时间」+ 下「利差」纵向堆叠(2:1)。
const stacked = (top: ReactNode, bottom: ReactNode) => (
  <div className="flex h-full flex-col gap-2">
    <div className="min-h-0 flex-[2]">{top}</div>
    <div className="min-h-0 flex-1">{bottom}</div>
  </div>
);

const PERSPECTIVES: Perspective[] = [
  {
    id: 'options',
    label: '期权',
    tabs: ASSET_TABS,
    render: (tabId, interval) => {
      const a = ASSET_TABS.find((t) => t.id === tabId)!;
      return <AssetChart interval={interval} underlying={a.underlying} vrpUnderlying={a.vrpUnderlying} />;
    },
  },
  regimePersp('credit', '信用'),
  regimePersp('liquidity', '流动性'),
  {
    id: 'sentiment', label: '情绪',
    tabs: [{ id: 'vol', label: '波动率' }, { id: 'sentiment', label: '情绪' }],
    render: (tabId, interval) => <RegimeChart dim={tabId as RegimeDim} interval={interval} />,
  },
  regimePersp('macro', '宏观'),
  {
    id: 'rates', label: '利率',
    tabs: [
      { id: 'treasury', label: '收益曲线' },
      { id: 'tenor_history', label: '期限走势' },
      { id: 'sofr_ois', label: 'SOFR OIS' },
      { id: 'ois_history', label: 'OIS 走势' },
      { id: 'rates_vol', label: '利率波动率' },
    ],
    render: (tabId, interval) => {
      // 走势 tab:上「期限随时间」+ 下「利差」纵向堆叠;曲线 tab 只画纯曲线。
      if (tabId === 'tenor_history')
        return stacked(
          <TenorHistoryPanel source="treasury" interval={interval} />,
          <RateSpreadPanel source="treasury" long="10Y" short="3M" label="10Y − 3M" interval={interval} />,
        );
      if (tabId === 'ois_history')
        return stacked(
          <TenorHistoryPanel source="sofr_ois" interval={interval} />,
          <RateSpreadPanel source="sofr_ois" long="12M" short="3M" label="1Y − 3M" interval={interval} />,
        );
      if (tabId === 'rates_vol') return <RegimeChart dim="ratesVol" interval={interval} />; // 10Y 收益率 + MOVE
      return <YieldCurvePanel source={tabId} />; // treasury / sofr_ois 纯曲线
    },
  },
  {
    id: 'creditCurve', label: '信用曲线',
    tabs: [
      { id: 'credit_rating', label: '评级利差' },
      { id: 'credit_term', label: '期限结构' },
    ],
    render: (tabId) => <YieldCurvePanel source={tabId} />,
  },
  {
    id: 'inflation', label: '通胀',
    tabs: [
      { id: 'bei', label: '通胀预期' },
      { id: 'bei_history', label: '通胀走势' },
      { id: 'infl_source', label: '通胀来源' },
    ],
    render: (tabId, interval) => {
      if (tabId === 'bei_history')
        return stacked(
          <TenorHistoryPanel source="bei" interval={interval} />,
          <RateSpreadPanel source="bei" long="10Y" short="5Y" label="10Y − 5Y" interval={interval} />,
        );
      if (tabId === 'infl_source') return <RegimeChart dim="inflSource" interval={interval} />; // 薪资 + 服务黏性
      return <YieldCurvePanel source="bei" />; // BEI 纯曲线
    },
  },
  {
    id: 'featured', label: '特色指标',
    tabs: [{ id: 'attack_defense', label: '攻防' }],
    render: () => <AttackDefensePanel />,
  },
];

export function App() {
  const [interval, setInterval] = useState<Interval>('1D');
  const [perspId, setPerspId] = useState(PERSPECTIVES[0].id);
  // 每个视角记住自己上次停在的横 tab,切回来不跳回第一个。
  const [tabByPersp, setTabByPersp] = useState<Record<string, string>>(() => ({
    [PERSPECTIVES[0].id]: PERSPECTIVES[0].tabs[0].id,
  }));
  // keep-alive:访问过的 `${视角}:${tab}` 各挂一个实例不再卸载,切回来保留显隐/缩放等内存状态。
  const [seen, setSeen] = useState<Set<string>>(() => new Set([`${PERSPECTIVES[0].id}:${PERSPECTIVES[0].tabs[0].id}`]));

  const persp = PERSPECTIVES.find((p) => p.id === perspId)!;
  const activeTab = tabByPersp[perspId] ?? persp.tabs[0].id;

  const selectPersp = (id: string) => {
    const p = PERSPECTIVES.find((x) => x.id === id)!;
    const tab = tabByPersp[id] ?? p.tabs[0].id;
    setPerspId(id);
    setSeen((s) => (s.has(`${id}:${tab}`) ? s : new Set(s).add(`${id}:${tab}`)));
  };
  const selectTab = (tab: string) => {
    setTabByPersp((m) => ({ ...m, [perspId]: tab }));
    setSeen((s) => (s.has(`${perspId}:${tab}`) ? s : new Set(s).add(`${perspId}:${tab}`)));
  };

  return (
    <div className="flex h-screen flex-col">
      <Header interval={interval} onIntervalChange={setInterval} />
      <div className="flex flex-1 min-h-0">
        <TabBar tabs={PERSPECTIVES} active={perspId} onChange={selectPersp} vertical />
        <div className="flex flex-1 flex-col min-h-0">
          <TabBar tabs={persp.tabs} active={activeTab} onChange={selectTab} />
          <main className="flex-1 p-4 min-h-0">
            <div className="h-full w-full rounded border border-neutral-800 p-3">
              {PERSPECTIVES.flatMap((p) =>
                p.tabs
                  .filter((t) => seen.has(`${p.id}:${t.id}`))
                  .map((t) => {
                    const key = `${p.id}:${t.id}`;
                    // 非活跃的用 hidden 藏起来(实例和状态都还在,只是不渲染像素)。
                    return (
                      <div key={key} className={key === `${perspId}:${activeTab}` ? 'h-full' : 'hidden'}>
                        {p.render(t.id, interval)}
                      </div>
                    );
                  })
              )}
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
