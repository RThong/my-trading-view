// 序列注册表:编辑器能挑的序列 = 服务端所有对外的时间序列 + 任意 Yahoo 代码(id 为 `yh:<代码>`,动态生成定义)。
//   · /api/regime:SERIES_META 生成(id = 序列名)+ 基本面 fund:*(aiChain 名单生成)
//   · /api/price(price_eod 现货)、/api/yield-curve(各曲线各期限)、/api/options/25delta、/api/vrp
//   · /api/series(库里 market_series 有、但别的接口没发的,id 为 `db:<series_id>`;VX 各月合约按需列)
// 取数复用现有接口(见 useEditorSeriesData)。这里的 id 就是 ChartDoc 里图层引用的那个 id —— 改名等于让旧 JSON 失效。
import {
  ACTIVE_TICKERS,
  SEC_BUYER_FCF_KEY,
  SEC_BUYER_FCFQ_KEY,
  currencyOf,
  fundKey,
  kindsOf,
  type FundKind,
} from '../../../shared/aiChain';
import { MARKET_CATALOG, ivIndexByUnderlying } from '../../../shared/marketCatalog';
import {
  AI_CDS,
  CREDIT_RATING,
  CREDIT_TERM,
  ERIS_OIS_TENORS,
  UST_REAL_TENORS,
  UST_TENORS,
} from '../../../shared/rateCurveDefs';
import { REGIME_SERIES, type SeriesKey } from '../../../shared/regimeSeries';
import {
  CATEGORIES as META_CATEGORIES,
  SERIES_META,
  type SeriesCategory as MetaCategory,
  type SeriesFreq,
} from '../../../shared/seriesMeta';

export type SeriesCategory = MetaCategory | '期权' | 'VX 合约' | '基本面' | 'Yahoo';

export type SeriesSource =
  /** /api/regime 的 series[key] */
  | { kind: 'regime'; key: SeriesKey }
  /** /api/regime 的 ohlc[key],取收盘 */
  | { kind: 'regimeOhlc'; key: string }
  /** /api/yield-curve?source=<curve> 的某个期限(利率页各曲线同一份;ai_cds 的「期限」是公司名) */
  | { kind: 'curve'; curve: CurveSource; tenor: string }
  /** 返回 `[{ date, <field> }]` 的接口取某一字段:/api/price(close)、25Δ、VRP、/api/series 都是这个形状 */
  | { kind: 'endpoint'; url: string; field: string }
  /** /api/yahoo/history/:symbol(任意 Yahoo 代码的日线收盘,读时现拉) */
  | { kind: 'yahoo'; symbol: string };

/** 编辑器用到的收益曲线源。取数层按源各开一个请求,没用到的不发。 */
export const CURVE_SOURCES = [
  'treasury',
  'real',
  'bei',
  'jgb',
  'sofr_ois',
  'credit_rating',
  'credit_term',
  'ai_cds',
] as const;
export type CurveSource = (typeof CURVE_SOURCES)[number];

export type SeriesDef = {
  id: string;
  label: string;
  category: SeriesCategory;
  freq: SeriesFreq;
  unit?: string;
  source: SeriesSource;
  /** 7×24 资产(含周末日线):取数时只留周一~周五,同 tenorHistory 的做法(见 useEditorSeriesData)。 */
  weekends?: true;
  /** 搜索用的别名 */
  aliases?: string[];
  /** 同一族(25Δ / VRP / VX 单月合约):下拉里默认只列 featured 的那几条,其余打代码才出现(同 TradingView 的期货合约) */
  family?: SeriesFamily;
  featured?: true;
  /** 交易代码(如 VXZ26):下拉里显示在右侧,也能按它搜 */
  code?: string;
};

export type SeriesFamily =
  | 'opt25'
  | 'vrp'
  | 'vx'
  | 'ust'
  | 'real'
  | 'bei'
  | 'jgb'
  | 'ois'
  | 'credit'
  | 'creditTerm'
  | 'cds'
  | 'fund';

export const CATEGORIES: SeriesCategory[] = [
  ...META_CATEGORIES.slice(0, 2),
  '期权',
  'VX 合约',
  ...META_CATEGORIES.slice(2),
  '基本面',
];

function endpoint(url: string, field: string): SeriesSource {
  return { kind: 'endpoint', url, field };
}

