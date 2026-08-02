import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { createSecFetcher } from './secXbrl';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

// UA 从 env 读:测试自己设,别依赖本机 .env(否则 CI / 干净环境上会莫名其妙失败)。
const REAL_UA = process.env.SEC_USER_AGENT;
beforeEach(() => {
  process.env.SEC_USER_AGENT = 'test-agent test@example.com';
});
afterAll(() => {
  // 干净环境(CI 无 .env)里 REAL_UA 是 undefined,直接赋值会写成字面串 "undefined",
  // 污染同一 bun test 进程里后续文件的环境。必须走 delete。
  if (REAL_UA === undefined) delete process.env.SEC_USER_AGENT;
  else process.env.SEC_USER_AGENT = REAL_UA;
});

describe('sec fetcher', () => {
  test('缺 SEC_USER_AGENT 直接抛错,不拿假 UA 去撞 SEC 的 403', async () => {
    process.env.SEC_USER_AGENT = undefined;
    delete process.env.SEC_USER_AGENT;

    const fakeFetch = async () => json({});
    await expect(createSecFetcher(fakeFetch).companyFacts('1045810')).rejects.toThrow(/SEC_USER_AGENT/);
  });

  test('latestFiledDate 取 10-Q/10-K 里最大的申报日,忽略 8-K', async () => {
    const fakeFetch = async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://data.sec.gov/submissions/CIK0001045810.json'); // CIK 补零到 10 位
      // 缺 User-Agent 会被 SEC 403,这条约束靠测试锁住。
      expect((init?.headers as Record<string, string>)?.['User-Agent']).toBeTruthy();

      return json({
        filings: {
          recent: {
            form: ['8-K', '10-Q', '10-K', '8-K'],
            filingDate: ['2026-06-30', '2026-05-20', '2026-02-25', '2026-07-01'],
          },
        },
      });
    };

    expect(await createSecFetcher(fakeFetch).latestFiledDate('1045810')).toBe('2026-05-20');
  });

  test('无定期报告返回 null(不能误判成「有新申报」去拉几 MB)', async () => {
    const fakeFetch = async () => json({ filings: { recent: { form: ['8-K'], filingDate: ['2026-06-30'] } } });
    expect(await createSecFetcher(fakeFetch).latestFiledDate('1045810')).toBeNull();
  });

  test('非 200 抛错', async () => {
    const fakeFetch = async () => new Response('forbidden', { status: 403 });
    await expect(createSecFetcher(fakeFetch).companyFacts('1045810')).rejects.toThrow(/SEC request failed: 403/);
  });
});
