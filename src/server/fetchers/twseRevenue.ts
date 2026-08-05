import { fetchWithTimeout } from './http';
import type { TwseKind } from '../../shared/aiChain';

/**
 * 台湾证交所(TWSE)OpenAPI 月营收。**免 key、官方**,每月 10 日左右出上月数
 * (T+10)—— 这是整条 AI 链里最快的读数,比任何季报早一个月以上。
 *
 * 端点 `t187ap05_L` = 上市公司「营业收入汇总表」,一次返回**全体上市公司的最新一个月**。
 * 金额单位是**千元新台币**,年月是**民国年月**(11506 = 2026-06)。
 *
 * ⚠️ **快照型源,不可回填**。端点只给最新一个月;历史页(mops 的 t21sc03)有反爬,
 * 实测返回「FOR SECURITY REASONS, THIS PAGE CAN NOT BE ACCESSED」。
 * 所以序列只能一个月一个月往前攒。
 *
 * 一次调用能拿到**三个月**的营收(而不是一个):当月、上月、去年当月都在同一条记录里。
 * 首次接入就有三个点,之后每月自然续上。这是快照源里少见的便宜事,别浪费。
 */

const URL = 'https://openapi.twse.com.tw/v1/opendata/t187ap05_L';

const INCOME_URL = 'https://openapi.twse.com.tw/v1/opendata/t187ap06_L_ci';

/** 库里的 series_id。与 SEC 侧的 `SEC_*` 平行,前缀标出源 —— 一眼看出这条线的可审计程度不同。 */
const SERIES_SUFFIX: Record<TwseKind, string> = { revM: 'REV_M', revYoy: 'REV_YOY', gm: 'GM' };
export const twseSeriesId = (ticker: string, kind: TwseKind): string => `TWSE_${ticker}_${SERIES_SUFFIX[kind]}`;

/** 累计原始量(可审计留档,毛利率由它们差分而来)。不进面板,只在库里。 */
export const twseYtdSeriesId = (ticker: string, what: 'rev' | 'cogs'): string =>
  `TWSE_${ticker}_${what === 'rev' ? 'REV_YTD' : 'COGS_YTD'}`;

