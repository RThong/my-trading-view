import { describe, test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate } from './db';
import { startJobRun, finishJobRun, getJobHealth } from './repository';

function freshDb(): Database {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}

describe('repository: job_run', () => {
  let db: Database;
  beforeEach(() => { db = freshDb(); });

  test('startJobRun returns id, finishJobRun marks success', () => {
    const id = startJobRun(db, 'options');
    finishJobRun(db, id, { status: 'success', recordsWritten: 42 });
    const health = getJobHealth(db);
    const job = health.find(j => j.name === 'options')!;
    expect(job.status).toBe('success');
    expect(job.error).toBeNull();
    expect(job.lastSuccessAt).not.toBeNull();
  });

  test('failed run does not update lastSuccessAt', () => {
    const id1 = startJobRun(db, 'options');
    finishJobRun(db, id1, { status: 'success', recordsWritten: 10 });
    const successAt = getJobHealth(db).find(j => j.name === 'options')!.lastSuccessAt;

    const id2 = startJobRun(db, 'options');
    finishJobRun(db, id2, { status: 'failed', error: 'boom' });

    const after = getJobHealth(db).find(j => j.name === 'options')!;
    expect(after.status).toBe('failed');
    expect(after.error).toBe('boom');
    expect(after.lastSuccessAt).toBe(successAt);
  });
});
