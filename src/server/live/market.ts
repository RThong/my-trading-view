// 原先由 daily / cryptoDaily 落库(price_eod / market_series)、但源头随时能重拉全段的行情,改为读时现拉。
// 2026-11-17 换之前逐日对账:ETF 8 只 + BTC 的开高低收、VIX、CBOE 8 条、DVOL、BRK 3 条,重叠期每一天都与库里逐位相等。
// 库里的旧行没删,只是不再读写(ROADMAP「能现拉的落库源换成现拉」)。
//
// 缓存(不用 swrCache 的「先回旧值、后台刷新」:调用方有 regime 的 6h 缓存和 CLI 脚本,拿到旧值会被锁住或算错):
//  · 新鲜(1h 内)→ 直接回;过期 / 进程刚起 → **等这次重拉**。
//  · 重拉失败,或结果比上一份短(首日变晚 / 末日变早 = 源截短)→ 回上一份并标 stale,10 分钟后再试。
//    上一份可以来自盘上快照(data/cache/live/),所以源头挂着时重启也有数。真冷(盘上也没有)才抛错。
import { readFileSync, mkdirSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createYahooFetcher } from '../fetchers/yahoo';
import { fetchCboeIndexAsQuotes } from '../fetchers/cboeIndex';
import { fetchBitstampBtcDaily, type Bar } from '../fetchers/bitstampBtcHistory';
import { fetchDvolHistory } from '../fetchers/deribitDvol';
import { fetchBtcValuation, fetchSupplyDensitySeries, type BtcValuation } from '../fetchers/brkSupplyDensity';
import { PRICE_HISTORY_START_DATE, PROJECT_ROOT } from '../config';
import { lastClosedTradingDate } from '../analytics/tradingCalendar';

type Point = { date: string; value: number };
/** stale = 这次没拉到新的(或新的被判截短),回的是上一份。 */
export type Live<T> = { value: T; stale: boolean };

const TTL_MS = 60 * 60 * 1000;
const RETRY_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const CACHE_DIR = resolve(PROJECT_ROOT, 'data', 'cache', 'live');

/** fetchedAt = 这份数据实际抓到的时刻;checkedAt = 上次尝试刷新的时刻(决定何时再拉)。 */
type Entry = { value: unknown; fetchedAt: number; checkedAt: number; stale: boolean };
const mem = new Map<string, Entry>();
const inflight = new Map<string, Promise<Entry>>();

function snapshotPath(key: string) {
  return resolve(CACHE_DIR, `${key}.json.gz`);
}

// 盘上快照读回一律当过期(checkedAt = −∞):照样能兜底,但先试一次重拉
function readSnapshot(key: string): Entry | undefined {
  try {
    const snap = JSON.parse(new TextDecoder().decode(Bun.gunzipSync(readFileSync(snapshotPath(key)))));
    return { value: snap.value, fetchedAt: snap.at, checkedAt: Number.NEGATIVE_INFINITY, stale: false };
  } catch {
    return undefined;
  }
}

// 先写临时文件再 rename(原子):写到一半进程被 --watch 重启也不会留下截断的 gz。写盘失败只告警
function writeSnapshot(key: string, entry: Entry): void {
  const path = snapshotPath(key);
  const tmp = `${path}.tmp`;
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    Bun.write(tmp, Bun.gzipSync(JSON.stringify({ at: entry.fetchedAt, value: entry.value })))
      .then(() => rename(tmp, path))
      .catch((e: Error) => console.warn(`[live] 快照写盘失败 ${path}: ${e.message}`));
  } catch (e) {
    console.warn(`[live] 快照写盘失败 ${path}: ${(e as Error).message}`);
  }
}

type Dated = { date: string }[];

/** 截短:首日比上一份晚(源只回了最近几年)/ 末日比上一份早(尾巴被截)/ 变空。多条序列任一条缩了就算。 */
export function shrunk(next: Dated[], prev: Dated[]): { head: boolean; tail: boolean } {
  const pairs = next.map((s, i) => [s, prev[i] ?? []] as const).filter(([, p]) => p.length);

  return {
    head: pairs.some(([s, p]) => !s.length || s[0].date > p[0].date),
    tail: pairs.some(([s, p]) => s.length > 0 && s.at(-1)!.date < p.at(-1)!.date),
  };
}