// ── price_eod 现货(与期权页蜡烛同一份,各自从上市日起)与 BTC 蜡烛
function price(id: string, symbol: string, label: string, aliases: string[]): SeriesDef {
  return {
    id,
    label,
    category: '资产',
    freq: '日',
    unit: '$',
    source: endpoint(`/api/price/${symbol}`, 'close'),
    aliases,
  };
}

const MANUAL: SeriesDef[] = [
  price('SPY', 'SPY', 'SPY 标普 500', ['标普', 's&p']),
  // id 沿用 regime 的 qqq(已有文档引用它);数据改走 price_eod:同一份收盘,但从 1999 上市日起(regime 那份截到 2018)
  price('qqq', 'QQQ', 'QQQ 纳指 100', ['纳指', 'nasdaq']),
  price('GLD', 'GLD', 'GLD 黄金', ['黄金', 'gold']),
  price('IBIT', 'IBIT', 'IBIT 比特币 ETF', ['比特币', 'bitcoin']),
  price('TLT', 'TLT', 'TLT 长期美债', ['美债', '国债']),
  price('USO', 'USO', 'USO 原油', ['原油', 'oil']),
  price('NOBL', 'NOBL', 'NOBL 标普红利贵族', ['红利', '防御']),
  {
    id: 'btc',
    label: 'BTC',
    category: '加密',
    freq: '日',
    unit: '$',
    source: { kind: 'regimeOhlc', key: 'btc' },
    weekends: true,
    aliases: ['比特币', 'bitcoin'],
  },
];

// ── 收益曲线各期限(/api/yield-curve)
// 期限 / 名单与服务端同一份(shared/rateCurveDefs)。唯独日债:服务端不写死期限,按 MOF CSV 表头现解析,
// 没有常量可共用,这里照表头抄一份(2026-11 实测 15 档);MOF 加档时编辑器会漏那一档,不会出错。
const JGB_TENORS = ['1Y', '2Y', '3Y', '4Y', '5Y', '6Y', '7Y', '8Y', '9Y', '10Y', '15Y', '20Y', '25Y', '30Y', '40Y'];

type CurveFamily = {
  curve: CurveSource;
  tenors: string[];
  id: (t: string) => string;
  label: (t: string) => string;
  category: SeriesCategory;
  unit: string;
  /** 整族共用;要按期限给的(如 us10y)传函数 —— 共用的话一搜就命中整族 */
  aliases: string[] | ((t: string) => string[]);
  /** 下拉里收成一族,只常显 featured 这几档(其余打期限才出现,见 familyVisible) */
  family: SeriesFamily;
  featured: string[];
};

function curveDefs({ curve, tenors, id, label, category, unit, aliases, family, featured }: CurveFamily): SeriesDef[] {
  return tenors.map((t) => ({
    id: id(t),
    label: label(t),
    category,
    freq: '日',
    unit,
    source: { kind: 'curve', curve, tenor: t },
    aliases: typeof aliases === 'function' ? aliases(t) : aliases,
    family,
    ...(featured.includes(t) && { featured: true as const }),
  }));
}

function lower(t: string) {
  return t.toLowerCase();
}

