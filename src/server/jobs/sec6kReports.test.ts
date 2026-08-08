import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate } from '../storage/db';
import { getSecFundamentals } from '../storage/repository';
import { updateSec6kReports } from './sec6kReports';
import { extractFundamentals } from '../analytics/secFundamentals';
import { toCompanyFacts as packFacts, type FsFiling, type Sec6kValues } from '../fetchers/sec6k';

function freshDb(): Database {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}

const filing = (periodEnd: string, filed: string): FsFiling => ({ accn: `fs-${periodEnd}`, filed, periodEnd });

const Q1 = filing('2026-03-31', '2026-05-15');
const Q2 = filing('2026-06-30', '2026-08-14');

/** 报表口径的值(已核阅)。 */
const AUDITED: Sec6kValues = { revenue: 1_000, cogs: 400, ocf: 700, capex: 300 };
/** 财报稿口径的值(未核阅)—— 故意给个明显不同的营收,好认出是谁写进去的。 */
const UNAUDITED = 9_999;

describe('updateSec6kReports:财报稿只补报表空白处', () => {
  /**
   * 回归:「哪些季度算报表已覆盖」曾经按**本轮解析成功的行**判。
   * 单份报表解析失败是被容忍的(4MB 文档、无重试),于是那一季会重新落进 pending,
   * 财报稿行按 (ticker, period_end, concept) upsert 回去 —— 未核阅的管理层数覆盖已核阅的报表值,
   * 而且静默。判据必须是「远端存不存在这一季的报表」。
   */
  test('某季报表这一轮解析失败 → 该季不由财报稿顶上(不覆盖已核阅的值)', async () => {
    const db = freshDb();

    // 先跑一轮全成功,让两季的报表值进库。
    const ok = {
      listFilings: async () => [Q1, Q2],
      parseFiling: async () => AUDITED,
      toFacts: (rows: Array<{ filing: FsFiling; values: Sec6kValues }>) => packFacts(rows, 'quarter', 1),
    };
    await updateSec6kReports(db, { tickers: ['TSM'], adapters: { TSM: ok } });

    const before = getSecFundamentals(db, 'TSM').find((r) => r.periodEnd === Q2.periodEnd && r.concept === 'revenue');
    expect(before?.value).toBe(AUDITED.revenue);

    // 第二轮:Q2 的正文拉挂,而财报稿两季都有。
    const failed: string[] = [];
    await updateSec6kReports(db, {
      force: true,
      tickers: ['TSM'],
      adapters: {
        TSM: {
          ...ok,
          parseFiling: async (_cik, f) => {
            if (f.periodEnd === Q2.periodEnd) throw new Error('正文拉挂');
            return AUDITED;
          },
          quickPatch: {
            listFilings: async () => [Q1, Q2],
            apply: async (ctx) => {
              // 报表存在的季度一律不补 —— 这正是被测的判据。
              const pending = (ctx.filings ?? []).filter((f) => !ctx.statementPeriods.has(f.periodEnd));
              failed.push(...ctx.failed);
              return {
                rows: pending.length
                  ? extractFundamentals(
                      'TSM',
                      packFacts(
                        pending.map((f) => ({ filing: f, values: { ...AUDITED, revenue: UNAUDITED } })),
                        'quarter',
                        1,
                      ),
                    )
                  : [],
                checked: null,
              };
            },
          },
        },
      },
    });

    const after = getSecFundamentals(db, 'TSM').find((r) => r.periodEnd === Q2.periodEnd && r.concept === 'revenue');
    expect(after?.value).toBe(AUDITED.revenue); // 仍是已核阅的值,没被 9,999 盖掉
    db.close();
  });

  test('报表尚未覆盖的季度才由财报稿补', async () => {
    const db = freshDb();

    await updateSec6kReports(db, {
      tickers: ['TSM'],
      adapters: {
        TSM: {
          listFilings: async () => [Q1], // 远端只有 Q1 的报表
          parseFiling: async () => AUDITED,
          toFacts: (rows) => packFacts(rows, 'quarter', 1),
          quickPatch: {
            listFilings: async () => [Q1, Q2], // 财报稿已经有 Q2
            apply: async (ctx) => ({
              rows: extractFundamentals(
                'TSM',
                packFacts(
                  (ctx.filings ?? [])
                    .filter((f) => !ctx.statementPeriods.has(f.periodEnd))
                    .map((f) => ({ filing: f, values: { ...AUDITED, revenue: UNAUDITED } })),
                  'quarter',
                  1,
                ),
              ),
              checked: null,
            }),
          },
        },
      },
    });

    const rows = getSecFundamentals(db, 'TSM').filter((r) => r.concept === 'revenue');
    expect(rows.find((r) => r.periodEnd === Q1.periodEnd)?.value).toBe(AUDITED.revenue);
    expect(rows.find((r) => r.periodEnd === Q2.periodEnd)?.value).toBe(UNAUDITED); // 空白处才补
    db.close();
  });
});
