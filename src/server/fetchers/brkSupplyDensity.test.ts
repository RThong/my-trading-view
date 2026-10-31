import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate } from '../storage/db';
import { getMarketSeries, insertMarketSeries } from '../storage/repository';
import { fetchSupplyDensitySeries, zipDensity } from './brkSupplyDensity';
import { NonRetryableError } from './http';
import { updateSupplyDensity } from '../jobs/supplyDensitySnapshot';
import { rollingMean } from '../analytics/regime';

const day1 = <T>(data: T[], type: string) => ({ index: 'day1', type, start: 0, data });
const DATES = day1(['2010-08-15', '2010-08-16', '2010-08-17'], 'Date');

describe('zipDensity', () => {
  it('按下标对日期,跳过 null(早年没价格)', () => {
    expect(zipDensity(day1([null, 1.3, 2.5], 'Percent'), DATES)).toEqual([
      { date: '2010-08-16', value: 1.3 },
      { date: '2010-08-17', value: 2.5 },
    ]);
  });

  it('density 比 date 短一格(跨日那一刻)照常对齐', () => {
    expect(zipDensity(day1([null, 1.3], 'Percent'), DATES)).toEqual([{ date: '2010-08-16', value: 1.3 }]);
  });

  it('格式漂移一律抛 NonRetryableError', () => {
    const ok = day1([1, 2, 3], 'Percent');
    const cases: [unknown, unknown][] = [
      [day1([1, 2, 3, 4], 'Percent'), DATES], // 比 date 长
      [day1([0.1, 0.2, 0.3], 'Ratio'), DATES], // 单位变了
      [day1([1, 101, 3], 'Percent'), DATES], // 越界
      [day1([1, '2', 3], 'Percent'), DATES], // 非数字
      [{ ...ok, start: 1 }, DATES], // 不从 0 开始
      [{ ...ok, index: 'day3' }, DATES],
      [null, DATES], // 响应体残缺
      [{ index: 'day1', start: 0 }, DATES],
      [ok, { ...DATES, data: 'x' }],
      [ok, day1(['2026-02-28', '2026-02-29', '2026-03-01'], 'Date')], // 不存在的日子
      [ok, day1(['2026-10-01', '2026-10-02', '2026-10-04'], 'Date')], // 断档 → 下标错位
    ];

    cases.forEach(([d, t]) => {
      expect(() => zipDensity(d, t)).toThrow(NonRetryableError);
    });
  });
});

describe('fetchSupplyDensitySeries', () => {
  const real = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = real;
  });
  const stub = (respond: (url: string) => Response) => {
    globalThis.fetch = (async (url: string | URL | Request) => respond(String(url))) as typeof fetch;
  };

  it('两条序列按下标拼起来', async () => {
    stub((url) => Response.json(url.includes('/date/') ? DATES : day1([null, 1.3, 2.5], 'Percent')));

    expect(await fetchSupplyDensitySeries()).toEqual([
      { date: '2010-08-16', value: 1.3 },
      { date: '2010-08-17', value: 2.5 },
    ]);
  });

  it('404(序列改名)/ 非 JSON → NonRetryableError;其它 HTTP 错误 → 普通 Error', async () => {
    stub(() => new Response('', { status: 404 }));
    await expect(fetchSupplyDensitySeries()).rejects.toThrow(NonRetryableError);

    stub(() => new Response('<html>', { status: 200 }));
    await expect(fetchSupplyDensitySeries()).rejects.toThrow(NonRetryableError);

    stub(() => new Response('', { status: 503 }));
    const err = await fetchSupplyDensitySeries().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(NonRetryableError);
  });
});

describe('updateSupplyDensity', () => {
  const series = [
    { date: '2011-12-31', value: 9 },
    { date: '2026-10-03', value: 12 },
    { date: '2026-10-04', value: 13 },
  ];

  it('全量覆盖写(盘中值被盖掉),2012 前不写', async () => {
    const db = new Database(':memory:');
    migrate(db);
    insertMarketSeries(db, [{ seriesId: 'BTC_SUPPLY_DENSITY', obsDate: '2026-10-04', value: 1 }]);

    const r = await updateSupplyDensity(db, async () => series, new Date('2026-10-05T03:00:00Z'));

    expect(r).toEqual({ written: 2, latest: '2026-10-04', stale: false });
    expect(getMarketSeries(db, 'BTC_SUPPLY_DENSITY').map((p) => p.value)).toEqual([12, 13]);
  });

  it('抓取失败整次抛出,一行都不写', async () => {
    const db = new Database(':memory:');
    migrate(db);
    const boom = async () => {
      throw new NonRetryableError('格式异常');
    };

    await expect(updateSupplyDensity(db, boom)).rejects.toThrow(NonRetryableError);
    expect(getMarketSeries(db, 'BTC_SUPPLY_DENSITY')).toHaveLength(0);
  });

  it('恰好落后 3 个日历天不算停更(按日期比,不按小时)', async () => {
    const db = new Database(':memory:');
    migrate(db);
    const r = await updateSupplyDensity(db, async () => series, new Date('2026-10-07T23:00:00Z'));

    expect(r.stale).toBe(false);
  });

  it('源最新日期落后 >3 天 → stale', async () => {
    const db = new Database(':memory:');
    migrate(db);
    const r = await updateSupplyDensity(db, async () => series, new Date('2026-10-08T00:00:00Z'));

    expect(r.stale).toBe(true);
  });
});

describe('rollingMean', () => {
  it('窗口不足的前 n−1 点不输出', () => {
    const pts = [1, 2, 3, 4].map((value, i) => ({ date: `2026-10-0${i + 1}`, value }));

    expect(rollingMean(pts, 3)).toEqual([
      { date: '2026-10-03', value: 2 },
      { date: '2026-10-04', value: 3 },
    ]);
  });
});