const CURVES: SeriesDef[] = (
  [
    {
      curve: 'treasury',
      tenors: UST_TENORS,
      // 美债 10Y 的 id 沿用 dgs10(已有文档引用它):与 regime 的 dgs10 同为财政部 10Y,但这里是 1990 起的长历史版
      id: (t) => (t === '10Y' ? 'dgs10' : `ust${lower(t)}`),
      label: (t) => `美债 ${t}`,
      category: '利率',
      unit: '%',
      aliases: (t) => ['国债', 'treasury', `us${lower(t)}`],
      family: 'ust',
      featured: ['2Y', '10Y'],
    },
    {
      curve: 'real',
      tenors: UST_REAL_TENORS,
      id: (t) => `real${lower(t)}`,
      label: (t) => `实际利率 ${t}`,
      category: '利率',
      unit: '%',
      aliases: ['tips', '实际收益率'],
      family: 'real',
      featured: ['10Y'],
    },
    {
      curve: 'bei',
      tenors: UST_REAL_TENORS,
      id: (t) => `bei${lower(t)}`,
      label: (t) => `通胀预期 BEI ${t}`,
      category: '通胀·宏观',
      unit: '%',
      aliases: ['bei', '盈亏平衡'],
      family: 'bei',
      featured: ['10Y'],
    },
    {
      // id 与 regime 的 jgb2y / jgb10y 相同(同为 MOF 曲线),手写优先 → 那两条也走曲线接口,15 档一套口径
      curve: 'jgb',
      tenors: JGB_TENORS,
      id: (t) => `jgb${lower(t)}`,
      label: (t) => `日债 ${t}`,
      category: '日本',
      unit: '%',
      aliases: ['jgb', '日本国债'],
      family: 'jgb',
      featured: ['2Y', '10Y'],
    },
    {
      curve: 'sofr_ois',
      tenors: ERIS_OIS_TENORS,
      id: (t) => `ois:${t}`,
      label: (t) => `SOFR OIS ${t}`,
      category: '利率',
      unit: '%',
      aliases: ['ois', 'sofr', 'swap'],
      family: 'ois',
      featured: ['12M'],
    },
    {
      curve: 'credit_rating',
      tenors: CREDIT_RATING.map((c) => c.tenor),
      id: (t) => `credit:${t}`,
      label: (t) => `信用利差 OAS ${t}`,
      category: '信用·流动性',
      unit: '%',
      aliases: ['oas', '信用利差'],
      family: 'credit',
      featured: ['BBB'],
    },
    {
      curve: 'credit_term',
      tenors: CREDIT_TERM.map((c) => c.tenor),
      id: (t) => `credit:${t}`,
      label: (t) => `投资级 OAS ${t}`,
      category: '信用·流动性',
      unit: '%',
      aliases: ['oas', '信用利差', '投资级'],
      family: 'creditTerm',
      featured: [],
    },
    {
      curve: 'ai_cds',
      tenors: AI_CDS.map((c) => c.name),
      id: (t) => `cds:${t}`,
      label: (t) => `${t} 5Y CDS`,
      category: 'AI 链',
      unit: 'bp',
      aliases: ['cds', '信用'],
      family: 'cds',
      featured: ['Oracle'],
    },
  ] satisfies CurveFamily[]
).flatMap(curveDefs);

// ── 期权:25Δ(本地库逐日快照,只能从开始采集那天往后攒)与 VRP(隐含 − 已实现)
function optionName(u: string) {
  return u.replace(/^\./, '');
}

const OPTIONS: SeriesDef[] = MARKET_CATALOG.filter((a) => a.optionSource !== 'none').flatMap((a) => {
  const u = a.underlying;
  const name = optionName(u);
  const url = `/api/options/25delta/${encodeURIComponent(u)}?days=3650`;
  const base = {
    category: '期权' as const,
    freq: '日' as const,
    family: 'opt25' as const,
    ...(u === 'BTC' && { weekends: true as const }),
  };
  const aliases = ['25d', '25Δ', '期权', 'skew'];

  return [
    {
      ...base,
      id: `opt:${name}:putIv`,
      label: `${name} 25Δ put IV`,
      unit: '%',
      source: endpoint(url, 'putIv'),
      aliases,
    },
    {
      ...base,
      id: `opt:${name}:callIv`,
      label: `${name} 25Δ call IV`,
      unit: '%',
      source: endpoint(url, 'callIv'),
      aliases,
    },
    {
      ...base,
      id: `opt:${name}:skew`,
      label: `${name} 25Δ skew (put − call)`,
      ...(u === 'SPY' && { featured: true as const }),
      unit: 'pp',
      source: endpoint(url, 'skew'),
      aliases,
    },
  ];
});

const IV_INDEX = ivIndexByUnderlying();
const VRP: SeriesDef[] = Object.entries(IV_INDEX).flatMap(([u, ivIndex]) => {
  const url = `/api/vrp/${encodeURIComponent(u)}`;
  const base = {
    category: '期权' as const,
    freq: '日' as const,
    family: 'vrp' as const,
    unit: '%',
    ...(u === 'BTC' && { weekends: true as const }),
  };
  const aliases = ['vrp', '波动率风险溢价'];

  return [
    { ...base, id: `vrp:${u}:iv`, label: `${u} 隐含波动率 (${ivIndex})`, source: endpoint(url, 'iv'), aliases },
    {
      ...base,
      id: `vrp:${u}:rv`,
      label: `${u} 已实现波动率 RV`,
      source: endpoint(url, 'rv'),
      aliases: [...aliases, 'rv'],
    },
    {
      ...base,
      id: `vrp:${u}:vrp`,
      label: `${u} VRP (隐含 − 已实现)`,
      source: endpoint(url, 'vrp'),
      aliases,
      ...(u === 'SPY' && { featured: true as const }),
    },
  ];
});

