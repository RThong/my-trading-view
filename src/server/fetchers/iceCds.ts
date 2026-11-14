import { fetchWithTimeout } from './http';
import { AI_CDS } from '../analytics/rateCurves';

// ICE Clear Credit 免费公开的单名 CDS 每日 EOD 结算价(margining 官方价)。无 auth。
// 只有当日一份快照(无历史)→ 靠每天跑一次积累时间序列。
// instrumentName 形如 ORCLE.SNRFOR.USD.XR14.100.2031-06-20 =
//   代码.高级无抵押.货币.约定.票息bp.到期(5Y IMM,每半年 roll,故不硬编到期)。
const URL = 'https://www.ice.com/api/cds-settlement-prices/icc-single-names';

type IceRow = { clearingDate: string; name: string; instrumentName: string; eodPrice: string | number };
export type CdsPoint = { ticker: string; price: number };
export type CdsSnapshot = { date: string; points: CdsPoint[] };

// 名单内 ticker → 要取的票息档(字符串,对齐 instrumentName 第 5 段)。不在 Map = 名单外。
const COUPON = new Map(AI_CDS.filter((c) => !c.jpy).map((c) => [c.ticker, String(c.coupon ?? 100)]));

// 每名取标准 5Y 基准合约:SNRFOR + USD + 该名配置的票息档(默认 100bp,高收益名 500bp)。同名若多档到期,取最长到期
// (= on-the-run 5Y,短档是历史残留)。maturity 为 YYYY-MM-DD,字典序即时间序。
export function parseIceCds(rows: IceRow[]): CdsSnapshot {
  const valid = rows.flatMap((r) => {
    const [ticker, tier, ccy, , coupon, maturity] = r.instrumentName.split('.');
    if (!COUPON.has(ticker) || coupon !== COUPON.get(ticker) || tier !== 'SNRFOR' || ccy !== 'USD') return [];

    // price<=0 一并挡:Number(null)/Number('') 都得 0,缺价的行会伪装成有效价(→ 约 2228bp 假数据)。
    const price = Number(r.eodPrice);
    if (!Number.isFinite(price) || price <= 0) return [];

    return [{ ticker, maturity, price, clearingDate: r.clearingDate }];
  });

  const best = valid.reduce((acc, v) => {
    const prev = acc.get(v.ticker);
    if (!prev || v.maturity > prev.maturity) acc.set(v.ticker, v);
    return acc;
  }, new Map<string, { maturity: string; price: number }>());

  return {
    date: valid.find((v) => v.clearingDate)?.clearingDate ?? '',
    points: [...best].map(([ticker, v]) => ({ ticker, price: v.price })),
  };
}

export async function fetchIceCds(doFetch = fetchWithTimeout): Promise<CdsSnapshot> {
  // ICE 边缘拦默认 UA,带个浏览器 UA 免 403。
  const res = await doFetch(URL, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`ICE CDS 下载失败:${res.status}`);

  const snap = parseIceCds((await res.json()) as IceRow[]);
  if (!snap.points.length) throw new Error('ICE CDS:名单无匹配合约(端点结构或名单可能变了)');
  return snap;
}

// 同门的指数端点:CDX / iTraxx 各系列结算价,同样只有当天快照。只取北美 IG / HY(欧洲那几条不在任何视角)。
// instrumentName 形如 CDX-NAIGS47V1-5Y = 指数.系列号.版本号-期限。IG 每年 3/20、9/20 出新系列(S47 → S48,HY 晚一周),
// 成分公司违约时版本号加一(V1 → V2);旧系列照样挂着结算价 → 取最高系列、同系列取最高版本的 5Y = 当前主力。
const INDEX_URL = 'https://www.ice.com/api/cds-settlement-prices/icc-indexes';
// 开始存 ICE CDX 的日子。端点只给当天快照,合法的清算日不可能早于它 —— 早于它的当异常丢掉:
// 回填把「ICE 第一天」当 DTCC 段的终点,一个过早的日期(如 0001-01-01)会让整条 DTCC 历史被删(见 dtccCdxSnapshot)
export const ICE_CDX_START = '2026-11-13';
const CDX_RE = /^CDX-NA(IG|HY)S(\d+)V(\d+)-5Y$/;

/** CDX 主力合约的结算价;ticker = 'CDX_IG' / 'CDX_HY'(IG 票息 100bp、HY 500bp,换算 bp 在读时做)。 */
export function parseIceCdx(rows: Omit<IceRow, 'name'>[]): CdsSnapshot {
  // 主力在**全部**匹配的行里定,价和日期都先不筛:最高系列那行缺价 / 缺日期 / 日期落后 → 这条记缺失
  // (job 判失败、当天重跑),而不是退回旧系列冒充主力
  const all = rows.flatMap((r) => {
    const m = CDX_RE.exec(r.instrumentName);
    // 系列 × 1000 + 版本:一个数比大小(版本号不会到 1000)
    return m ? [{ ticker: `CDX_${m[1]}`, rank: Number(m[2]) * 1000 + Number(m[3]), row: r }] : [];
  });
  const isDate = (d: string | undefined) => /^\d{4}-\d{2}-\d{2}$/.test(d ?? '') && d! >= ICE_CDX_START;
  // 快照日 = 最新的合法清算日;主力那行不是这天的(日期不齐)同样记缺失,不拿旧价标成新日期
  const date =
    all
      .map((a) => a.row.clearingDate)
      .filter(isDate)
      .sort()
      .at(-1) ?? '';

  return {
    date,
    points: [...Map.groupBy(all, (a) => a.ticker)].flatMap(([ticker, as]) => {
      const { row } = as.reduce((a, b) => (b.rank > a.rank ? b : a));
      // price ≤ 0 一并挡:Number(null) / Number('') 都得 0
      const price = Number(row.eodPrice);
      // date 为空 = 全部行都没有合法日期,'' === '' 不能放行(会写出 obs_date 为空的行)
      return date && row.clearingDate === date && Number.isFinite(price) && price > 0 ? [{ ticker, price }] : [];
    }),
  };
}

export async function fetchIceCdx(doFetch = fetchWithTimeout): Promise<CdsSnapshot> {
  const res = await doFetch(INDEX_URL, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`ICE CDX 下载失败:${res.status}`);

  return parseIceCdx((await res.json()) as IceRow[]);
}
