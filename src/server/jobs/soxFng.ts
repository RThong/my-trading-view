/**
 * 半导体风险情绪温度计(SOX Fear & Greed):CNN 恐贪法移植到半导体板块。粗略情绪读数,非精确心理测量。
 * 锚 = SOXX;6 个子指标各归一 0-100 等权平均(①②③⑤⑥ 用 Yahoo 复权日线,④ 用 OpenD 期权):
 *   ① 动量    SOXX close / SMA125 - 1
 *   ② 新高低  25 成分股 52 周新高数 - 新低数,占有效数比例
 *   ③ breadth 成分股涨跌成交量净额占比
 *   ④ put/call SOXX ~30DTE 期权 put量/call量(OpenD 每天记,updateSoxPutcall)
 *   ⑤ 波动    SOXX 20 日已实现波动(年化),invert(高波动=恐慌)
 *   ⑥ 避险    SOXX 20 日收益 - IEF 20 日收益
 *
 * 归一:①②③⑤⑥ raw 对**滚动 252 日窗口**取 mid-rank 百分位 → 0-100(有界窗口非扩张,
 * 否则牛市动量钉死 99);④ 用绝对映射(见 putcallScore)。某日某腿缺数据即不计入当日复合。
 *
 * 全量重算 upsert:日频、~27 个 Yahoo 标的 + 读库里的 put/call,几秒,不值得搞增量。幂等可重复跑。
 * ponytail: 25 成分名单硬编码,一年 9 月重构才变;届时手动下 iShares CSV 覆盖即可,不养爬虫。
 */
import type { Database } from 'bun:sqlite';
import { openDb, migrate } from '../storage/db';
import { insertMarketSeries, getMarketSeries } from '../storage/repository';
import { createYahooFetcher } from '../fetchers/yahoo';
import type { OptionsChainClient } from './optionsSnapshot';
import { lastClosedTradingDate } from './tradingCalendar';
import { defaultMoomooOptionsClient } from '../fetchers/moomooOptions';

// SOXX 前 25 成分(占权重 ~96.5%;尾巴 ~5 只 <1% 暂略,补齐见上方 ponytail)。
export const SOX_CONSTITUENTS = [
  'AMD',
  'MU',
  'NVDA',
  'AVGO',
  'INTC',
  'AMAT',
  'KLAC',
  'MRVL',
  'LRCX',
  'TSM',
  'TXN',
  'ADI',
  'NXPI',
  'MPWR',
  'QCOM',
  'ALAB',
  'TER',
  'MCHP',
  'ASML',
  'CRDO',
  'ON',
  'ASX',
  'ENTG',
  'MTSI',
  'UMC',
];
export const SOX_ANCHOR = 'SOXX';
export const SOX_BOND = 'IEF';
const HISTORY_START = '2022-01-01'; // 给滚动窗口留历史(含 2024 IPO 的 ALAB,按可用日子算)

// market_series 序列 id:复合 + 6 子指标(0-100 归一分,徽标/复合用)。
export const SOX_FNG_SERIES = {
  index: 'SOX_FNG',
  mom: 'SOX_FNG_MOM',
  hl: 'SOX_FNG_HL',
  breadth: 'SOX_FNG_BREADTH',
  vol: 'SOX_FNG_VOL',
  safe: 'SOX_FNG_SAFE',
  putcall: 'SOX_FNG_PUTCALL',
} as const;

// 各子指标的 raw 原生值(比率/波动率,前端画原生单位图)。复合无 raw。
// putcall raw 由 updateSoxPutcall 每天记(OpenD 实时,无历史),是源头;computeSoxFng 读它当输入,不重算。
export const SOX_FNG_RAW_SERIES = {
  mom: 'SOX_FNG_MOM_RAW',
  hl: 'SOX_FNG_HL_RAW',
  breadth: 'SOX_FNG_BREADTH_RAW',
  vol: 'SOX_FNG_VOL_RAW',
  safe: 'SOX_FNG_SAFE_RAW',
  putcall: 'SOX_FNG_PUTCALL_RAW',
} as const;

// 动量图专用:SOXX 复权价 + 125 日均线两条线(CNN 式,直观看价穿线上/下)。
// 动量的 raw 仍是偏离比率(打分/百分位用),这两条只供画图。
export const SOX_FNG_MOM_LINES = {
  price: 'SOX_FNG_MOM_PRICE',
  ma: 'SOX_FNG_MOM_MA',
} as const;