// ── 库里 market_series 有、别的接口没发的(/api/series/:id 原样读)。
// 没列的都已经从别处发了:VIX / SKEW / MOVE / VXN / ISM / CGI(GPU)/ 供应密度在 regime,
// ERIS_OIS / ICE_CDS 在曲线接口(CDS 库里存的是价,曲线接口换成了 bp),SEC_* / TWSE_* 即基本面 fund:*。
export const DB_PREFIX = 'db:';
function dbSource(seriesId: string) {
  return endpoint(`/api/series/${encodeURIComponent(seriesId)}`, 'value');
}
function db(seriesId: string, label: string, aliases: string[] = [], weekends?: true): SeriesDef {
  return {
    id: `${DB_PREFIX}${seriesId}`,
    label,
    category: '波动率',
    freq: '日',
    source: dbSource(seriesId),
    aliases,
    ...(weekends && { weekends }),
  };
}

const DB_SERIES: SeriesDef[] = [
  db('VVIX', 'VVIX (VIX 的波动率)'),
  // 连续合约归到「VX 合约」组:那组的单月合约默认收起,这两条是组里常显的入口(代码同 TradingView 的 VX1! 写法)
  { ...db('VX1', 'VX 近月连续', ['vx', '期货']), category: 'VX 合约', code: 'VX1!' },
  { ...db('VX3', 'VX 第三近月连续', ['vx', '期货']), category: 'VX 合约', code: 'VX3!' },
  db('GVZ', 'GVZ 黄金波动率', ['黄金', 'gold']),
  db('OVX', 'OVX 原油波动率', ['原油', 'oil']),
  db('VXTLT', 'VXTLT 美债波动率', ['美债']),
  db('BITVX', 'BITVX 比特币 ETF 波动率', ['比特币', 'bitcoin']),
  db('DVOL', 'DVOL 比特币波动率 (Deribit)', ['比特币', 'bitcoin'], true),
];

/** VX 单月合约(`VX:<到期日>`):份数随时间增加,名单由 /api/series?prefix=VX: 现取(见 useVxContracts)。 */
export const VX_CONTRACT_PREFIX = 'VX:';
// 期货月份代码(CME / CBOE 通用):1 月 F … 12 月 Z。VXZ26 = 2026 年 12 月到期的 VX
const MONTH_CODES = 'FGHJKMNQUVXZ';

function vxContractDef(seriesId: string): SeriesDef {
  const expiry = seriesId.slice(VX_CONTRACT_PREFIX.length);
  const month = MONTH_CODES[Number(expiry.slice(5, 7)) - 1];
  const code = `VX${month}${expiry.slice(2, 4)}`;

  return {
    id: `${DB_PREFIX}${seriesId}`,
    label: `VX ${expiry} 到期`,
    category: 'VX 合约',
    freq: '日',
    source: dbSource(seriesId),
    aliases: ['vx', '期货', '合约', `VX${month}${expiry.slice(0, 4)}`],
    family: 'vx',
    code,
  };
}

// ── 基本面(/api/regime 的 fund:*,AI 链公司季报;名单与面板同源,见 shared/aiChain)
const MONEY_UNIT = { USD: '百万美元', TWD: '百万新台币', EUR: '百万欧元', KRW: '百万韩元' } as const;
const FUND_KIND: Record<FundKind, { label: string; freq: SeriesFreq; money?: true; unit?: string }> = {
  gm: { label: 'TTM 毛利率', freq: '季', unit: '%' },
  capex: { label: 'TTM 资本开支', freq: '季', money: true },
  fcf: { label: 'TTM 自由现金流', freq: '季', money: true },
  fcfq: { label: '单季自由现金流', freq: '季', money: true },
  rev: { label: 'TTM 营收', freq: '季', money: true },
  revGrowth: { label: '单季营收同比', freq: '季', unit: '%' },
  capexCloud: { label: '单季 capex / 云收入', freq: '季', unit: '倍' },
  revM: { label: '月营收', freq: '月', money: true },
  revYoy: { label: '月营收同比', freq: '月', unit: '%' },
};

