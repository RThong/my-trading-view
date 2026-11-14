import { fetchWithTimeout } from './http';

// 芝加哥联储劳动力市场指标 CFLMI(2025 起发布,每月两次:BLS 就业报告前的 advance 与之后的 final)。
// 把失业拆成两个流量:流入(在职者失去工作)与流出(失业者找到工作或退出劳动力),再推出「流量一致失业率」
// = 流入 ÷ (流入 + 流出),即按当前流量失业率会收敛到哪。月频,2008-07 起,读时现拉、不落库。
// 数据接口:data.chicagofed.org/cfed-drm-chicago/CFLMI 给清单,其中 chiLaborMarketIndicatorsJson 是全部序列(约 65KB),
// 形如 { series: [{ source_id, metadata, observations: [[日期, "数值"], …] }] }。日期是 BLS 就业报告的参考周(周六)。
// 方法论:Chicago Fed Working Paper 2026-09(偏最小二乘,把 CPS 流量与失业金申领、招聘广告等高频数据合成)。
const URL = 'https://api.data.chicagofed.org/CFLMI/chi-labor-market-indicators.json';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

// 对外的三条:离职率(流入)、失业者流出率、流量一致失业率
export const CFLMI_SERIES = {
  separations: 'CFLMILAYOFFSOTHERSEPSRATE',
  hiring: 'CFLMIHIRINGRATEUW',
  flowRate: 'CFLMIFCR',
} as const;
type Key = keyof typeof CFLMI_SERIES;

export type Point = { date: string; value: number };
type Series = { source_id?: unknown; metadata?: { units?: unknown }; observations?: unknown };

/** 参考周日期(如 2026-10-17)→ 当月 1 日:同项目月频约定,也让它和 FRED 月频的失业率对得上。 */
function monthStart(d: string): string {
  return `${d.slice(0, 7)}-01`;
}

export function parseCflmi(json: unknown): Record<Key, Point[]> {
  const all = (json as { series?: Series[] })?.series;
  if (!Array.isArray(all)) throw new Error('CFLMI:JSON 里没有 series(结构变了)');

  const pick = (id: string): Point[] => {
    const s = all.find((x) => x.source_id === id);
    if (!s) throw new Error(`CFLMI:缺序列 ${id}`);
    if (s.metadata?.units !== '%') throw new Error(`CFLMI:${id} 单位不是 %(${String(s.metadata?.units)})`);
    if (!Array.isArray(s.observations) || !s.observations.length) throw new Error(`CFLMI:${id} 没有观测`);

    const points = s.observations.map((o: unknown): Point => {
      const [d, v] = Array.isArray(o) ? o : [];
      const value = Number(v);
      // 日期要是真实存在的日子(2026-13-40、2026-02-30 都算坏):解析后再格式化回来必须一模一样
      const t = typeof d === 'string' ? Date.parse(`${d}T00:00:00Z`) : Number.NaN;
      const realDate = !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === d;
      if (
        !realDate ||
        typeof d !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(d) ||
        typeof v !== 'string' ||
        !v.trim() ||
        !Number.isFinite(value)
      ) {
        throw new Error(`CFLMI:${id} 坏观测 ${JSON.stringify(o)}`);
      }
      return { date: monthStart(d), value };
    });
    // 一个月只该有一个点(参考周);同月两点说明口径变了,别让后一个悄悄覆盖前一个
    if (new Set(points.map((p) => p.date)).size !== points.length) throw new Error(`CFLMI:${id} 同月多个观测`);

    return points.sort((a, b) => a.date.localeCompare(b.date));
  };

  return {
    separations: pick(CFLMI_SERIES.separations),
    hiring: pick(CFLMI_SERIES.hiring),
    flowRate: pick(CFLMI_SERIES.flowRate),
  };
}

export async function fetchCflmi(doFetch: typeof fetchWithTimeout = fetchWithTimeout): Promise<Record<Key, Point[]>> {
  const res = await doFetch(URL, { headers: { 'User-Agent': UA } }, 30_000);
  if (!res.ok) throw new Error(`CFLMI ${res.status}`);

  return parseCflmi(await res.json());
}
