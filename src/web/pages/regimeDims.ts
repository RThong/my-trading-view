// regime 视角的总表:各视角的 ChartDoc 汇总成 REGIME_DOCS,外加按名单现算的基本面维度(fundamentalDoc)。都由 DocChart 画。
// 放在 pages 层:视图(views/chartDoc、views/regime)只收 ChartDoc,不认识具体有哪些视角。
import type { ChartDoc } from '../views/chartDoc/chartDoc';
import type { FixedDim, FundDim } from '../views/regime/regimeChart.hooks';
import { AI_DOCS } from './ai/docs';
import { fundDoc } from './ai/fundamentals';
import { BTC_DOCS } from './btc/docs';
import { CREDIT_DOCS } from './credit/docs';
import { CONCENTRATION } from './featured/concentration';
import { INFLATION_DOCS } from './inflation/docs';
import { JAPAN_DOCS } from './japan/docs';
import { LIQUIDITY_DOCS } from './liquidity/docs';
import { MACRO_DOCS } from './macro/docs';
import { OIL_DOCS } from './oil/docs';
import { RATES_DOCS } from './rates/docs';
import { SENTIMENT_DOCS } from './sentiment/docs';
import { VALUATION_DOCS } from './valuation/docs';

// 类型保证每个固定 dim 都有一份 doc;跨文件重名靠 views/regime/docs.test 查(展开时后者静默盖前者)
export const REGIME_DOCS: Record<FixedDim, ChartDoc> = {
  ...CREDIT_DOCS,
  ...LIQUIDITY_DOCS,
  ...SENTIMENT_DOCS,
  ...MACRO_DOCS,
  ...JAPAN_DOCS,
  ...RATES_DOCS,
  ...INFLATION_DOCS,
  ...OIL_DOCS,
  ...BTC_DOCS,
  ...AI_DOCS,
  ...VALUATION_DOCS,
  concentration: CONCENTRATION,
};

// 按 dim 缓存:同一 dim 永远拿到同一份 doc(DocChart 以它为初值;按名单现算,不缓存的话每次都是新对象)。
// 没打开的 tab 也不会提前算。
const FUND_DOCS = new Map<FundDim, ChartDoc>();

/** 基本面 dim → 它的 ChartDoc(按公司名单与数据源现算,见 ai/fundamentals 的 fundDoc)。 */
export function fundamentalDoc(dim: FundDim): ChartDoc {
  const hit = FUND_DOCS.get(dim);
  if (hit) return hit;

  const doc = fundDoc(dim.slice('fundamentals:'.length));
  FUND_DOCS.set(dim, doc);
  return doc;
}