async function refresh<T>(
  key: string,
  load: () => Promise<T>,
  series: (v: T) => { date: string }[][],
  prev: Entry | undefined,
): Promise<Entry> {
  const now = Date.now();
  try {
    const value = await load();
    const cut = prev ? shrunk(series(value), series(prev.value as T)) : { head: false, tail: false };
    // 首日变晚永远拒收:照收的话历史会悄悄没掉,哪里都不报
    if (cut.head) throw new Error('结果首日比上一份晚(源只回了一段?)');
    // 末日变早只在上一份不到 1 天时拒收 —— 上一份若本身带了个后来被源撤掉的日期,不设上限会永远卡在旧值上;
    // 过了 1 天宁可照收(告警一行),最新日期变旧由数据健康页报出来
    if (cut.tail && now - prev!.fetchedAt < DAY_MS) throw new Error('结果末日比上一份早(源截短?)');
    if (cut.tail) console.warn(`[live] ${key} 末日比上一份早,上一份已超过 1 天,照收`);
    const entry = { value, fetchedAt: now, checkedAt: now, stale: false };
    mem.set(key, entry);
    writeSnapshot(key, entry);
    return entry;
  } catch (e) {
    if (!prev) throw e;
    console.warn(`[live] ${key} 刷新失败,沿用上一份: ${(e as Error).message}`);
    // 把「上次尝试」往前挪,让它 RETRY_MS 后就再试,而不是粘满一个 TTL
    const entry = { ...prev, checkedAt: now - TTL_MS + RETRY_MS, stale: true };
    mem.set(key, entry);
    return entry;
  }
}

/**
 * 取数选项。fresh:不认 1h 内的缓存、这次一定重拉(并发仍合并)—— regime 用:它自己缓存 6h,
 * 且 VIX 要和每次现拉的 VIX3M 同频,否则内连接会丢掉当天那根。
 */
export type LiveOpts = { fresh?: boolean };

/** series:把值拆成若干条按日期升序的序列,用来判截短。并发请求合并成一次。 */
function cached<T>(
  key: string,
  load: () => Promise<T>,
  series: (v: T) => Dated[],
  opts: LiveOpts = {},
): Promise<Entry> {
  const prev = mem.get(key) ?? readSnapshot(key);
  if (prev && !opts.fresh && Date.now() - prev.checkedAt < TTL_MS) return Promise.resolve(prev);

  const running = inflight.get(key) ?? refresh(key, load, series, prev).finally(() => inflight.delete(key));
  inflight.set(key, running);
  return running;
}

function one<P extends { date: string }>(v: P[]) {
  return [v];
}
function live<T>(e: Entry): Live<T> {
  return { value: e.value as T, stale: e.stale };
}

/** BTC 起点早于全站 HISTORY_START_DATE:1Y 滚动夏普要看 2013 / 2017 两轮顶部是否递减。 */
const BTC_START = '2012-01-01';
// DVOL 指数 2021-03-24 上线(Deribit 那天起才有点)
const DVOL_START = '2021-03-24';
// CBOE 指数读时现拉、每次都下整份 CSV,所以源头有多早就从多早(截到 2018 只是丢掉已到手的数据);
// 报警分位不受影响:规则的 since 缺省锁在 2018(见 shared/alertRules 的 pctl)。
// 例外:VVIX 2006 年大半年稀疏(每月 3~8 个点、隔 1~3 周),从 2007 起
const CBOE_START: Record<string, string> = { VVIX: '2007-01-01' };
export function cboeStart(sym: string): string {
  return CBOE_START[sym] ?? '1900-01-01';
}
// 源里已知、补不回来的断档(断档前后两天,精确匹配):SKEW 2000-09-20 ~ 09-29 缺 8 个交易日
const CBOE_KNOWN_GAPS: Record<string, [string, string][]> = { SKEW: [['2000-09-19', '2000-10-02']] };

function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * 按交易日的序列(ETF / CBOE)只做宽松的断档检查:相邻两点隔超过 7 天就抛(9·11 休市那次正好 7 天)。
 * 节假日不规则,逐日核对交易日历不值得;7 天以上的洞只可能是源出了问题。knownGaps 放行源里本来就缺的那几段。
 */
export function checkedGaps<P extends { date: string }>(
  id: string,
  points: P[],
  knownGaps: [string, string][] = [],
): P[] {
  const known = (from: string, to: string) => knownGaps.some(([a, b]) => a === from && b === to);
  const gap = points.find((p, i) => {
    const prev = points[i - 1]?.date;

    return i > 0 && !known(prev, p.date) && Date.parse(p.date) - Date.parse(prev) > 7 * 86400_000;
  });
  if (!points.length || gap) throw new Error(`${id} 断档(${gap?.date ?? '0 个点'})`);

  return points;
}

/**
 * 要求从 start 那天开始逐日连续(7×24 的源):解析层会跳过 null,源回 200 + 空数组 / 中间断档时
 * 只能在这里发现。不满足就抛 —— 缓存沿用上一份完整结果。尾部截短由 cached 比上一份末日来挡。
 */
export function checkedDaily<P extends { date: string }>(id: string, points: P[], start: string): P[] {
  const kept = points.filter((p) => p.date >= start);
  const gap = kept.find(
    (p, i) => Date.parse(p.date) - Date.parse(i ? kept[i - 1].date : start) !== (i ? 86400_000 : 0),
  );
  if (!kept.length || gap) throw new Error(`${id}:${start} 起不完整(${gap?.date ?? '0 个点'})`);

  return kept;
}

/**
 * BTC 现货日 K:全段 Bitstamp(现货、原生 UTC 0 点切日、2012 起零缺口;别换 Deribit,它 08:00 UTC 切)。含当天盘中那根。
 * 不设降级:Yahoo BTC-USD 只到 2014-09、口径也不同,整段换掉会丢早年历史;挂了就沿用上一份。
 */
