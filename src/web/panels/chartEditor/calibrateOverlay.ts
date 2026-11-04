// 回测「叠加对比」的选段门槛(OVERLAY_RULES):拿公认有关 / 无关的组合看判得对不对,再拿随机走势量误报率。
// 改门槛前后各跑一次比对:bun run src/web/panels/chartEditor/calibrateOverlay.ts(要先起 dev server,读 localhost:3000)。
// 只读接口、不写库。判断逻辑与按钮共用 findBaseSegment,不另写一套。
import { isWeekend } from '../../chart/core';
import { findBaseSegment, type Segment } from '../../chart/analysis';

type P = { time: string; value: number };
type Row = { date: string; value: number };
type View = { from: string; to: string };

const API = process.env.API ?? 'http://localhost:3000';
async function get<T>(path: string): Promise<T> {
  const r = await fetch(API + path);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json() as Promise<T>;
}

const regime = await get<{ series: Record<string, Row[]>; ohlc: Record<string, { time: string; close: number }[]> }>(
  '/api/regime',
);
const real = await get<{ series: Record<string, Row[]> }>('/api/yield-curve?source=real&history=full');
function rows(r: Row[]): P[] {
  return r.map((x) => ({ time: x.date, value: x.value }));
}
async function price(s: string): Promise<P[]> {
  return (await get<{ date: string; close: number }[]>(`/api/price/${s}`)).map((x) => ({
    time: x.date,
    value: x.close,
  }));
}
function ohlc(k: string): P[] {
  return regime.ohlc[k].map((x) => ({ time: x.time, value: x.close }));
}
function weekday(p: P[]) {
  return p.filter((x) => !isWeekend(x.time));
}

const ALL: View = { from: '1900-01-01', to: '2100-01-01' };
const [gld, spy, tlt, uso] = await Promise.all(['GLD', 'SPY', 'TLT', 'USO'].map(price));
const real10 = rows(real.series['10Y']);
const btc = weekday(ohlc('btc'));
function s(k: string) {
  return rows(regime.series[k]);
}

/** expect:应当选出段(有稳定关系)还是选不出;note 写预期的大致时段,人工核对 */
const CASES: { name: string; a: P[]; b: P[]; view: View; expect: boolean; note?: string }[] = [
  { name: '黄金 × 实际利率 10Y', a: gld, b: real10, view: ALL, expect: true, note: '应停在 2022 年前后' },
  { name: '黄金 × 实际利率 10Y', a: gld, b: real10, view: { from: '2022-01-01', to: '2100-01-01' }, expect: false },
  { name: 'VIX × 高收益债利差', a: s('vix'), b: s('hyOas'), view: ALL, expect: true },
  { name: '美元指数 × 美元兑日元', a: s('usd'), b: s('usdjpy'), view: ALL, expect: true },
  { name: 'BTC × QQQ', a: btc, b: ohlc('qqq'), view: ALL, expect: true },
  { name: 'SPY × TLT(2022 股债同跌)', a: spy, b: tlt, view: { from: '2021-07-01', to: '2023-06-30' }, expect: true },
  { name: 'BTC × 日债 10Y', a: btc, b: s('jgb10y'), view: ALL, expect: false },
  { name: 'SPY × 原油 USO', a: spy, b: uso, view: ALL, expect: false },
  { name: 'SPY × TLT(全时段,正负翻过几次)', a: spy, b: tlt, view: ALL, expect: false },
];

function f(x: number) {
  return Number.isFinite(x) ? x.toFixed(2) : 'NaN';
}
function describe(sg: Segment) {
  return `${sg.from}~${sg.to} ${(sg.months / 12).toFixed(1)}年 涨跌r ${f(sg.rc)}(需≥${f(sg.need)}) 4份过${sg.parts} 水平r ${f(sg.rl)}`;
}

console.log('## 已知组合');
const results = CASES.map(({ name, a, b, view, expect, note }) => {
  const { best, whole } = findBaseSegment(a, b, view);
  const ok = !!best === expect;
  const where = view === ALL ? '全时段' : `${view.from}~${view.to.startsWith('2100') ? '' : view.to}`;
  console.log(`${ok ? '✓' : '✗'} ${name} [${where}] 预期${expect ? '有' : '无'}`);
  console.log(`    选中: ${best ? describe(best) : '无'}${note ? `   (${note})` : ''}`);
  if (!best && whole) console.log(`    整段: ${describe(whole)} 没过: ${whole.fails.join('、')}`);
  return ok;
});
console.log(`已知组合判对 ${results.filter(Boolean).length}/${results.length}`);

// 随机走势:两条独立的对数随机游走,任何一段的「关系」都是碰巧 —— 选出段的比例就是误报率
function walk(seed: number, n: number): P[] {
  let st = seed >>> 0;
  const rnd = () => {
    st = (st + 0x6d2b79f5) >>> 0;
    let t = st;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const t0 = Date.parse('2006-01-02T00:00:00Z');
  const days = Array.from({ length: Math.ceil(n * 1.45) }, (_, d) => new Date(t0 + d * 86_400_000))
    .filter((d) => ![0, 6].includes(d.getUTCDay()))
    .slice(0, n);
  return days.reduce<P[]>((acc, d) => {
    const prev = acc.at(-1)?.value ?? 100;
    const g = Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
    acc.push({ time: d.toISOString().slice(0, 10), value: prev * Math.exp(g * 0.01) });
    return acc;
  }, []);
}

const TRIALS = Number(process.env.TRIALS ?? 200);
console.log(`\n## 随机对照(${TRIALS} 对)`);
const VIEWS: [string, View][] = [
  ['全时段', ALL],
  ['视口 1 年', { from: '2024-01-01', to: '2024-12-31' }],
  ['视口 2 年', { from: '2023-01-01', to: '2024-12-31' }],
];
VIEWS.forEach(([label, view]) => {
  const hits = Array.from({ length: TRIALS }, (_, k) =>
    findBaseSegment(walk(k * 7919 + 1, 5000), walk(k * 104729 + 3, 5000), view),
  ).filter((r) => r.best).length;
  console.log(`${label}: 误报 ${hits}/${TRIALS}(${((hits / TRIALS) * 100).toFixed(1)}%)`);
});