// ── 计算参数 ──
const MOM_WINDOW = 125; // 动量均线
const VOL_WINDOW = 20; // 已实现波动 / 避险回看
const HL_WINDOW = 252; // 52 周新高低
const PCT_WINDOW = 252; // 归一滚动窗口
const PCT_SEED = 60; // 攒够这么多 raw 才出分,免小样本噪声
const MIN_ELIGIBLE = 15; // 至少这么多有效成分才算 ②③
const MIN_SUBS = 3; // 至少这么多子指标才合成复合

// ④ put/call 用绝对映射(非百分位):它有天然锚点 1.0(>1 看跌,<1 看涨),不必跟自身历史比,
// 故从首日即可计入复合,无需播种。1.0→50 中性,越高越恐(0),越低越贪(100)。
// ponytail: PC_HALF 是校准旋钮 —— SOXX 单 ETF 的中性 put/call 水平未知(可能偏高),
// 攒几个月看到分布后再调这个半幅。
const PC_NEUTRAL = 1.0;
const PC_HALF = 0.6; // 偏离中性 ±0.6 时打到 100/0
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
export const putcallScore = (r: number) => clamp(50 - ((r - PC_NEUTRAL) / PC_HALF) * 50, 0, 100);

export type Bar = { date: string; close: number; volume: number | null };
export type PutcallPoint = { date: string; value: number }; // SOXX put/call 量比(外部记录,非 Yahoo 派生)
export type FngInput = { anchor: Bar[]; bond: Bar[]; constituents: Bar[][]; putcall?: PutcallPoint[] }; // 各自按日期升序
type Sub = 'mom' | 'hl' | 'breadth' | 'vol' | 'safe' | 'putcall';
export type FngRow = {
  date: string;
  index: number;
  parts: Partial<Record<Sub, number>>; // 0-100 归一分
  raw: Partial<Record<Sub, number>>; // 原生值(比率/波动率)
};

// ── 纯函数小工具 ──
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const std = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};
/** v 在 hist 末尾 PCT_WINDOW 个值里的 mid-rank 百分位 × 100。
 *  用 (小于数 + 0.5×相等数)/N,避免离散序列(如新高低常年 =0)的并列被全推到区间上端。 */
function rollingPct(hist: number[], v: number): number {
  const win = hist.slice(-PCT_WINDOW);
  let lt = 0;
  let eq = 0;
  for (const h of win) {
    if (h < v) lt++;
    else if (h === v) eq++;
  }
  return ((lt + 0.5 * eq) / win.length) * 100;
}
/** date → 该股在自身序列里的下标,O(1) 查窗口。 */
function indexBy(bars: Bar[]): Map<string, number> {
  return new Map(bars.map((b, i) => [b.date, i]));
}

/**
 * 纯计算:输入各标的日线,输出每日复合指数 + 子分数(0-100)。无 I/O,可单测。
 */