// 买方合计(跨公司的那两条)常显;各家公司的格子收起,打代码(如 NVDA)才出现
function fundDef(key: SeriesKey, label: string, freq: SeriesFreq, unit: string, ticker: string): SeriesDef {
  return {
    id: key,
    label,
    category: '基本面',
    freq,
    unit,
    source: { kind: 'regime', key },
    aliases: [ticker.toLowerCase(), '财报', '基本面'],
    family: 'fund',
    ...(ticker === 'buyer' && { featured: true as const }),
  };
}

const FUNDAMENTALS: SeriesDef[] = [
  ...ACTIVE_TICKERS.flatMap((t) =>
    kindsOf(t).map((k) => {
      const { label, freq, money, unit } = FUND_KIND[k];
      return fundDef(fundKey(t, k), `${t} ${label}`, freq, money ? MONEY_UNIT[currencyOf(t)] : (unit ?? ''), t);
    }),
  ),
  fundDef(SEC_BUYER_FCF_KEY, '买方合计 TTM 自由现金流', '季', '百万美元', 'buyer'),
  fundDef(SEC_BUYER_FCFQ_KEY, '买方合计单季自由现金流', '季', '百万美元', 'buyer'),
];

// ── /api/regime 的枚举序列(SERIES_META 生成)。手写的优先:同名的 regime 序列(如 dgs10)不再生成
const HAND: SeriesDef[] = [...MANUAL, ...CURVES, ...OPTIONS, ...VRP, ...DB_SERIES];
const OVERRIDDEN = new Set(HAND.map((d) => d.id));

const FROM_META: SeriesDef[] = REGIME_SERIES.filter(
  (k) => SERIES_META[k].chartable !== false && !OVERRIDDEN.has(k),
).map((k) => {
  const { label, category, freq, unit, aliases, weekends } = SERIES_META[k];
  return {
    id: k,
    label,
    category,
    freq,
    source: { kind: 'regime', key: k },
    ...(unit && { unit }),
    ...(weekends && { weekends }),
    ...(aliases && { aliases }),
  };
});

export const REGISTRY: SeriesDef[] = [...HAND, ...FROM_META, ...FUNDAMENTALS];

const BY_ID = new Map(REGISTRY.map((d) => [d.id, d]));

export const YAHOO_PREFIX = 'yh:';
export function yahooId(symbol: string) {
  return `${YAHOO_PREFIX}${symbol.toUpperCase()}`;
}

// 库里已有的 Yahoo 代码 → 库里那条的 id。搜索结果遇到它们直接给库里那条(有库兜底、带中文别名),不再并列一条 yh:。
// price_eod 的几只按代码自动对上;下面是代码与 id 不同名的。
const YAHOO_IN_LIBRARY: Record<string, string> = {
  QQQ: 'qqq',
  'DX-Y.NYB': 'usd',
  'JPY=X': 'usdjpy',
  '^VIX': 'vix',
  '^VXN': 'vxn',
  '^MOVE': 'move',
  '^SKEW': 'skew',
  '^VIX6M': 'vix6m',
  '^VIXEQ': 'vixeq',
  '^COR1M': 'cor1m',
  '^COR3M': 'cor3m',
  // CBOE 指数库里另存了一份(/api/series 原样读),与 Yahoo 同一个数
  '^VVIX': 'db:VVIX',
  '^GVZ': 'db:GVZ',
  '^OVX': 'db:OVX',
  '^VXTLT': 'db:VXTLT',
  '^BITVX': 'db:BITVX',
  'BTC-USD': 'btc',
  '8306.T': 'mufg',
  'HO=F': 'ulsd',
};

/** Yahoo 代码在库里对应的序列 id;库里没有 → undefined。 */
export function libraryIdForYahoo(symbol: string): string | undefined {
  const s = symbol.toUpperCase();
  const src = BY_ID.get(s)?.source;
  const id = YAHOO_IN_LIBRARY[s] ?? (src?.kind === 'endpoint' && src.url === `/api/price/${s}` ? s : undefined);
  return id && BY_ID.has(id) ? id : undefined;
}

