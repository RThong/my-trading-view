import { describe, test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate } from './db';
import {
  startJobRun,
  finishJobRun,
  getJobHealth,
  getTodaySucceededJobs,
  putSecWatermark,
  getSecLag,
  insertSecFundamentals,
  putSecProcessedFiled,
} from './repository';

function freshDb(): Database {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}

describe('repository: job_run', () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb();
  });

  test('startJobRun returns id, finishJobRun marks success', () => {
    const id = startJobRun(db, 'options');
    finishJobRun(db, id, { status: 'success', recordsWritten: 42 });
    const health = getJobHealth(db);
    const job = health.find((j) => j.name === 'options')!;
    expect(job.status).toBe('success');
    expect(job.error).toBeNull();
    expect(job.lastSuccessAt).not.toBeNull();
  });

  test('failed run does not update lastSuccessAt', () => {
    const id1 = startJobRun(db, 'options');
    finishJobRun(db, id1, { status: 'success', recordsWritten: 10 });
    const successAt = getJobHealth(db).find((j) => j.name === 'options')!.lastSuccessAt;

    const id2 = startJobRun(db, 'options');
    finishJobRun(db, id2, { status: 'failed', error: 'boom' });

    const after = getJobHealth(db).find((j) => j.name === 'options')!;
    expect(after.status).toBe('failed');
    expect(after.error).toBe('boom');
    expect(after.lastSuccessAt).toBe(successAt);
  });

  test('running 的最新 run 不被隐藏,lastSuccessAt 仍保留上次成功', () => {
    const id1 = startJobRun(db, 'options');
    finishJobRun(db, id1, { status: 'success', recordsWritten: 5 });
    const successAt = getJobHealth(db).find((j) => j.name === 'options')!.lastSuccessAt;

    startJobRun(db, 'options'); // 新一轮开跑、尚未 finish(模拟卡死中的 running)

    const job = getJobHealth(db).find((j) => j.name === 'options')!;
    expect(job.status).toBe('running'); // 不再显示成上次的 success
    expect(job.lastSuccessAt).toBe(successAt); // 上次绿是什么时候仍可见
  });
});

describe('getTodaySucceededJobs', () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb();
  });

  test('只返回今天 status=success 的 job 名(failed/partial 不算)', () => {
    const a = startJobRun(db, 'options');
    finishJobRun(db, a, { status: 'success', recordsWritten: 1 });
    const b = startJobRun(db, 'vrp_inputs');
    finishJobRun(db, b, { status: 'failed', error: 'x' });
    const c = startJobRun(db, 'vx_term_structure');
    finishJobRun(db, c, { status: 'partial', recordsWritten: 1, error: 'y' });
    expect(getTodaySucceededJobs(db).sort()).toEqual(['options']);
  });

  test('去重:同一 job 当天多次成功只算一个', () => {
    finishJobRun(db, startJobRun(db, 'options'), { status: 'success', recordsWritten: 1 });
    finishJobRun(db, startJobRun(db, 'options'), { status: 'success', recordsWritten: 2 });
    expect(getTodaySucceededJobs(db)).toEqual(['options']);
  });

  test('忽略往日的成功(只看本地日的今天)', () => {
    // 直接插一条「昨天」的 success 行(绕过 startJobRun 的 now 时间戳)
    const yest = new Date(Date.now() - 86400_000).toISOString();
    db.run(
      `INSERT INTO job_run (job_name, started_at, finished_at, status, records_written) VALUES (?, ?, ?, 'success', 1)`,
      ['options', yest, yest],
    );
    expect(getTodaySucceededJobs(db)).toEqual([]);
  });
});

describe('getSecLag', () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb();
  });

  const row = (ticker: string, periodEnd: string, filed: string) => ({
    ticker,
    periodEnd,
    concept: 'ocf',
    value: 1,
    tagUsed: 'NetCashProvidedByUsedInOperatingActivities',
    form: '10-Q',
    accn: `acc-${ticker}-${periodEnd}`,
    filed,
    fiscalQ: '2026Q1',
  });

  test('远端 filed 更新 → 报滞后;远端与本地齐平 → 不报(即便期末落后整季)', () => {
    // A:远端已交但我们没那期(META 实测形态)。B:期末比 A 旧整季,但远端就到那儿 —— 正常,不该报。
    insertSecFundamentals(db, [row('A', '2026-03-31', '2026-04-30'), row('B', '2025-12-31', '2026-01-28')]);
    putSecWatermark(db, 'A', '2026-07-30');
    putSecWatermark(db, 'B', '2026-01-28');

    expect(getSecLag(db)).toEqual([
      { ticker: 'A', remoteFiled: '2026-07-30', localFiled: '2026-04-30', latestPeriodEnd: '2026-03-31' },
    ]);
  });

  test('一行都没有的公司也算滞后(localFiled 为 null)', () => {
    putSecWatermark(db, 'C', '2026-07-30');
    expect(getSecLag(db)).toEqual([
      { ticker: 'C', remoteFiled: '2026-07-30', localFiled: null, latestPeriodEnd: null },
    ]);
  });

  test('putSecWatermark 同 ticker 覆盖不重复', () => {
    putSecWatermark(db, 'A', '2026-04-30');
    putSecWatermark(db, 'A', '2026-07-30');
    expect(getSecLag(db).map((l) => l.remoteFiled)).toEqual(['2026-07-30']);
  });
});

describe('getSecLag:本地水位取 MAX(数据 filed, processed_filed)', () => {
  const seed = (db: Database) => {
    insertSecFundamentals(db, [
      {
        ticker: 'NVDA',
        periodEnd: '2026-01-25',
        concept: 'revenue',
        value: 1,
        tagUsed: 'Revenues',
        form: '10-K',
        accn: 'a',
        filed: '2026-02-25',
        fiscalQ: '2026Q1',
      },
    ]);
  };

  test('远端有更新申报而我们没有 → 报滞后', () => {
    const db = freshDb();
    seed(db);
    putSecWatermark(db, 'NVDA', '2026-05-20');

    expect(getSecLag(db).map((l) => l.ticker)).toEqual(['NVDA']);
    db.close();
  });

  /**
   * 回归:不带财务 XBRL 的修订件(只补 Part III 的 10-K/A)一行都不落,MAX(filed) 停在上一份 10-Q。
   * 只看它的话,面板会常挂一条假的「已申报、SEC 未提供」直到下一份 10-Q(最长约三个月)。
   */
  test('修订件已处理但没落任何行 → 不报假滞后', () => {
    const db = freshDb();
    seed(db);
    putSecWatermark(db, 'NVDA', '2026-03-10');
    putSecProcessedFiled(db, 'NVDA', '2026-03-10');

    expect(getSecLag(db)).toEqual([]);
    db.close();
  });

  test('processed_filed 仍落后于远端 → 照常报滞后', () => {
    const db = freshDb();
    seed(db);
    putSecProcessedFiled(db, 'NVDA', '2026-03-10');
    putSecWatermark(db, 'NVDA', '2026-05-20');

    expect(getSecLag(db).map((l) => l.ticker)).toEqual(['NVDA']);
    db.close();
  });
});