export function computeSoxFng(input: FngInput): FngRow[] {
  const { anchor, bond } = input;
  const close = anchor.map((b) => b.close);
  const bondClose = new Map(bond.map((b) => [b.date, b.close]));
  const putcallByDate = new Map((input.putcall ?? []).map((p) => [p.date, p.value]));

  // 预处理成分股:各自 date→idx + 数组,避免每日重复排序/查找。
  const cons = input.constituents.map((bars) => ({ bars, idx: indexBy(bars) }));

  // ── 每日 raw ──
  type Raw = { date: string } & Partial<Record<Sub, number>>;
  const raws: Raw[] = anchor.map((b, i): Raw => {
    const r: Raw = { date: b.date };

    // 125 日 SMA 含当日(标准口径:最近 125 个交易日,含今天)。
    if (i >= MOM_WINDOW - 1) r.mom = close[i] / mean(close.slice(i - MOM_WINDOW + 1, i + 1)) - 1;

    if (i >= VOL_WINDOW) {
      const rets = Array.from({ length: VOL_WINDOW }, (_, k) =>
        Math.log(close[i - VOL_WINDOW + 1 + k] / close[i - VOL_WINDOW + k]),
      );
      r.vol = std(rets) * Math.sqrt(252);

      const bNow = bondClose.get(b.date);
      const bPast = bondClose.get(anchor[i - VOL_WINDOW].date);
      if (bNow != null && bPast != null) {
        r.safe = close[i] / close[i - VOL_WINDOW] - 1 - (bNow / bPast - 1);
      }
    }

    // ②③ 遍历成分股
    let nHigh = 0,
      nLow = 0,
      nEligible = 0;
    let upVol = 0,
      downVol = 0,
      totVol = 0,
      nBreadth = 0;
    for (const { bars, idx } of cons) {
      const j = idx.get(b.date);
      if (j == null) continue; // 当日未在市(如 IPO 前)

      if (j >= HL_WINDOW - 1) {
        const win = bars.slice(j - HL_WINDOW + 1, j + 1).map((x) => x.close);
        const cur = bars[j].close;
        if (cur >= Math.max(...win)) nHigh++;
        else if (cur <= Math.min(...win)) nLow++;
        nEligible++;
      }
      // 量广度:需昨日 + 有成交量。无量的股不计入(否则占了有效票却贡献 0 量,虚高 nBreadth)。
      // 平盘(close == 昨收)不算涨也不算跌,同样排除(否则被误记成跌量)。
      const v = j >= 1 ? bars[j].volume : null;
      if (v != null) {
        if (bars[j].close > bars[j - 1].close) {
          upVol += v;
          totVol += v;
          nBreadth++;
        } else if (bars[j].close < bars[j - 1].close) {
          downVol += v;
          totVol += v;
          nBreadth++;
        }
      }
    }
    if (nEligible >= MIN_ELIGIBLE) r.hl = (nHigh - nLow) / nEligible;
    if (nBreadth >= MIN_ELIGIBLE && totVol > 0) r.breadth = (upVol - downVol) / totVol;

    // ④ put/call:外部记录的 SOXX 量比(高=看跌情绪=恐慌,归一时反向)。
    const pc = putcallByDate.get(b.date);
    if (pc != null) r.putcall = pc;

    return r;
  });

  // ── 归一 → 0-100(vol invert),等权合成 ──
  const SUBS: Sub[] = ['mom', 'hl', 'breadth', 'vol', 'safe', 'putcall'];
  const INVERT = new Set<Sub>(['vol']); // 高波动 = 恐慌 → 翻转(putcall 的反向已烘进 putcallScore)
  const hist: Record<Sub, number[]> = { mom: [], hl: [], breadth: [], vol: [], safe: [], putcall: [] };

  const out: FngRow[] = [];
  for (const r of raws) {
    const parts: Partial<Record<Sub, number>> = {};
    const raw: Partial<Record<Sub, number>> = {};
    for (const k of SUBS) {
      const v = r[k];
      if (v == null) continue;
      raw[k] = v; // 原生值(未归一,vol 未反向),前端画原生单位

      // ④ put/call:绝对映射,首日即出分,不走百分位/播种。
      if (k === 'putcall') {
        parts[k] = putcallScore(v);
        continue;
      }

      hist[k].push(v);
      if (hist[k].length < PCT_SEED) continue;
      const s = rollingPct(hist[k], v);
      parts[k] = INVERT.has(k) ? 100 - s : s;
    }
    const vals = Object.values(parts) as number[];
    if (vals.length >= MIN_SUBS) out.push({ date: r.date, index: mean(vals), parts, raw });
  }
  return out;
}

