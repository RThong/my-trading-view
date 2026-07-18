import { describe, test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate } from './db';
import { startJobRun, finishJobRun, getJobHealth, getTodaySucceededJobs } from './repository';

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
