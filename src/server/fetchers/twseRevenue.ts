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

/** 库里的 series_id。与 SEC 侧的 `SEC_*` 平行,前缀标出源 —— 一眼看出这条线的可审计程度不同。 */
const SERIES_SUFFIX: Record<TwseKind, string> = { revM: 'REV_M', revYoy: 'REV_YOY' };
export const twseSeriesId = (ticker: string, kind: TwseKind): string => `TWSE_${ticker}_${SERIES_SUFFIX[kind]}`;

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
