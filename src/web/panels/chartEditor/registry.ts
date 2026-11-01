// MVP 序列注册表:编辑器能挑的序列全在这张静态表里。取数复用现有接口(见 useEditorSeriesData),
// 以后做全站统一的注册表时,这里的 id 就是 ChartDoc 里图层引用的那个 id —— 改名等于让旧 JSON 失效。
import type { SeriesKey } from '../../../shared/regimeSeries';

export type SeriesCategory = '资产' | '波动率' | '利率' | '信用·流动性' | '通胀·宏观';

export type SeriesSource =
  /** /api/regime 的 series[key] */
  | { kind: 'regime'; key: SeriesKey }
  /** /api/regime 的 ohlc[key],取收盘 */
  | { kind: 'regimeOhlc'; key: string }
  /** /api/price/:symbol(price_eod),取收盘 */
  | { kind: 'price'; symbol: string };

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
    id: 'dgs10',
    label: '美债 10Y',
    category: '利率',
    freq: '日',
    unit: '%',
    source: regime('dgs10'),
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

export const seriesDef = (id: string): SeriesDef | undefined => BY_ID.get(id);

/** 搜索:名称 / id / 别名包含关键字(不区分大小写)。空关键字 = 全部。 */
export function searchSeries(query: string): SeriesDef[] {
  const q = query.trim().toLowerCase();
  if (!q) return REGISTRY;

  return REGISTRY.filter((d) => [d.label, d.id, ...(d.aliases ?? [])].some((s) => s.toLowerCase().includes(q)));
}
