import { fetchWithTimeout } from './http';

// IMF PortWatch 咽喉要道每日过船数(AIS 船舶定位推算,免 key,ArcGIS FeatureServer)。只接霍尔木兹海峡。
// 2019-01-01 起全历史,约滞后 5 天(2026-11-13 拉到 11-08)。一次拉全、读时现拉、不落库。
// ⚠️ 服务端单页上限 1000 行(`resultRecordCount` 写更大也只回 1000,只靠 `exceededTransferLimit` 提示),
//    按 2000 翻页会静默漏掉中间 1000 天 —— 所以先取总数、按 PAGE 并发拉各页,最后核对条数。
// ⚠️ `capacity_tanker`(载重吨)不用:小油轮常无吨位数据记 0(2026-11 有 1 艘过境、吨位 0),只用艘数。
const URL_BASE =
  'https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services/Daily_Chokepoints_Data/FeatureServer/0/query';
const WHERE = `portname='Strait of Hormuz'`;
const PAGE = 1000;

export type ChokepointDay = { date: string; total: number; tanker: number };

type Feature = { attributes: { date?: unknown; n_total?: unknown; n_tanker?: unknown } };

export function parseChokepointFeatures(features: Feature[]): ChokepointDay[] {
  return features.flatMap(({ attributes: a }) =>
    typeof a.date === 'string' && typeof a.n_total === 'number' && typeof a.n_tanker === 'number'
      ? [{ date: a.date.slice(0, 10), total: a.n_total, tanker: a.n_tanker }]
      : [],
  );
}

async function query(params: Record<string, string>, doFetch: typeof fetchWithTimeout): Promise<unknown> {
  const qs = new URLSearchParams({ where: WHERE, f: 'json', ...params });
  const res = await doFetch(`${URL_BASE}?${qs}`, undefined, 30_000);
  if (!res.ok) throw new Error(`PortWatch ${res.status}`);
  const body = (await res.json()) as { error?: { message?: string } };
  // ArcGIS 出错照样回 200,错误在 body.error
  if (body.error) throw new Error(`PortWatch: ${body.error.message ?? '未知错误'}`);
  return body;
}

/** 霍尔木兹海峡每日过船数(全部船型 / 其中油轮),按日期升序。 */
export async function fetchHormuzTransits(
  doFetch: typeof fetchWithTimeout = fetchWithTimeout,
): Promise<ChokepointDay[]> {
  const { count } = (await query({ returnCountOnly: 'true' }, doFetch)) as { count: number };
  if (!count) throw new Error('PortWatch: 霍尔木兹 0 行(港口名或图层可能变了)');

  const offsets = Array.from({ length: Math.ceil(count / PAGE) }, (_, i) => i * PAGE);
  const pages = await Promise.all(
    offsets.map(
      (o) =>
        query(
          {
            outFields: 'date,n_total,n_tanker',
            orderByFields: 'date ASC',
            resultOffset: String(o),
            resultRecordCount: String(PAGE),
          },
          doFetch,
        ) as Promise<{ features: Feature[] }>,
    ),
  );
  const days = parseChokepointFeatures(pages.flatMap((p) => p.features));
  // 页上限再变小 / 字段改名时条数会对不上:宁可整条失败,也别画出缺一段的线
  if (days.length !== count) throw new Error(`PortWatch: 应有 ${count} 行,实得 ${days.length}`);

  return days;
}