async function loadBtc(): Promise<Bar[]> {
  return checkedDaily('Bitstamp BTC', await fetchBitstampBtcDaily(BTC_START, utcDate(Date.now())), BTC_START);
}

/**
 * ETF:Yahoo close = 只调拆股、不调分红(同 TradingView 默认 / IBKR TRADES),一次请求即上市日起全段;
 * 盘中那根是半截价,截到上一收盘日。
 */
async function loadEtf(u: string): Promise<Bar[]> {
  const lastClosed = lastClosedTradingDate();
  const rows = await createYahooFetcher().fetchDailyBars(u, new Date(`${PRICE_HISTORY_START_DATE}T00:00:00Z`));
  const bars = rows
    .map((r) => ({ date: r.tradeDate, open: r.open, high: r.high, low: r.low, close: r.close }))
    .filter((b) => b.date <= lastClosed);

  return checkedGaps(`Yahoo ${u}`, bars);
}

async function loadCboe(sym: string): Promise<Bar[]> {
  const rows = await fetchCboeIndexAsQuotes({ cboeSymbol: sym, storedSymbol: sym, startDate: cboeStart(sym) });
  const bars = rows.map((r) => ({ date: r.tradeDate, open: r.open, high: r.high, low: r.low, close: r.close }));

  return checkedGaps(`CBOE ${sym}`, bars, CBOE_KNOWN_GAPS[sym]);
}

const SPOT_LOADER: Record<string, () => Promise<Bar[]>> = {
  BTC: loadBtc,
  VIX: () => loadCboe('VIX'),
};

function spotEntry(u: string, opts?: LiveOpts): Promise<Entry> {
  return cached(`spot-${u}`, SPOT_LOADER[u] ?? (() => loadEtf(u)), one<Bar>, opts);
}

/** 标的现货日 K(升序)。BTC 含当天盘中那根(看盘要),其余只到已收盘。 */
export async function spotBars(u: string, opts?: LiveOpts): Promise<Live<Bar[]>> {
  return live(await spotEntry(u, opts));
}

/**
 * 只含已收盘的日 K:算 RV / 夏普 / 交易日用。去掉日期 ≥ **抓取时刻** UTC 日期的那几根,与原先读库的
 * `fetched_at >= obs_date + 1 天` 同一口径:BTC 当天那根只有几小时的波动,混进去短窗 RV 系统性偏低
 * (2026-10-21 实测 RV7 12.7 vs 19.0);ETF 收盘后同一 UTC 日内抓到的那根,也要到下一 UTC 日才算进来。
 * 按抓取时刻不按调用时刻:23:30 抓的那根过了 0 点仍是半截。
 */
export async function closedBars(u: string, opts?: LiveOpts): Promise<Live<Bar[]>> {
  const e = await spotEntry(u, opts);
  const fetchedDay = utcDate(e.fetchedAt);

  return { value: (e.value as Bar[]).filter((b) => b.date < fetchedDay), stale: e.stale };
}

/** CBOE 波动率指数(VIX 家族 / VVIX / SKEW …)与 Deribit DVOL 的收盘序列。 */
export async function volIndex(sym: string, opts?: LiveOpts): Promise<Live<Point[]>> {
  const toClose = (r: Live<Bar[]>) => ({ ...r, value: r.value.map((b) => ({ date: b.date, value: b.close })) });
  // VIX 与现货蜡烛同一个 CSV,共用一份缓存
  if (sym === 'VIX') return toClose(await spotBars('VIX', opts));
  if (sym === 'DVOL') {
    const load = async () =>
      checkedDaily('DVOL', await fetchDvolHistory('BTC', Date.parse(DVOL_START), Date.now()), DVOL_START);
    return live(await cached('vol-DVOL', load, one<Point>, opts));
  }

  return toClose(live(await cached(`vol-${sym}`, () => loadCboe(sym), one<Bar>, opts)));
}

/** BTC ±5% 已实现供应密度原始日值(BRK,2012 起)。当天 UTC 那点是盘中值。 */
export async function btcSupplyDensity(opts?: LiveOpts): Promise<Live<Point[]>> {
  const load = async () => checkedDaily('BRK 供应密度', await fetchSupplyDensitySeries(), BTC_START);
  return live(await cached('brk-density', load, one<Point>, opts));
}

/** BTC 链上估值 MVRV / AVIV(BRK 现成比值,2012 起逐日连续)。 */
export async function btcValuation(opts?: LiveOpts): Promise<Live<BtcValuation>> {
  const load = async () => {
    const { mvrv, aviv } = await fetchBtcValuation();
    return { mvrv: checkedDaily('BRK MVRV', mvrv, BTC_START), aviv: checkedDaily('BRK AVIV', aviv, BTC_START) };
  };
  return live(await cached('brk-valuation', load, (v: BtcValuation) => [v.mvrv, v.aviv], opts));
}
