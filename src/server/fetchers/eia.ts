/**
 * EIA 周度石油报告(Weekly Petroleum Status Report)。免费 key,注册即发。
 *
 * 发布节奏:每周三 10:30 ET,数据截止上周五 → 最新点滞后约 5 天。
 * 已发布的值**下周会被修订**;本模块每次拉全量历史,修订自然带回来 ——
 * 所以这些序列不落库(regime 路由是 live-fetch + TTL,见 routes/regime)。
 *
 * ⚠️ **v2 的 `/seriesid/` 路由有三个坑,都实测过:**
 *  1. 要的是 v1 老式全名 `PET.{ID}.W`,裸 `WDISTUS1` 直接 404 `Series ID is not valid`。
 *  2. `start` / `end` / `data[]` **全部被忽略** —— 传了也照样回整条历史(馏分油库存 2293 个
 *     观测、674KB)。唯一生效的裁剪参数是 `length`,故用它兜住 payload。
 *  3. 返回**按日期倒序**,而本项目所有序列一律升序 → 这里翻转。
 */
import type { Point } from '../analytics/regime';
import { fetchWithTimeout } from './http';
import { HISTORY_START_DATE, SEASONAL_BASELINE_YEARS } from '../config';

type FetchFn = (url: string) => Promise<Response>;

/**
 * 拉多少周 = 从「展示起点再往前垫 `SEASONAL_BASELINE_YEARS` 年」到今天。**必须算,不能写死。**
 * 曾经写死 780 周,到 2026 年只剩 ~65 周余量,再过两年就盖不住基准期了;
 * 而后果是无声的:`seasonalZ` 对样本不足的点直接跳过,图上最早那批 z 会悄悄消失,不报错。
 *
 * 别去掉这个参数 —— EIA 的 `start`/`end` 都被服务端忽略,`length` 是唯一的裁剪手段;
 * 不传就是整条 1982 起的历史(单条 674 KB × 6 条)。
 *
 * **导出只为可测**:窗口够不够是随时间漂移的性质,不能只靠「URL 里有 length=」那种断言
 * (任何数值都满足,等于没测)。
 */
export const weeksToFetch = () => {
  const from = new Date(HISTORY_START_DATE);
  from.setFullYear(from.getFullYear() - SEASONAL_BASELINE_YEARS);
  return Math.ceil((Date.now() - from.getTime()) / (7 * 86_400_000)) + 4; // +4 周缓冲
};

type EiaRow = { period: string; value: unknown };

/**
 * value 的类型**不假定**。实测本项目这六条序列回的是 JSON 数字(`"value":97.8`,无引号),
 * 但 EIA v2 各 dataset 并不一致,官方文档也出现过字符串形态 —— 而「按 typeof === 'number' 过滤」
 * 一旦遇上字符串就会**悄悄把整条序列滤空**,最后只表现为那一格 unavailable,查不出原因。
 * 故这里按值解析而不按类型:数字或数字字符串都收,null / 空串 / 解析不出的一律丢。
 */
const toFiniteNumber = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

export function createEiaFetcher(opts: { apiKey: string; fetch?: FetchFn }) {
  const doFetch = opts.fetch ?? fetchWithTimeout;

  return {
    /** `seriesId` 传裸 EIA 名(如 `WDISTUS1`),前缀/频率后缀在这里拼。 */
    async fetchWeekly(seriesId: string): Promise<Point[]> {
      if (!opts.apiKey) throw new Error('EIA_API_KEY is required');

      const params = new URLSearchParams({ api_key: opts.apiKey, length: String(weeksToFetch()) });
      const res = await doFetch(`https://api.eia.gov/v2/seriesid/PET.${seriesId}.W?${params}`);
      if (!res.ok) throw new Error(`EIA request failed for ${seriesId}: ${res.status} ${await res.text()}`);

      const body = (await res.json()) as { response?: { data?: EiaRow[] }; error?: string };
      if (!body.response?.data) throw new Error(`EIA returned no data for ${seriesId}: ${body.error ?? 'unknown'}`);

      const rows = body.response.data;
      const points = rows
        .flatMap((r) => {
          const value = toFiniteNumber(r.value);
          return value === null ? [] : [{ date: r.period, value }];
        })
        .sort((a, b) => a.date.localeCompare(b.date)); // 源是倒序,本项目一律升序

      // 「源给了行,但一行都解析不出来」= 响应结构变了,不是「这周没数」。必须响 ——
      // 否则调用方 catch→null,最终只看到那一格 unavailable,和网络失败长得一模一样。
      if (rows.length > 0 && points.length === 0)
        throw new Error(`EIA ${seriesId}: ${rows.length} 行全部解析失败(value 字段结构可能变了)`);

      return points;
    },
  };
}
