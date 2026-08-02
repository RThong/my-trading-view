import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate } from '../storage/db';
import { getMarketSeries, getSecFundamentals } from '../storage/repository';
import { updateSecFundamentals } from './secFundamentals';
import type { CompanyFacts } from '../analytics/secFundamentals';

function freshDb(): Database {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}

// 一年四期 YTD 现金流 + 同期收入/成本,够算出一个 TTM 点。
const FACTS: CompanyFacts = {
  facts: {
    'us-gaap': {
      NetCashProvidedByUsedInOperatingActivities: {
        units: {
          USD: [
            { start: '2025-01-27', end: '2025-04-27', val: 20e9, accn: 'a', form: '10-Q', filed: '2025-05-28' },
            { start: '2025-01-27', end: '2025-07-27', val: 40e9, accn: 'b', form: '10-Q', filed: '2025-08-27' },
            { start: '2025-01-27', end: '2025-10-26', val: 60e9, accn: 'c', form: '10-Q', filed: '2025-11-19' },
            { start: '2025-01-27', end: '2026-01-25', val: 80e9, accn: 'd', form: '10-K', filed: '2026-02-25' },
          ],
        },
      },
      PaymentsToAcquirePropertyPlantAndEquipment: {
        units: {
          USD: [
            { start: '2025-01-27', end: '2025-04-27', val: 1e9, accn: 'a', form: '10-Q', filed: '2025-05-28' },
            { start: '2025-01-27', end: '2025-07-27', val: 2e9, accn: 'b', form: '10-Q', filed: '2025-08-27' },
            { start: '2025-01-27', end: '2025-10-26', val: 3e9, accn: 'c', form: '10-Q', filed: '2025-11-19' },
            { start: '2025-01-27', end: '2026-01-25', val: 4e9, accn: 'd', form: '10-K', filed: '2026-02-25' },
          ],
        },
      },
    },
  },
};

const stubFetcher = (filed: string | null, onFacts?: () => void) => ({
  latestFiledDate: async () => filed,
  companyFacts: async () => {
    onFacts?.();
    return FACTS;
  },
});

describe('sec fundamentals job', () => {
  test('首次跑:落单季行 + 派生 TTM/合计序列', async () => {
    const db = freshDb();
    const r = await updateSecFundamentals(db, { tickers: ['NVDA'], fetcher: stubFetcher('2026-02-25') });

    expect(r.fetched).toEqual(['NVDA']);
    expect(getSecFundamentals(db, 'NVDA')).toHaveLength(8); // ocf 4 期 + capex 4 期

    // TTM FCF = (80 − 4) 十亿 → 76,000 百万;合计只有一家时等于该家。
    expect(getMarketSeries(db, 'SEC_NVDA_FCF_TTM')).toEqual([{ date: '2026-01-25', value: 76_000 }]);
    expect(getMarketSeries(db, 'SEC_AICHAIN_FCF_TTM')).toEqual([{ date: '2026-01-25', value: 76_000 }]);
    db.close();
  });

  test('远端 filed 不比本地新 → 跳过,不拉几 MB 的 companyfacts', async () => {
    const db = freshDb();
    await updateSecFundamentals(db, { tickers: ['NVDA'], fetcher: stubFetcher('2026-02-25') });

    let pulled = 0;
    const r = await updateSecFundamentals(db, {
      tickers: ['NVDA'],
      fetcher: stubFetcher('2026-02-25', () => {
        pulled += 1;
      }),
    });

    expect(r.skipped).toEqual(['NVDA']);
    expect(pulled).toBe(0);
    db.close();
  });

  test('submissions 拿不到定期报告申报日 → 跳过,不去拉几 MB 的 companyfacts', async () => {
    const db = freshDb();
    let pulled = 0;
    const r = await updateSecFundamentals(db, {
      tickers: ['NVDA'],
      fetcher: stubFetcher(null, () => {
        pulled += 1;
      }),
    });

    expect(r.skipped).toEqual(['NVDA']);
    expect(pulled).toBe(0);
    db.close();
  });

  test('全跳过是真 no-op:不重算派生序列', async () => {
    const db = freshDb();
    await updateSecFundamentals(db, { tickers: ['NVDA'], fetcher: stubFetcher('2026-02-25') });

    const r = await updateSecFundamentals(db, { tickers: ['NVDA'], fetcher: stubFetcher('2026-02-25') });
    expect(r.seriesWritten).toBe(0);
    db.close();
  });

  test('派生量与名单脱节时,即使全跳过也会自愈重建', async () => {
    // 覆盖真实场景:手动单跑核对某家 → 加进 SEC_ACTIVE_TICKERS → 下一轮所有人都因无新申报而 skip。
    // 若重算挂在「有抓到东西」上,合计线会停在旧名单口径。这里用「手工删掉合计序列」模拟脱节。
    const db = freshDb();
    await updateSecFundamentals(db, { tickers: ['NVDA'], fetcher: stubFetcher('2026-02-25') });
    db.run(`DELETE FROM market_series WHERE series_id = 'SEC_AICHAIN_FCF_TTM'`);

    const r = await updateSecFundamentals(db, { tickers: ['NVDA'], fetcher: stubFetcher('2026-02-25') });

    expect(r.fetched).toEqual([]); // 一家都没抓
    expect(r.seriesWritten).toBeGreaterThan(0); // 但派生量重建了
    expect(getMarketSeries(db, 'SEC_AICHAIN_FCF_TTM')).toEqual([{ date: '2026-01-25', value: 76_000 }]);
    db.close();
  });

  test('单家抓取失败只记 failed,不中断整轮', async () => {
    const db = freshDb();
    const boom = {
      latestFiledDate: async () => {
        throw new Error('network down');
      },
      companyFacts: async () => FACTS,
    };

    const r = await updateSecFundamentals(db, { tickers: ['NVDA'], fetcher: boom });
    expect(r.failed).toEqual(['NVDA: network down']);
    expect(r.fetched).toEqual([]);
    db.close();
  });

  test('--force 无视 filed 比对', async () => {
    const db = freshDb();
    await updateSecFundamentals(db, { tickers: ['NVDA'], fetcher: stubFetcher('2026-02-25') });

    const r = await updateSecFundamentals(db, { tickers: ['NVDA'], force: true, fetcher: stubFetcher('2026-02-25') });
    expect(r.fetched).toEqual(['NVDA']);
    db.close();
  });

  test('未知 ticker 抛错(名单打错字不能静默跳过)', async () => {
    const db = freshDb();
    await expect(updateSecFundamentals(db, { tickers: ['XXXX'], fetcher: stubFetcher('2026-02-25') })).rejects.toThrow(
      /unknown SEC ticker/,
    );
    db.close();
  });
});
