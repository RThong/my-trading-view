// 总务省 CPI「生鮮食品及びエネルギーを除く総合」(新核心核心)前年同月比,经 e-Stat API(要免费 appId)。
//
// 表与代码都是 2026-09 用 getStatsList / getMetaInfo 实测的,不是凭记忆:
//   statsDataId 0004052037 = 消費者物価指数(2025年基準),cat01 0178 = 生鮮食品及びエネルギーを除く総合,
//   area 00000 = 全国,tab 3 = 前年同月比(%)。表里现成有同比列 → 直接用,不自己由指数算。
// ⚠️ **用 2025 年基准,不是 2020 年基准**(0003427113)。两张表 2026-09 都还在更新,但 2026 年起同比
//   会差 0.1pp(如 2026-08:2020 基准 2.0 / 2025 基准 1.9),官方头条已切到 2025 基准,旧基准迟早停更。
//   2025 年之前两张表同比一致(链接系数衔接),所以换基准不会在历史上留断点。
// ⚠️ 时间码 `YYYY00MMMM`(月份写两遍,如 2026 年 8 月 = `2026000808`);年值是 `YYYY000000`,同比列里没有。
// ⚠️ 缺值是字面量 `***`;返回**倒序**(新在前)。
// 日期 = 数据所属月份(记当月 1 日);全国 CPI 通常次月下旬发布。
import { fetchWithTimeout } from './http';

const URL_BASE = 'https://api.e-stat.go.jp/rest/3.0/app/json/getStatsData';
const TABLE = { statsDataId: '0004052037', cdTab: '3', cdCat01: '0178', cdArea: '00000' };

type Point = { date: string; value: number };
type EstatValue = { '@time': string; $: string };

/** `2026000808` → `2026-08-01`;年值 / 其它形状 → null。 */
export function estatTimeToIso(t: string): string | null {
  const m = /^(\d{4})00(\d{2})\2$/.exec(t);
  return m && m[2] !== '00' ? `${m[1]}-${m[2]}-01` : null;
}

/** getStatsData 的 JSON → 升序序列。STATUS 非 0(key 错、表 id 错)→ 抛错;解析不出任何点 → 抛错。 */
export function parseEstatSeries(body: unknown): Point[] {
  const d = (body as { GET_STATS_DATA?: Record<string, any> }).GET_STATS_DATA;
  if (d?.RESULT?.STATUS !== 0) throw new Error(`e-Stat: ${d?.RESULT?.ERROR_MSG ?? '响应结构不认识'}`);

  const raw = d.STATISTICAL_DATA?.DATA_INF?.VALUE;
  const values: EstatValue[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const rows = values
    .flatMap((v) => {
      const date = estatTimeToIso(v['@time']);
      const value = Number(v.$);
      return date && v.$ !== '***' && Number.isFinite(value) ? [{ date, value }] : [];
    })
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!rows.length) throw new Error('e-Stat: 未解析出任何数据点');

  return rows;
}

/** `sinceMonth` 形如 `YYYY-MM`。 */
export async function fetchCoreCoreCpiYoy(appId: string, sinceMonth: string): Promise<Point[]> {
  const [y, m] = sinceMonth.split('-');
  const qs = new URLSearchParams({ appId, ...TABLE, cdTimeFrom: `${y}00${m}${m}` });
  // appId 在 URL 里:底层网络异常(超时 / DNS / TLS)会把完整 URL 带进 message 与 cause,
  // 在这里换成只含错误类型的新错误,不把原异常往上传。
  const r = await fetchWithTimeout(`${URL_BASE}?${qs}`).catch((e: unknown) => {
    throw new Error(`e-Stat 请求失败: ${(e as Error)?.name ?? 'Error'}`);
  });
  if (!r.ok) throw new Error(`e-Stat HTTP ${r.status}`);

  return parseEstatSeries(await r.json());
}
