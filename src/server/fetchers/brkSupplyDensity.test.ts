import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate } from '../storage/db';
import { getMarketSeries, insertMarketSeries } from '../storage/repository';
import { fetchBtcValuation, fetchSupplyDensitySeries, zipDensity } from './brkSupplyDensity';
import { NonRetryableError } from './http';
import { updateBtcOnchain, updateBtcValuation, updateSupplyDensity } from '../jobs/supplyDensitySnapshot';
import { rollingMean } from '../analytics/regime';

function day1<T>(data: T[], type: string) {
  return { index: 'day1', type, start: 0, data };
}
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

describe('BTC 链上估值 MVRV / AVIV', () => {
  const real = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = real;
  });

  it('两条按下标对日期;单位不是 Multiple → NonRetryableError', async () => {
    globalThis.fetch = (async (url: string | URL | Request) =>
      Response.json(
        String(url).includes('/date/')
          ? DATES
          : day1([null, 1.2, String(url).includes('/mvrv/') ? 0.9 : 0.7], 'Multiple'),
      )) as typeof fetch;
    expect(await fetchBtcValuation()).toEqual({
      mvrv: [
        { date: '2010-08-16', value: 1.2 },
        { date: '2010-08-17', value: 0.9 },
      ],
      aviv: [
        { date: '2010-08-16', value: 1.2 },
        { date: '2010-08-17', value: 0.7 },
      ],
    });

    globalThis.fetch = (async (url: string | URL | Request) =>
      Response.json(String(url).includes('/date/') ? DATES : day1([1, 2, 3], 'Percent'))) as typeof fetch;
    await expect(fetchBtcValuation()).rejects.toThrow(NonRetryableError);

    // 短一格(跨日那一刻)放行;末尾两格都没值 = 截短 / 停更 → 抛
    const tail = (data: (number | null)[]) => {
      globalThis.fetch = (async (url: string | URL | Request) =>
        Response.json(String(url).includes('/date/') ? DATES : day1(data, 'Multiple'))) as typeof fetch;
      return fetchBtcValuation();
    };
    expect((await tail([1, 1.2])).mvrv.at(-1)?.date).toBe('2010-08-16');
    await expect(tail([1.2, null, null])).rejects.toThrow('截短');
    await expect(tail([1.2])).rejects.toThrow('截短');
  });

  it('写进 BTC_MVRV / BTC_AVIV,2012 前不写', async () => {
    const db = new Database(':memory:');
    migrate(db);
    const pts = (v: number) => [
      { date: '2011-12-31', value: 9 },
      { date: '2012-01-01', value: v },
    ];
    const n = await updateBtcValuation(db, async () => ({ mvrv: pts(1.2), aviv: pts(0.8) }));

    expect(n).toBe(2);
    expect(getMarketSeries(db, 'BTC_MVRV').map((p) => p.value)).toEqual([1.2]);
    expect(getMarketSeries(db, 'BTC_AVIV').map((p) => p.value)).toEqual([0.8]);
  });

  it('2012 起为空 / 不从 2012-01-01 开始 / 中间缺天 → 抛错、一行不写', async () => {
    const db = new Database(':memory:');
    migrate(db);
    const ok = [
      { date: '2012-01-01', value: 1 },
      { date: '2012-01-02', value: 1 },
    ];
    const cases = [[], [{ date: '2012-01-02', value: 1 }], [ok[0], { date: '2012-01-03', value: 1 }]];
    await Promise.all(
      cases.map((bad) =>
        expect(updateBtcValuation(db, async () => ({ mvrv: ok, aviv: bad }))).rejects.toThrow('不完整'),
      ),
    );
    expect(getMarketSeries(db, 'BTC_MVRV')).toHaveLength(0);
  });
});

describe('updateBtcOnchain', () => {
  it('估值抛错时供应密度照写,整次仍抛出(这组记 failed)', async () => {
    const db = new Database(':memory:');
    migrate(db);
    const density = async () => [{ date: '2026-10-04', value: 13 }];
    const boom = async () => {
      throw new NonRetryableError('BRK mvrv → 404');
    };

    await expect(updateBtcOnchain(db, density, boom)).rejects.toThrow('404');
    expect(getMarketSeries(db, 'BTC_SUPPLY_DENSITY').map((p) => p.value)).toEqual([13]);
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