// Yahoo 代码的显示名(搜索结果 / 取数响应里带回来)。文档只存代码,名字不进 JSON,
// 所以记在这里给标签用;没记到(比如以后从存档载入、还没取到数)就只显示代码。
const yahooNames = new Map<string, string>();
export function rememberYahooName(symbol: string, name: string) {
  yahooNames.set(symbol.toUpperCase(), name);
}

export function seriesDef(id: string): SeriesDef | undefined {
  const known = BY_ID.get(id);
  if (known) return known;
  // VX 单月合约不在静态表里(名单现取):按 id 直接生成定义,存档载入时不必等名单
  if (id.startsWith(`${DB_PREFIX}${VX_CONTRACT_PREFIX}`)) return vxContractDef(id.slice(DB_PREFIX.length));
  if (!id.startsWith(YAHOO_PREFIX)) return undefined;

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

/** VX 合约的 series_id 清单 → 定义(按到期日倒序:近的在前)。 */
export function vxContractDefs(seriesIds: string[]): SeriesDef[] {
  return [...seriesIds].sort().reverse().map(vxContractDef);
}

/**
 * 族成员什么时候列出来:常显的(featured)总列;其余要打了关键字才列 —— 下拉一打开就摊开 24 条 25Δ、
 * 115 份 VX 合约太冗余。VX 单月合约还要关键字里带数字(年 / 月,或 VXZ26 这种代码),光打「vx」只给连续合约。
 */
function familyVisible(d: SeriesDef, q: string): boolean {
  if (!d.family || d.featured) return true;
  return q !== '' && (d.family !== 'vx' || /\d/.test(q));
}

/** 族在提示里怎么称呼:名称、量词、一个搜索示例(示例须真能搜到) */
const FAMILY_HINT: Record<SeriesFamily, { name: string; unit: string; example: string }> = {
  opt25: { name: '25Δ', unit: '条', example: 'QQQ 25' },
  vrp: { name: 'VRP', unit: '条', example: 'TLT VRP' },
  vx: { name: '单月合约', unit: '份', example: 'VXZ26' },
  ust: { name: '美债', unit: '档', example: '美债 5Y' },
  real: { name: '实际利率', unit: '档', example: '实际利率 30Y' },
  bei: { name: 'BEI', unit: '档', example: 'BEI 5Y' },
  jgb: { name: '日债', unit: '档', example: '日债 30Y' },
  ois: { name: 'OIS', unit: '档', example: 'OIS 3M' },
  credit: { name: '评级 OAS', unit: '档', example: 'OAS BB' },
  creditTerm: { name: '投资级 OAS', unit: '档', example: 'OAS 1-3Y' },
  cds: { name: 'CDS', unit: '家', example: 'Nvidia' },
  fund: { name: '公司财报', unit: '条', example: 'NVDA' },
};

/** 各分组里因为没打代码而收起的族,每族一句提示(下拉的组标题后面显示)。 */
export function familyHints(query: string, defs: SeriesDef[]): Partial<Record<SeriesCategory, string>> {
  const q = query.trim().toLowerCase();
  const hidden = defs.filter((d) => !familyVisible(d, q));
  const categories = [...new Set(hidden.map((d) => d.category))];

  return Object.fromEntries(
    categories.map((c) => {
      const inCategory = hidden.filter((d) => d.category === c);
      const families = [...new Set(inCategory.map((d) => d.family as SeriesFamily))];
      const counts = families.map((f) => {
        const { name, unit } = FAMILY_HINT[f];
        return `${name} ${inCategory.filter((d) => d.family === f).length} ${unit}`;
      });
      const examples = families.map((f) => `「${FAMILY_HINT[f].example}」`).join('');
      return [c, `另有 ${counts.join('、')} · 输入如${examples}`];
    }),
  );
}

/** 搜索:名称 / id / 别名 / 代码包含关键字(不区分大小写)。extra = 现取的动态名单(VX 合约)。族成员按 familyVisible 收起。 */
export function searchSeries(query: string, extra: SeriesDef[] = []): SeriesDef[] {
  const all = extra.length ? [...REGISTRY, ...extra] : REGISTRY;
  const q = query.trim().toLowerCase();

  return all.filter(
    (d) =>
      familyVisible(d, q) &&
      (!q || [d.label, d.id, d.code ?? '', ...(d.aliases ?? [])].some((s) => s.toLowerCase().includes(q))),
  );
}
