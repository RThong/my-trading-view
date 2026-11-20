/**
 * SPX 30 天恒定期限 25Δ IV,取自 Cboe 官网「VIX Decomposition」工具页背后的接口(无文档、免 key):
 * `www-api.cboe.com/vix_decomposition/?date1=YYYY-MM-DD&date2=YYYY-MM-DD`
 *
 * 返回两天各自的 SPX IV 曲线 `interpolatedIVs[日期][到期对].ivs[行权价] = { iv, delta }`:
 * 跨两个到期日按「方差 × 天数」插到 30 天(刚好 30 天时只有一个到期日),约 550 个行权价;
 * 平值以下是 put delta(负),以上是 call delta(正)。另带 VIX 日变化的六个分解因子,不取。
 *
 * 实测(2026-11-20):
 * - 某天的曲线与配对的另一天无关(11-18 配 11-17 或 10-01,25Δ 两点逐位相同);但两天平值差太远会报
 *   「Insufficient data … strike range」(2023-03-01 配 2026-11-18),所以总配相邻交易日。
 * - 两天都得是交易日(否则 400「One or both dates are not trading days.」),同一天配自己 400「Division by zero」。
 * - 2022-09 前回 400「No interest rate data found」;当天(美东日)的回 400「not yet available」,收盘后到次日凌晨某时才有。
 * - www-api 域名不受 2026-11-19 起 Cloudflare 拦 delayed_quotes 的影响(不带 Referer 也是 200)。
 * - wnsdudkk-ux/cboe_data 用自存的 SPX 收盘链独立复算,82 个日期对平值 ±10% 内曲线平均只差 0.015pp。
 */
import { fetchWithTimeout } from './http';

/** 源头最早能取的一天(2022-07 还报缺利率数据;2022-09-01 实测可取) */
export const SPX_DECOMP_MIN_DATE = '2022-09-01';

/** 百分数(24.15 = 24.15%),与期权 25Δ 表同单位;skew = put − call,百分点 */
export type Spx25 = { putIv: number; callIv: number; skew: number };

/** 源明确说「这一对里有非交易日」:调用方据此认定新的那天是假日 */
export class NotTradingDayError extends Error {}

const URL_BASE = 'https://www-api.cboe.com/vix_decomposition/';
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; my-trading-view/0.1)' };
// 两侧 25Δ 附近至少要有点:离 0.25 超过这么多就当曲线残缺,宁可报错也不拿 10Δ 冒充 25Δ
const MAX_DELTA_MISS = 0.03;

type Curve = Record<string, { iv: number; delta: number }>;
type Body = { interpolatedIVs?: Record<string, Record<string, { ivs?: Curve }>>; error?: string };

/** 一天的曲线 → 25Δ 两点。取 delta 最近的行权价:行权价间隔 5 点、delta 步长约 0.002,插值省了也只差约 0.03pp */
export function pick25Delta(curve: Curve, date: string): Spx25 {
  const pts = Object.values(curve);
  const nearest = (target: number) =>
    pts
      .filter((p) => Math.sign(p.delta) === Math.sign(target) && p.iv > 0)
      .reduce<(typeof pts)[number] | null>(
        (best, p) => (!best || Math.abs(p.delta - target) < Math.abs(best.delta - target) ? p : best),
        null,
      );
  const put = nearest(-0.25);
  const call = nearest(0.25);
  if (!put || !call || Math.abs(put.delta + 0.25) > MAX_DELTA_MISS || Math.abs(call.delta - 0.25) > MAX_DELTA_MISS)
    throw new Error(`Cboe VIX 分解 ${date}:曲线两侧缺 25Δ 附近的点(结构可能变了)`);

  const putIv = put.iv * 100;
  const callIv = call.iv * 100;
  return { putIv, callIv, skew: putIv - callIv };
}

/**
 * 解析响应 → 日期 → 25Δ。「还没发布 / 早于源头」这两种已知的「没数据」回空表;
 * 非交易日抛 NotTradingDayError;其它错误照抛(别把改版当成没数据默默跳过)。
 */
export function parseDecomp(body: Body, dates: string[]): Map<string, Spx25> {
  const err = body.error ?? '';
  if (/not yet available|No interest rate data/.test(err)) return new Map();
  if (/not trading days/.test(err)) throw new NotTradingDayError(err);
  if (err) throw new Error(`Cboe VIX 分解 ${dates.join(' ~ ')}:${err}`);

  return new Map(
    dates.map((d) => {
      // 每天只有一个到期对(两个到期日插值,或刚好 30 天的单个到期日)
      const curve = Object.values(body.interpolatedIVs?.[d] ?? {})[0]?.ivs;
      if (!curve) throw new Error(`Cboe VIX 分解 ${d}:响应里没有这天的曲线(结构可能变了)`);
      return [d, pick25Delta(curve, d)];
    }),
  );
}

/** 拉一对相邻交易日(date1 < date2),返回两天各自的 25Δ;没数据回空表 */
export async function fetchSpx25Pair(date1: string, date2: string): Promise<Map<string, Spx25>> {
  const res = await fetchWithTimeout(`${URL_BASE}?date1=${date1}&date2=${date2}`, { headers: HEADERS }, 60_000);
  // 已知的「没数据 / 非交易日」是 400 + JSON 的 error,要读 body 才分得出;别的状态码直接报
  if (!res.ok && res.status !== 400) throw new Error(`Cboe VIX 分解 ${date1} ~ ${date2} HTTP ${res.status}`);
  return parseDecomp((await res.json()) as Body, [date1, date2]);
}
