// 序列注册表:编辑器能挑的序列 = 这张静态表 + 任意 Yahoo 代码(id 为 `yh:<代码>`,动态生成定义)。
// 取数复用现有接口(见 useEditorSeriesData)。这里的 id 就是 ChartDoc 里图层引用的那个 id —— 改名等于让旧 JSON 失效。
import type { SeriesKey } from '../../../shared/regimeSeries';

export type SeriesCategory = '资产' | '波动率' | '利率' | '信用·流动性' | '通胀·宏观' | 'Yahoo';

export type SeriesSource =
  /** /api/regime 的 series[key] */
  | { kind: 'regime'; key: SeriesKey }
  /** /api/regime 的 ohlc[key],取收盘 */
  | { kind: 'regimeOhlc'; key: string }
  /** /api/price/:symbol(price_eod),取收盘 */
  | { kind: 'price'; symbol: string }
  /** /api/yield-curve?source=<curve> 的某个期限(利率页「收益曲线 / 实际收益率 / 通胀预期」同一份) */
  | { kind: 'curve'; curve: CurveSource; tenor: string }
  /** /api/yahoo/history/:symbol(任意 Yahoo 代码的日线收盘,读时现拉) */
  | { kind: 'yahoo'; symbol: string };

/** 编辑器用到的收益曲线源。固定几个:取数层按源各开一个请求,没用到的不发。 */
export const CURVE_SOURCES = ['treasury', 'real', 'bei'] as const;
export type CurveSource = (typeof CURVE_SOURCES)[number];

export type SeriesDef = {
  id: string;
  label: string;
  category: SeriesCategory;
  freq: '日' | '周' | '月';
  unit?: string;
  source: SeriesSource;
  /** 7×24 资产(含周末日线):取数时只留周一~周五,同 tenorHistory 的做法(见 useEditorSeriesData)。 */
  weekends?: true;
  /** 搜索用的别名 */
  aliases?: string[];
};

export const CATEGORIES: SeriesCategory[] = ['资产', '波动率', '利率', '信用·流动性', '通胀·宏观'];

const regime = (key: SeriesKey): SeriesSource => ({ kind: 'regime', key });
const price = (symbol: string): SeriesSource => ({ kind: 'price', symbol });
const curve = (c: CurveSource, tenor: string): SeriesSource => ({ kind: 'curve', curve: c, tenor });

