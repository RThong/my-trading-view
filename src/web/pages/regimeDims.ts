// regime 视角的总表:各视角的 dims 汇总成 REGIME_DIMS,外加已迁 ChartDoc 的维度与按名单派生的基本面维度。
// 放在 pages 层:视图(views/regime)只收 panes,不认识具体有哪些视角。
import { sourcesOf } from '../../shared/aiChain';
import type { ChartDoc } from '../views/chartDoc/chartDoc';
import {
  docToPaneSpecs,
  type DimConfig,
  type DocDim,
  type FixedDim,
  type PaneSpec,
  type RegimeDim,
} from '../views/regime/regimeChart.hooks';
import { buyerAggregatePane, buyerQuarterlyPane, SOURCE_PANES } from './ai/fundamentals';
import { AI_DIMS } from './ai/dims';
import { BTC_DIMS } from './btc/dims';
import { CREDIT_DIMS } from './credit/dims';
import { CONCENTRATION } from './featured/concentration';
import { INFLATION_DIMS } from './inflation/dims';
import { JAPAN_DIMS } from './japan/dims';
import { LIQUIDITY_DIMS } from './liquidity/dims';
import { MACRO_DIMS } from './macro/dims';
import { OIL_DIMS } from './oil/dims';
import { RATES_DIMS } from './rates/dims';
import { SENTIMENT_DIMS } from './sentiment/dims';
import { VALUATION_DIMS } from './valuation/dims';

export const REGIME_DOCS: Record<DocDim, ChartDoc> = {
  concentration: CONCENTRATION,
};

// 类型保证每个固定 dim 都有配置;跨文件重名靠 regimeChart.hooks.test 查(展开时后者静默盖前者)
export const REGIME_DIMS: Record<Exclude<FixedDim, DocDim>, DimConfig> = {
  ...CREDIT_DIMS,
  ...LIQUIDITY_DIMS,
  ...SENTIMENT_DIMS,
  ...MACRO_DIMS,
  ...JAPAN_DIMS,
  ...RATES_DIMS,
  ...INFLATION_DIMS,
  ...OIL_DIMS,
  ...BTC_DIMS,
  ...AI_DIMS,
  ...VALUATION_DIMS,
};

// 模块加载时转一次:固定维度的 panes 要是模块常量(RegimeChart 按引用做 memo,见那边的注释)
const DOC_PANES = Object.fromEntries(
  Object.entries(REGIME_DOCS).map(([dim, doc]) => [dim, docToPaneSpecs(doc)]),
) as Record<DocDim, PaneSpec[]>;
/** dim → panes。基本面维度按名单现算(引用每次新建,故 RegimeChart 里要 useMemo 化的地方已由 dim 固定)。 */
export function dimPanes(dim: RegimeDim): PaneSpec[] {
  if (Object.hasOwn(DOC_PANES, dim)) return DOC_PANES[dim as DocDim];
  if (!dim.startsWith('fundamentals:')) return REGIME_DIMS[dim as Exclude<FixedDim, DocDim>].panes;

  const who = dim.slice('fundamentals:'.length);
  if (who === 'buyer') return [buyerAggregatePane, buyerQuarterlyPane];

  // 一家可能走多个源(TSM:季度四格来自 sec6k、月营收两格来自 twse)—— 各源的格子按 sources
  // 顺序拼起来。同一个 key 只留一次:sec 与 sec6k 共用 companyPanes,同时声明两者时会重。
  const seen = new Set<string>();
  return sourcesOf(who)
    .flatMap((s) => SOURCE_PANES[s](who))
    .filter((p) => !seen.has(p.key) && seen.add(p.key));
}
