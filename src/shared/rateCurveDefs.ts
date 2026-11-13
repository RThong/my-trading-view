// 收益曲线页(/api/yield-curve)各条曲线的期限 / 名单。纯数据,前后端共用:
// 服务端按它取数(analytics/rateCurves),图表编辑器按它生成序列名单(web/views/chartDoc/registry)。

// ── 美国财政部每日曲线(server/fetchers/usTreasuryPar 按列名解析)
// 名义 par yield:财政部列名 → 本项目期限标签。只取标准 11 档(各年新增的 1.5Mo/2Mo/4Mo 等额外档忽略)。
export const UST_COL_TO_TENOR: Record<string, string> = {
  '1 Mo': '1M',
  '3 Mo': '3M',
  '6 Mo': '6M',
  '1 Yr': '1Y',
  '2 Yr': '2Y',
  '3 Yr': '3Y',
  '5 Yr': '5Y',
  '7 Yr': '7Y',
  '10 Yr': '10Y',
  '20 Yr': '20Y',
  '30 Yr': '30Y',
};

// TIPS 实际收益率(real yield curve):只有 5 档,表头是全大写「5 YR」,与名义表不同。
// 短端止于 5Y(TIPS 无流动短端)。2018 年 CSV 首行 01/02/2018 即有数。
export const UST_REAL_COL_TO_TENOR: Record<string, string> = {
  '5 YR': '5Y',
  '7 YR': '7Y',
  '10 YR': '10Y',
  '20 YR': '20Y',
  '30 YR': '30Y',
};

// 期限展示顺序(= 曲线 x 轴)。直接派生自上表的值顺序,避免两张平行表 desync。
export const UST_TENORS = Object.values(UST_COL_TO_TENOR);
export const UST_REAL_TENORS = Object.values(UST_REAL_COL_TO_TENOR);

// Eris ParCouponCurve 的 24 档期限(顺序即曲线 x 轴)。存库 series_id = ERIS_OIS_{tenor}。
export const ERIS_OIS_TENORS: string[] = [
  '1D',
  '1W',
  '1M',
  '3M',
  '6M',
  '9M',
  '12M',
  '18M',
  '2Y',
  '3Y',
  '4Y',
  '5Y',
  '6Y',
  '7Y',
  '8Y',
  '9Y',
  '10Y',
  '12Y',
  '15Y',
  '20Y',
  '25Y',
  '30Y',
  '40Y',
  '50Y',
];

// 信用利差曲线(FRED ICE BofA OAS,读时现拉,值已是百分点)。
export const CREDIT_RATING: { tenor: string; series: string }[] = [
  { tenor: 'AAA', series: 'BAMLC0A1CAAA' },
  { tenor: 'AA', series: 'BAMLC0A2CAA' },
  { tenor: 'A', series: 'BAMLC0A3CA' },
  { tenor: 'BBB', series: 'BAMLC0A4CBBB' },
  { tenor: 'BB', series: 'BAMLH0A1HYBB' },
  { tenor: 'B', series: 'BAMLH0A2HYB' },
  { tenor: 'CCC', series: 'BAMLH0A3HYC' },
];

export const CREDIT_TERM: { tenor: string; series: string }[] = [
  { tenor: '1-3Y', series: 'BAMLC1A0C13Y' },
  { tenor: '3-5Y', series: 'BAMLC2A0C35Y' },
  { tenor: '5-7Y', series: 'BAMLC3A0C57Y' },
  { tenor: '7-10Y', series: 'BAMLC4A0C710Y' },
  { tenor: '10-15Y', series: 'BAMLC7A0C1015Y' },
  { tenor: '15Y+', series: 'BAMLC8A0C15PY' },
];

// AI 资本开支巨头 + 甲骨文 + 新云 CoreWeave + SpaceX 的单名 CDS(ICE Clear Credit 免费 EOD 结算价)。
// ticker = ICE instrumentName 首段;name = 显示名(不依赖 ICE 里的 "Oracle Cop" 等错拼)。
// 存库 series_id = ICE_CDS_{ticker}。顺序:焦点 Oracle 打头,其余按篮子排。
// core = 前端默认展示的 7 家;缺任一即视为数据源异常(见 missingCoreCds)。
// 注:前端「AI CDS」tab 默认显示的就是这份 core 名单(pages/ai/docs 直接读它)。
// coupon 缺省 = 100bp(投资级惯例);高收益名只挂 500bp 合约,需单独给。
// jpy = 不走 ICE:日元计价、来自 DTCC 成交披露,存库 series_id = DTCC_CDS_{ticker}(见 fetchers/dtccSbgCds)。
export const AI_CDS: { ticker: string; name: string; core?: boolean; coupon?: number; jpy?: boolean }[] = [
  { ticker: 'ORCLE', name: 'Oracle', core: true },
  { ticker: 'MSFT', name: 'Microsoft', core: true },
  { ticker: 'ALPHINC', name: 'Alphabet', core: true },
  { ticker: 'AMZN', name: 'Amazon', core: true },
  { ticker: 'APLINC', name: 'Apple', core: true },
  { ticker: 'NVIDIA', name: 'Nvidia', core: true },
  { ticker: 'BROINC', name: 'Broadcom' },
  { ticker: 'DELLN', name: 'Dell' },
  { ticker: 'INTC', name: 'Intel' },
  { ticker: 'METAPL', name: 'Meta', core: true },
  // 新云(租算力给巨头、自己举债买卡)= 信贷型脆弱的前线;2026-10-15 起才攒数。
  // 非 core:利差 ~1000bp 量级,默认勾选会把其余几家压成一条线。
  { ticker: 'COREWEI', name: 'CoreWeave', coupon: 500 },
  // FT 2026-10-20(大摩数据):AI 对冲盘集中买的七家 CDS 之一,其余六家上面都有。2026-10-20 起才攒数。
  // 非 core:新挂的名,缺失不该让 job failed;~227bp 低于甲骨文,不压扁别的线,但默认勾选须与 core 名单一致,故不默认勾。
  { ticker: 'SPACEXP', name: 'SpaceX' },
  // AI 链上最大的举债方之一(OpenAI / Stargate)。ICE 没有日本名字 → DTCC 成交价,日元计价、成交稀(2026 年约六成工作日有点,2025 年约三成)。
  // 日元计价比同一家的美元 CDS 读数偏低(日本公司违约时日元大概率同时贬值),跟美元那几家比水平时要记着。
  // 非 core:~500bp 量级会压扁其余几家;缺数不该让 ice_cds 告警(它自己一组 sbg_cds)。
  { ticker: 'SBG', name: 'SoftBank (JPY)', jpy: true },
];
