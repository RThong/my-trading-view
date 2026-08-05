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

  test('latestFiling 取 10-Q/10-K 里最大的申报日 + 对应 accn,忽略 8-K', async () => {
    const fakeFetch = async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://data.sec.gov/submissions/CIK0001045810.json'); // CIK 补零到 10 位
      // 缺 User-Agent 会被 SEC 403,这条约束靠测试锁住。
      expect((init?.headers as Record<string, string>)?.['User-Agent']).toBeTruthy();

      return json({
        filings: {
          recent: {
            form: ['8-K', '10-Q', '10-K', '8-K'],
            filingDate: ['2026-06-30', '2026-05-20', '2026-02-25', '2026-07-01'],
            accessionNumber: ['a-8k', 'a-10q', 'a-10k', 'b-8k'],
          },
        },
      });
    };

    // accn 必须跟着「被选中的那一份」而不是数组头 —— 兜底要靠它定位到正确的申报目录。
    expect(await createSecFetcher(fakeFetch).latestFiling('1045810')).toEqual({
      filed: '2026-05-20',
      form: '10-Q',
      accn: 'a-10q',
    });
  });

  test('无定期报告返回 null(不能误判成「有新申报」去拉几 MB)', async () => {
    const fakeFetch = async () =>
      json({ filings: { recent: { form: ['8-K'], filingDate: ['2026-06-30'], accessionNumber: ['a'] } } });
    expect(await createSecFetcher(fakeFetch).latestFiling('1045810')).toBeNull();
  });

  test('filingInstance:先 index.json 找 _htm.xml,再拉实例;不碰 linkbase', async () => {
    const seen: string[] = [];
    const fakeFetch = async (url: string) => {
      seen.push(url);
      if (url.endsWith('index.json')) {
        return json({
          directory: {
            item: [
              { name: 'FilingSummary.xml' },
              { name: 'nvda-20260426_pre.xml' }, // linkbase,不能选中
              { name: 'nvda-20260426_htm.xml' },
            ],
          },
        });
      }
      return new Response('<xbrl/>', { status: 200 });
    };

    const xml = await createSecFetcher(fakeFetch).filingInstance('1045810', '0001045810-26-000123');
    expect(xml).toBe('<xbrl/>');
    // 目录名要去掉 accn 里的短横、CIK 不补零(EDGAR Archives 的路径规则)。
    expect(seen).toEqual([
      'https://www.sec.gov/Archives/edgar/data/1045810/000104581026000123/index.json',
      'https://www.sec.gov/Archives/edgar/data/1045810/000104581026000123/nvda-20260426_htm.xml',
    ]);
  });

  test('filingInstance:目录里没有实例就抛,不静默返回空串', async () => {
    const fakeFetch = async () => json({ directory: { item: [{ name: 'FilingSummary.xml' }] } });
    await expect(createSecFetcher(fakeFetch).filingInstance('1045810', '0001045810-26-000123')).rejects.toThrow(
      /没有 _htm.xml 实例/,
    );
  });

  test('非 200 抛错', async () => {
    const fakeFetch = async () => new Response('forbidden', { status: 403 });
    await expect(createSecFetcher(fakeFetch).companyFacts('1045810')).rejects.toThrow(/SEC request failed: 403/);
  });
});
