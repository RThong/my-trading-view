import { describe, expect, it } from 'bun:test';
import { fetchHormuzTransits } from './portwatch';

// 假服务端:总数 count 行,单页最多 1000(同真服务端,请求写多大都只回 1000)
function fakeFetch(count: number, dropField = false) {
  return (async (url: string) => {
    const q = new URL(url).searchParams;
    if (q.get('returnCountOnly')) return Response.json({ count });
    const off = Number(q.get('resultOffset'));
    const n = Math.min(1000, Number(q.get('resultRecordCount')), count - off);
    const features = Array.from({ length: n }, (_, i) => ({
      attributes: {
        date: new Date(Date.UTC(2019, 0, 1 + off + i)).toISOString().slice(0, 10),
        n_total: 50,
        ...(dropField ? {} : { n_tanker: 30 }),
      },
    }));
    return Response.json({ features, exceededTransferLimit: off + n < count });
  }) as unknown as typeof fetch;
}

describe('fetchHormuzTransits', () => {
  it('按 1000 一页并发翻完,条数与总数一致、日期升序不重', async () => {
    const days = await fetchHormuzTransits(fakeFetch(2869));
    expect(days.length).toBe(2869);
    expect(new Set(days.map((d) => d.date)).size).toBe(2869);
    expect(days[0]).toEqual({ date: '2019-01-01', total: 50, tanker: 30 });
  });

  it('字段改名(解析不出)→ 条数对不上,整条抛错', async () => {
    await expect(fetchHormuzTransits(fakeFetch(1500, true))).rejects.toThrow('应有 1500 行');
  });

  it('ArcGIS 200 + error 体 → 抛错', async () => {
    const f = (async () => Response.json({ error: { message: 'Invalid query' } })) as unknown as typeof fetch;
    await expect(fetchHormuzTransits(f)).rejects.toThrow('Invalid query');
  });
});