// ── I/O 壳:拉 Yahoo → 计算 → 写 market_series ──
export async function updateSoxFng(db: Database): Promise<{ total: number; succeeded: number; failures: string[] }> {
  const yf = createYahooFetcher();
  const since = new Date(HISTORY_START);
  // 复权收盘(收益/波动/新高低都用复权,避免分红拆股机械跳变;IEF 月月分红尤甚)+ 保留 volume 给广度。
  const load = (sym: string): Promise<Bar[]> => yf.fetchAdjBarsWithVolume(sym, since);

  try {
    const anchor = await load(SOX_ANCHOR);
    const bond = await load(SOX_BOND);

    // 成分股逐只容错:某只退市/改代码/拉取失败,只跳过它(log),不掀翻整个 job。
    // 名单漂了优雅降级——少一只成分 breadth 少一票;若跌破 MIN_ELIGIBLE,②③ 当日自动缺席、复合用其余腿。
    const settled = await Promise.all(
      SOX_CONSTITUENTS.map(async (s): Promise<{ s: string; bars: Bar[] | null }> => {
        try {
          return { s, bars: await load(s) };
        } catch {
          return { s, bars: null };
        }
      }),
    );
    const constituents = settled.filter((r) => r.bars?.length).map((r) => r.bars as Bar[]);
    const dropped = settled.filter((r) => !r.bars?.length).map((r) => r.s);
    if (dropped.length) console.warn(`[soxFng] 跳过 ${dropped.length} 只成分(拉取失败或空): ${dropped.join(', ')}`);
    // ④ put/call raw 由 updateSoxPutcall 每天记(此处只读,不重算);无数据则 ④ 缺席,其它 5 指标照常。
    const putcall = getMarketSeries(db, SOX_FNG_RAW_SERIES.putcall).map((r) => ({ date: r.date, value: r.value }));

    const rows = computeSoxFng({ anchor, bond, constituents, putcall });

    // 复合 + 各子指标归一分 + raw,铺平成 market_series 行(putcall raw 写回同值,幂等)。
    const seriesRows = rows.flatMap((r) => [
      { seriesId: SOX_FNG_SERIES.index, obsDate: r.date, value: r.index },
      ...(Object.entries(r.parts) as [Sub, number][]).map(([k, v]) => ({
        seriesId: SOX_FNG_SERIES[k],
        obsDate: r.date,
        value: v,
      })),
      ...(Object.entries(r.raw) as [Sub, number][]).map(([k, v]) => ({
        seriesId: SOX_FNG_RAW_SERIES[k],
        obsDate: r.date,
        value: v,
      })),
    ]);

    // 动量双线:SOXX 复权价 + 125 日均线(MA 与打分口径一致:含当日的最近 125 日收盘均值)。
    const closeArr = anchor.map((b) => b.close);
    const momLineRows = anchor.flatMap((b, i) =>
      i >= MOM_WINDOW - 1
        ? [
            { seriesId: SOX_FNG_MOM_LINES.price, obsDate: b.date, value: closeArr[i] },
            { seriesId: SOX_FNG_MOM_LINES.ma, obsDate: b.date, value: mean(closeArr.slice(i - MOM_WINDOW + 1, i + 1)) },
          ]
        : [],
    );

    insertMarketSeries(db, [...seriesRows, ...momLineRows]);
    return { total: seriesRows.length, succeeded: 1, failures: [] };
  } catch (err) {
    return { total: 0, succeeded: 0, failures: [`sox_fng: ${(err as Error).message}`] };
  }
}

// ── ④ put/call 记录器:每天从 OpenD 拉 SOXX 期权,记当日 put/call 量比 ──
// OpenD 只给实时、无历史 → 必须每天记一次积累。取 ~30 DTE 那个到期日的总量比(全到期日更全但多几次请求)。
// ponytail: 单到期日 + 成交量比(非 5 日均、非 OI);够用,需要更平滑再上 5 日 MA。
export async function updateSoxPutcall(
  db: Database,
  client: OptionsChainClient,
): Promise<{ total: number; succeeded: number; failures: string[] }> {
  try {
    const chain = await client.fetchChain('SOXX', 30);
    const sumVol = (cs: { volume: number | null }[]) => cs.reduce((a, c) => a + (c.volume ?? 0), 0);
    const callVol = sumVol(chain.calls);
    const putVol = sumVol(chain.puts);
    if (callVol <= 0) throw new Error('SOXX call 成交量为 0,无法算 put/call');

    // 打戳失败也回退本地交易日,别丢掉已抓到的 put/call(不可回填)。对齐 optionsSnapshot 的处理。
    let obsDate: string;
    try {
      obsDate = (await client.getTradingDate?.()) ?? lastClosedTradingDate();
    } catch {
      obsDate = lastClosedTradingDate();
    }
    insertMarketSeries(db, [{ seriesId: SOX_FNG_RAW_SERIES.putcall, obsDate, value: putVol / callVol }]);
    return { total: 1, succeeded: 1, failures: [] };
  } catch (err) {
    return { total: 0, succeeded: 0, failures: [`sox_putcall: ${(err as Error).message}`] };
  }
}

if (import.meta.main) {
  const db = openDb();
  migrate(db);
  // 先记当日 put/call(需 OpenD),再重算指数(读到最新 put/call)。
  const pc = await updateSoxPutcall(db, defaultMoomooOptionsClient());
  const { total, failures } = await updateSoxFng(db);
  db.close();
  console.log(
    `SOX F&G: ${total} rows${failures.length ? ` 失败: ${failures.join('; ')}` : ''}; ` +
      `put/call ${pc.succeeded ? '记录成功' : `失败: ${pc.failures.join('; ')}`}`,
  );
}
