// 竖 tab = 视角;每个视角自带横 tab 列表,每个 tab 自带渲染闭包(label/source/render 一处配置)。
// 取代原 App 里"tabs 只声明 id/label + 相邻 render(tabId) 用字符串分支决定内容"的分离写法——
// 新增 tab = 往所属视角(pages/<视角>/index)的数组加一条工厂调用,不再牵动 render 分支,两者也不会漂移。
// 这里只管组装与竖 tab 的先后顺序;工厂与类型在 pages/tabs。
import { AI } from './pages/ai';
import { BTC } from './pages/btc';
import { CREDIT } from './pages/credit';
import { EDITOR } from './pages/editor';
import { FEATURED } from './pages/featured';
import { INFLATION } from './pages/inflation';
import { JAPAN } from './pages/japan';
import { LIQUIDITY } from './pages/liquidity';
import { MACRO } from './pages/macro';
import { OIL } from './pages/oil';
import { OPTIONS } from './pages/options';
import { RATES } from './pages/rates';
import { SENTIMENT } from './pages/sentiment';
import type { Perspective } from './pages/tabs';
import { VALUATION } from './pages/valuation';

export type { Perspective, TabDef } from './pages/tabs';

export const PERSPECTIVES: Perspective[] = [
  OPTIONS,
  CREDIT,
  LIQUIDITY,
  SENTIMENT,
  MACRO,
  OIL,
  BTC,
  RATES,
  JAPAN,
  INFLATION,
  VALUATION,
  AI,
  FEATURED,
  EDITOR,
];
