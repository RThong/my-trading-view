import { fetchWithTimeout } from './http';
import type { CompanyFacts } from '../analytics/secFundamentals';

/**
 * SEC XBRL:免费、无 key,但**必须带 User-Agent(名称 + 邮箱)**,否则 403。
 * 官方限速 10 req/s —— 逐家串行拉几 MB 的 companyfacts,物理上到不了这个速率,不另加节流。
 *
 * 两个端点:
 *  - submissions:几百 KB,只用来判「有没有新的 10-Q/10-K」
 *  - companyfacts:几 MB(NVDA 3.9MB),有新申报才拉
 * 财报季集中在 1/4/7/10 月中下旬,多数周 submissions 一比对就 no-op。
 */

// 只从 env 读,不留硬编码兜底:SEC 要求 UA 带真实联系方式,写死在源码里等于把邮箱随仓库公开;
// 且拿一个假 UA 静默重试只会被 403,不如缺配置就直接失败。
function userAgent(): string {
  const ua = process.env.SEC_USER_AGENT;
  if (!ua) throw new Error('SEC_USER_AGENT is required (格式:「应用名 邮箱」,见 .env.example)');

  return ua;
}

const cikPath = (cik: string) => `CIK${cik.padStart(10, '0')}`;
const PERIODIC_FORMS = new Set(['10-Q', '10-K']);

// companyfacts 有几 MB,默认 15s 在慢网下会临界超时。
const FACTS_TIMEOUT_MS = 60_000;

type FetchFn = (url: string, init?: RequestInit, timeoutMs?: number) => Promise<Response>;

async function getJson<T>(url: string, doFetch: FetchFn, timeoutMs?: number): Promise<T> {
  const res = await doFetch(url, { headers: { 'User-Agent': userAgent(), Accept: 'application/json' } }, timeoutMs);
  if (!res.ok) throw new Error(`SEC request failed: ${res.status} ${url}`);

  return (await res.json()) as T;
}

type Submissions = { filings?: { recent?: { form?: string[]; filingDate?: string[] } } };

export function createSecFetcher(doFetch: FetchFn = fetchWithTimeout) {
  return {
    /** 最近一次 10-Q/10-K 的申报日(YYYY-MM-DD);无定期报告返回 null。 */
    async latestFiledDate(cik: string): Promise<string | null> {
      const body = await getJson<Submissions>(`https://data.sec.gov/submissions/${cikPath(cik)}.json`, doFetch);
      const { form = [], filingDate = [] } = body.filings?.recent ?? {};

      const dates = form.flatMap((f, i) => (PERIODIC_FORMS.has(f) && filingDate[i] ? [filingDate[i]!] : []));
      return dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : null;
    },

    async companyFacts(cik: string): Promise<CompanyFacts> {
      return getJson<CompanyFacts>(
        `https://data.sec.gov/api/xbrl/companyfacts/${cikPath(cik)}.json`,
        doFetch,
        FACTS_TIMEOUT_MS,
      );
    },
  };
}