export const REGISTRY: SeriesDef[] = [
  {
    id: 'SPY',
    label: 'SPY',
    category: '资产',
    freq: '日',
    unit: '$',
    source: { kind: 'price', symbol: 'SPY' },
    aliases: ['标普'],
  },
  { id: 'qqq', label: 'QQQ', category: '资产', freq: '日', unit: '$', source: regime('qqq'), aliases: ['纳指'] },
  // 下面四条与 SPY 同源(price_eod,期权页现货蜡烛同一份数据),各自从上市日起
  {
    id: 'GLD',
    label: 'GLD 黄金',
    category: '资产',
    freq: '日',
    unit: '$',
    source: price('GLD'),
    aliases: ['黄金', 'gold'],
  },
  {
    id: 'IBIT',
    label: 'IBIT 比特币 ETF',
    category: '资产',
    freq: '日',
    unit: '$',
    source: price('IBIT'),
    aliases: ['比特币', 'bitcoin'],
  },
  {
    id: 'TLT',
    label: 'TLT 长期美债',
    category: '资产',
    freq: '日',
    unit: '$',
    source: price('TLT'),
    aliases: ['美债', '国债'],
  },
  {
    id: 'USO',
    label: 'USO 原油',
    category: '资产',
    freq: '日',
    unit: '$',
    source: price('USO'),
    aliases: ['原油', 'oil'],
  },
  {
    id: 'btc',
    label: 'BTC',
    category: '资产',
    freq: '日',
    unit: '$',
    source: { kind: 'regimeOhlc', key: 'btc' },
    weekends: true,
    aliases: ['比特币', 'bitcoin'],
  },
  { id: 'usd', label: '美元指数 DXY', category: '资产', freq: '日', source: regime('usd'), aliases: ['dxy', '美元'] },
  { id: 'usdjpy', label: 'USD/JPY', category: '资产', freq: '日', source: regime('usdjpy'), aliases: ['日元'] },

  { id: 'vix', label: 'VIX', category: '波动率', freq: '日', source: regime('vix') },
  { id: 'vxn', label: 'VXN', category: '波动率', freq: '日', source: regime('vxn'), aliases: ['纳指波动率'] },
  { id: 'move', label: 'MOVE', category: '波动率', freq: '日', source: regime('move'), aliases: ['债市波动率'] },
  { id: 'skew', label: 'SKEW', category: '波动率', freq: '日', source: regime('skew') },
  {
    id: 'cor1m',
    label: 'COR1M 隐含相关性',
    category: '波动率',
    freq: '日',
    source: regime('cor1m'),
    aliases: ['相关性'],
  },

  {
    // id 沿用 dgs10(已有文档引用它);数据改走曲线接口的长历史版:与 regime 的 dgs10 同为财政部 10Y,但从 1990 起
    id: 'dgs10',
    label: '美债 10Y',
    category: '利率',
    freq: '日',
    unit: '%',
    source: curve('treasury', '10Y'),
    aliases: ['us10y', '国债'],
  },
  {
    id: 'jgb10y',
    label: '日债 10Y',
    category: '利率',
    freq: '日',
    unit: '%',
    source: regime('jgb10y'),
    aliases: ['jgb', '日本国债'],
  },
  // 下面几条走 /api/yield-curve(财政部每日曲线,当天收盘即出;BEI = 名义 − 实际)
  {
    id: 'ust2y',
    label: '美债 2Y',
    category: '利率',
    freq: '日',
    unit: '%',
    source: curve('treasury', '2Y'),
    aliases: ['us2y', '国债'],
  },
  {
    id: 'ust30y',
    label: '美债 30Y',
    category: '利率',
    freq: '日',
    unit: '%',
    source: curve('treasury', '30Y'),
    aliases: ['us30y', '国债'],
  },
  {
    id: 'real5y',
    label: '实际利率 5Y',
    category: '利率',
    freq: '日',
    unit: '%',
    source: curve('real', '5Y'),
    aliases: ['tips', '实际收益率'],
  },
  {
    id: 'real10y',
    label: '实际利率 10Y',
    category: '利率',
    freq: '日',
    unit: '%',
    source: curve('real', '10Y'),
    aliases: ['tips', '实际收益率'],
  },
  {
    id: 'real30y',
    label: '实际利率 30Y',
    category: '利率',
    freq: '日',
    unit: '%',
    source: curve('real', '30Y'),
    aliases: ['tips', '实际收益率'],
  },
  {
    id: 'bei5y',
    label: '通胀预期 BEI 5Y',
    category: '通胀·宏观',
    freq: '日',
    unit: '%',
    source: curve('bei', '5Y'),
    aliases: ['bei', '盈亏平衡'],
  },
  {
    id: 'bei10y',
    label: '通胀预期 BEI 10Y',
    category: '通胀·宏观',
    freq: '日',
    unit: '%',
    source: curve('bei', '10Y'),
    aliases: ['bei', '盈亏平衡'],
  },
  {
    id: 'tp10Kw',
    label: '10Y 期限溢价 (KW)',
    category: '利率',
    freq: '日',
    unit: '%',
    source: regime('tp10Kw'),
    aliases: ['term premium'],
  },

  {
    id: 'hyOas',
    label: 'HY OAS',
    category: '信用·流动性',
    freq: '日',
    unit: '%',
    source: regime('hyOas'),
    aliases: ['高收益', '信用利差'],
  },
  {
    id: 'netLiquidity',
    label: '净流动性',
    category: '信用·流动性',
    freq: '周',
    unit: '$B',
    source: regime('netLiquidity'),
    aliases: ['liquidity'],
  },

  {
    id: 'coreCpiYoy',
    label: '核心 CPI 同比',
    category: '通胀·宏观',
    freq: '月',
    unit: '%',
    source: regime('coreCpiYoy'),
    aliases: ['cpi', '通胀'],
  },
  {
    id: 'ismMfg',
    label: 'ISM 制造业 PMI',
    category: '通胀·宏观',
    freq: '月',
    source: regime('ismMfg'),
    aliases: ['pmi', 'ism'],
  },
];

const BY_ID = new Map(REGISTRY.map((d) => [d.id, d]));

export const YAHOO_PREFIX = 'yh:';
export const yahooId = (symbol: string) => `${YAHOO_PREFIX}${symbol.toUpperCase()}`;

// Yahoo 代码的显示名(搜索结果 / 取数响应里带回来)。文档只存代码,名字不进 JSON,
// 所以记在这里给标签用;没记到(比如以后从存档载入、还没取到数)就只显示代码。
const yahooNames = new Map<string, string>();
export const rememberYahooName = (symbol: string, name: string) => {
  yahooNames.set(symbol.toUpperCase(), name);
};

export function seriesDef(id: string): SeriesDef | undefined {
  if (!id.startsWith(YAHOO_PREFIX)) return BY_ID.get(id);

  const symbol = id.slice(YAHOO_PREFIX.length);
  const name = yahooNames.get(symbol);
  return {
    id,
    label: name && name !== symbol ? `${symbol} ${name}` : symbol,
    category: 'Yahoo',
    freq: '日',
    source: { kind: 'yahoo', symbol },
  };
}

/** 搜索:名称 / id / 别名包含关键字(不区分大小写)。空关键字 = 全部。 */
export function searchSeries(query: string): SeriesDef[] {
  const q = query.trim().toLowerCase();
  if (!q) return REGISTRY;

  return REGISTRY.filter((d) => [d.label, d.id, ...(d.aliases ?? [])].some((s) => s.toLowerCase().includes(q)));
}