// 民国年月(11506)→ 该月最后一天(2026-06-30)。序列按月末打点:月营收是整月的量,
// 落在月末才不会和「月初就有这个数」的错觉混淆。
export function rocMonthEnd(rocYm: string): string | null {
  const m = /^(\d{3})(\d{2})$/.exec(rocYm.trim());
  if (!m) return null;

  const year = Number(m[1]) + 1911;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;

  const last = new Date(Date.UTC(year, month, 0)).getUTCDate(); // 第 0 天 = 上个月最后一天
  return `${year}-${String(month).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
}

/** 加减月份后取月末,用来定位「上月」与「去年当月」。 */
function shiftMonthEnd(monthEnd: string, deltaMonths: number): string | null {
  const [y, m] = monthEnd.split('-').map(Number);
  if (!y || !m) return null;

  const total = y * 12 + (m - 1) + deltaMonths;
  return rocMonthEnd(
    `${String(Math.floor(total / 12) - 1911).padStart(3, '0')}${String((total % 12) + 1).padStart(2, '0')}`,
  );
}

type Record05 = {
  資料年月?: string;
  公司代號?: string;
  公司名稱?: string;
  '營業收入-當月營收'?: string;
  '營業收入-上月營收'?: string;
  '營業收入-去年當月營收'?: string;
  '營業收入-去年同月增減(%)'?: string;
  備註?: string;
};

export type MonthlyRevenue = {
  /** 月末日(YYYY-MM-DD) */
  monthEnd: string;
  /** 营收,**百万新台币**(源给千元,除以 1000) */
  revenueTwdM: number;
};

export type TwseRevenueResult = {
  company: string;
  /** 当月 / 上月 / 去年当月,升序;缺哪个就少哪个。 */
  points: MonthlyRevenue[];
  /** 源自己算的同比(%),对应最新那个月。源没给就是 null。 */
  yoyPct: number | null;
  /** 最新月的月末日,用来判「有没有出新一期」。 */
  latestMonthEnd: string;
  /** 源附的备注(常写增减原因,实测 2026-06 是「因先進製程產品需求增加所致」)。 */
  note: string | null;
};

// 千元 → 百万;空串/非数字 → null。源里缺值是空字符串而不是 0,不能当 0 用。
const toMillion = (raw: string | undefined): number | null => {
  const n = Number(String(raw ?? '').replace(/,/g, ''));
  return raw && Number.isFinite(n) ? n / 1000 : null;
};

type FetchFn = (url: string, init?: RequestInit, timeoutMs?: number) => Promise<Response>;

/**
 * 取某个上市公司代号(TSMC = 2330)的最新月营收。
 * 整包约 600KB / 1000 余家,只能整包拉后自己筛 —— 端点不支持按代号查询。
 */
export async function fetchTwseMonthlyRevenue(
  twseCode: string,
  doFetch: FetchFn = fetchWithTimeout,
): Promise<TwseRevenueResult> {
  const res = await doFetch(URL, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`TWSE t187ap05_L → HTTP ${res.status}`);

  const all = (await res.json()) as Record05[];
  if (!Array.isArray(all) || all.length === 0) throw new Error('TWSE t187ap05_L 返回空数组(源结构可能变了)');

  const row = all.find((r) => r['公司代號'] === twseCode);
  // 找不到不是「本月没数」而是配置/源出问题:2330 是上市股,必然在这张表里。
  if (!row) throw new Error(`TWSE t187ap05_L 里没有代号 ${twseCode}(共 ${all.length} 家)`);

  const latestMonthEnd = rocMonthEnd(row['資料年月'] ?? '');
  if (!latestMonthEnd) throw new Error(`TWSE ${twseCode}: 资料年月无法解析(${row['資料年月']})`);

  // 三个月一次拿齐:当月、上月(−1)、去年当月(−12)。
  const candidates: Array<[string | null, number | null]> = [
    [latestMonthEnd, toMillion(row['營業收入-當月營收'])],
    [shiftMonthEnd(latestMonthEnd, -1), toMillion(row['營業收入-上月營收'])],
    [shiftMonthEnd(latestMonthEnd, -12), toMillion(row['營業收入-去年當月營收'])],
  ];

  const points = candidates
    .flatMap(([monthEnd, revenueTwdM]) =>
      monthEnd && revenueTwdM !== null && revenueTwdM > 0 ? [{ monthEnd, revenueTwdM }] : [],
    )
    .sort((a, b) => a.monthEnd.localeCompare(b.monthEnd));

  if (points.length === 0) throw new Error(`TWSE ${twseCode}: 当月营收拿不到值`);

  const yoyRaw = Number(row['營業收入-去年同月增減(%)']);

  return {
    company: row['公司名稱'] ?? twseCode,
    points,
    yoyPct: Number.isFinite(yoyRaw) ? yoyRaw : null,
    latestMonthEnd,
    note: row['備註'] && row['備註'] !== '-' ? row['備註'] : null,
  };
}

// ── 季度综合损益(毛利率的来源)──────────────────────────────────────────────

type IncomeRow = { 年度?: string; 季別?: string; 公司代號?: string; 營業收入?: string; 營業成本?: string };

/** 民国年 + 季 → 季末日。台股季末固定在自然季末(和美股财年错开无关)。 */
const QUARTER_END: Record<string, string> = { '1': '03-31', '2': '06-30', '3': '09-30', '4': '12-31' };

export type TwseIncome = {
  /** 季末日 */
  periodEnd: string;
  /** **年初至今累计**营收,百万新台币 —— 不是单季! */
  revenueYtdTwdM: number;
  /** 年初至今累计营业成本,百万新台币 */
  cogsYtdTwdM: number;
};

/**
 * 季度综合损益表(一般业),用来算毛利率。**免 key、官方**,与月营收同一个 OpenAPI。
 *
 * 三个必须知道的性质:
 *  1. **金额是年初至今累计**,不是单季(实测 115Q2 的光寶科 96.1B 千元 ≈ 其半年营收)。
 *     单季要拿相邻两季的累计相减 —— 所以库里存累计原始量,毛利率在 job 里差分出来。
 *  2. **只有最新一季**,和月营收一样是快照型、不可回填。
 *  3. **同一季里各公司陆续申报**(截止日是季后 45 天左右)。实测 2026-08-05 那天 115Q2
 *     只有 82 家在表里,台积电还没交。所以「表里没有这家」是**正常状态**,不是错误 ——
 *     与月营收那个端点相反(那个是全体同时出,缺了就说明源出问题)。
 */
export async function fetchTwseQuarterlyIncome(
  twseCode: string,
  doFetch: FetchFn = fetchWithTimeout,
): Promise<TwseIncome | null> {
  const res = await doFetch(INCOME_URL, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`TWSE t187ap06_L_ci → HTTP ${res.status}`);

  const all = (await res.json()) as IncomeRow[];
  if (!Array.isArray(all) || all.length === 0) throw new Error('TWSE t187ap06_L_ci 返回空数组(源结构可能变了)');

  const row = all.find((r) => r['公司代號'] === twseCode);
  if (!row) return null; // 本季还没交 —— 正常,下轮再看

  const mmdd = QUARTER_END[String(row['季別'] ?? '')];
  const rocYear = Number(row['年度']);
  if (!mmdd || !Number.isFinite(rocYear)) {
    throw new Error(`TWSE ${twseCode}: 年度/季別无法解析(${row['年度']}/${row['季別']})`);
  }

  const revenueYtdTwdM = toMillion(row['營業收入']);
  const cogsYtdTwdM = toMillion(row['營業成本']);
  // 营收有值而成本没有 → 算不出毛利率。抛出来而不是静默跳过:一般业必有营业成本,
  // 缺了说明这家用了别的报表模板(金融/金控等各有各的端点),该换端点而不是等下轮。
  if (revenueYtdTwdM === null || cogsYtdTwdM === null) {
    throw new Error(`TWSE ${twseCode}: 累计营收或营业成本缺值(营收=${row['營業收入']} 成本=${row['營業成本']})`);
  }

  return { periodEnd: `${rocYear + 1911}-${mmdd}`, revenueYtdTwdM, cogsYtdTwdM };
}
