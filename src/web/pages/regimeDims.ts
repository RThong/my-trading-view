// regime 视角的总表:各视角的 ChartDoc 汇总成 REGIME_DOCS,外加按名单派生的基本面维度。
// 放在 pages 层:视图(views/regime)只收 panes,不认识具体有哪些视角。
import { sourcesOf } from '../../shared/aiChain';
import type { ChartDoc } from '../views/chartDoc/chartDoc';
import {
  docToPaneSpecs,
  type FixedDim,
  type PaneSpec,
  type RegimeDim,
  type RegimeView,
} from '../views/regime/regimeChart.hooks';
import { AI_DOCS } from './ai/docs';
import { buyerAggregatePane, buyerQuarterlyPane, SOURCE_PANES } from './ai/fundamentals';
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

// 类型保证每个固定 dim 都有一份 doc;跨文件重名靠 regimeChart.hooks.test 查(展开时后者静默盖前者)
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

// 模块加载时转一次:doc 写错的话 docToPaneSpecs 会抛,在加载时就炸,不等到打开那个 tab
const DOC_PANES = Object.fromEntries(
  Object.entries(REGIME_DOCS).map(([dim, doc]) => [dim, docToPaneSpecs(doc)]),
) as Record<FixedDim, PaneSpec[]>;
function buildPanes(dim: RegimeDim): PaneSpec[] {
  if (!dim.startsWith('fundamentals:')) return DOC_PANES[dim as FixedDim];

  const who = dim.slice('fundamentals:'.length);
  if (who === 'buyer') return [buyerAggregatePane, buyerQuarterlyPane];

  // 一家可能走多个源(TSM:季度四格来自 sec6k、月营收两格来自 twse)—— 各源的格子按 sources
  // 顺序拼起来。同一个 key 只留一次:sec 与 sec6k 共用 companyPanes,同时声明两者时会重。
  const seen = new Set<string>();
  return sourcesOf(who)
    .flatMap((s) => SOURCE_PANES[s](who))
    .filter((p) => !seen.has(p.key) && seen.add(p.key));
}

// 按 dim 缓存:同一 dim 永远拿到同一个对象。RegimeChart 要求 panes 引用稳定(基本面维度按名单现算,
// 不缓存的话每次都是新数组),缓存放在这里,调用方在 render 里直接调也安全;没打开的 tab 也不会提前算。
const VIEWS = new Map<RegimeDim, RegimeView>();

/** dim → 这张 regime 图的配置(dim + panes)。 */
export function regimeView(dim: RegimeDim): RegimeView {
  const hit = VIEWS.get(dim);
  if (hit) return hit;

  const view = { dim, panes: buildPanes(dim) };
  VIEWS.set(dim, view);
  return view;
}

/** dim → panes(同 regimeView,只取格子)。 */
export function dimPanes(dim: RegimeDim): PaneSpec[] {
  return regimeView(dim).panes;
}
