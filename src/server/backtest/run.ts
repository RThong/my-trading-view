/**
 * 回测 v1 CLI:QQQ 基准 + TQQQ 轮动腿(A/B/C 消融)+ 现金减仓保险基准。
 * 抓 QQQ/TQQQ 复权价(内存,不落库)+ 读库里 VX1/VX3 算 spread → 对齐 → 打印对比表。
 *   bun run src/server/backtest/run.ts
 */
import { openDb } from '../storage/db';
import { getMarketSeries } from '../storage/repository';
import { computeSpread } from '../analytics/termStructure';
import { createYahooFetcher } from '../fetchers/yahoo';
import { HISTORY_START_DATE } from '../config';
import { computeStates, DEFAULT_SIGNAL, type PanicEntry, type DayState, type SpreadPoint } from './signal';
import { runBacktest, type AlignedRow, type EngineConfig } from './engine';
import { overlayPut, type PutConfig, type PutDay } from './putLeg';
import { metrics, episodes } from './metrics';

const ENGINE = { tqqqSleeve: 0.3, cashSleeve: 0.2, costBps: 5 } as const;
const PUT: PutConfig = { protectedNotional: 0.2, premiumBudgetAnnual: 0.02, moneyness: 1, tenorDays: 21, skewMarkup: 1.1 };
const VARIANTS: PanicEntry[] = ['A', 'B', 'C'];

const pct = (x: number) => (x * 100).toFixed(2) + '%';
const pad = (s: string, n: number) => s.padEnd(n);

async function main() {
  const db = openDb();
  const spreadRows = computeSpread(getMarketSeries(db, 'VX1'), getMarketSeries(db, 'VX3'));
  const vxnMap = new Map(getMarketSeries(db, 'VXN').map((r) => [r.date, r.value]));
  db.close();

  const yahoo = createYahooFetcher();
  const since = new Date(HISTORY_START_DATE);
  const [qqq, tqqq] = await Promise.all([
    yahoo.fetchAdjDailyBars('QQQ', since),
    yahoo.fetchAdjDailyBars('TQQQ', since),
  ]);
  const qMap = new Map(qqq.map((b) => [b.date, b.adjClose]));
  const tMap = new Map(tqqq.map((b) => [b.date, b.adjClose]));

  // 对齐:spread ∩ QQQ ∩ TQQQ ∩ VXN(四者都有值的交易日)。
  const aligned = spreadRows.flatMap((r) => {
    const q = qMap.get(r.date);
    const t = tMap.get(r.date);
    const v = vxnMap.get(r.date);
    return q !== undefined && t !== undefined && v !== undefined
      ? [{ date: r.date, spread: r.spread, qqq: q, tqqq: t, vxn: v }]
      : [];
  });
  if (aligned.length < DEFAULT_SIGNAL.warmup + 30) {
    console.error(`对齐后仅 ${aligned.length} 天,不足。VX1/VX3 是否已 job:daily 抓取?`);
    process.exit(1);
  }
  const spread: SpreadPoint[] = aligned.map((a) => ({ date: a.date, value: a.spread }));
  const prices: AlignedRow[] = aligned.map((a) => ({ date: a.date, qqq: a.qqq, tqqq: a.tqqq }));

  const statesBy: Record<PanicEntry, DayState[]> =
    Object.fromEntries(VARIANTS.map((v) => [v, computeStates(spread, { ...DEFAULT_SIGNAL, panicEntry: v })])) as Record<PanicEntry, DayState[]>;

  // 组合:基准 / 仅现金(greed,与入场变体无关)/ 仅轮动 ×ABC / 两腿 ×ABC。
  const runs: Array<{ name: string; states: DayState[]; legs: EngineConfig['legs'] }> = [
    { name: 'QQQ benchmark', states: statesBy.C, legs: { rotation: false, cashInsurance: false } },
    { name: 'cash-only (greed)', states: statesBy.C, legs: { rotation: false, cashInsurance: true } },
    ...VARIANTS.map((v) => ({ name: `rot-only ${v}`, states: statesBy[v], legs: { rotation: true, cashInsurance: false } })),
    ...VARIANTS.map((v) => ({ name: `both ${v}`, states: statesBy[v], legs: { rotation: true, cashInsurance: true } })),
  ];
  const results = runs.map((r) => ({
    name: r.name,
    equity: runBacktest(r.states, prices, { ...ENGINE, legs: r.legs }),
  }));

  // put 保险腿:叠加在 base 净值路径上(贪婪期 base 必是 100% QQQ)。
  // put-only 的 base = 纯 QQQ 基准;both A+put 的 base = 仅轮动 A。
  const putDays: PutDay[] = aligned.map((a, i) => ({ date: a.date, qqq: a.qqq, vxn: a.vxn, greed: statesBy.C[i].greed }));
  const benchEq = results[0].equity;                                   // QQQ benchmark
  const rotAEq = results.find((r) => r.name === 'rot-only A')!.equity;  // 仅轮动 A
  results.push(
    { name: 'put-only (greed)', equity: overlayPut(benchEq, putDays, PUT) },
    { name: 'both A + put', equity: overlayPut(rotAEq, putDays, PUT) },
  );

  // ── 打印 ──
  const spreadPos = spread.filter((p) => p.value > 0).length;
  console.log(`窗口 ${prices[0].date} → ${prices[prices.length - 1].date}  ·  ${prices.length} 交易日  ·  spread>0: ${spreadPos} 天`);
  console.log(`panic episodes  A=${episodes(statesBy.A, 'panic').episodes}  B=${episodes(statesBy.B, 'panic').episodes}  C=${episodes(statesBy.C, 'panic').episodes}` +
    `  ·  greed episodes=${episodes(statesBy.C, 'greed').episodes}(days=${episodes(statesBy.C, 'greed').days})`);
  console.log();
  console.log([pad('策略', 20), pad('CAGR', 9), pad('MDD', 9), pad('Sharpe', 8), pad('Sortino', 8), 'Calmar'].join(''));
  for (const r of results) {
    const m = metrics(r.equity);
    console.log([pad(r.name, 20), pad(pct(m.cagr), 9), pad(pct(m.mdd), 9), pad(m.sharpe.toFixed(2), 8), pad(m.sortino.toFixed(2), 8), m.calmar.toFixed(2)].join(''));
  }
}

main();
