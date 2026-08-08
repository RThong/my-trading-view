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
// 含修订件(`10-Q/A` / `10-K/A`):它带来重述,水位必须跟着前进,否则重述后的值永远不进库。
const isPeriodicForm = (form: string): boolean => /^10-[QK](\/A)?$/.test(form);

// companyfacts 有几 MB,默认 15s 在慢网下会临界超时。
const FACTS_TIMEOUT_MS = 60_000;

type FetchFn = (url: string, init?: RequestInit, timeoutMs?: number) => Promise<Response>;

async function getJson<T>(url: string, doFetch: FetchFn, timeoutMs?: number): Promise<T> {
  const res = await doFetch(url, { headers: { 'User-Agent': userAgent(), Accept: 'application/json' } }, timeoutMs);
  if (!res.ok) throw new Error(`SEC request failed: ${res.status} ${url}`);

  return (await res.json()) as T;
}

type Submissions = {
  filings?: { recent?: { form?: string[]; filingDate?: string[]; accessionNumber?: string[] } };
};

/** submissions 里最新的那份定期报告。accn 用于 companyfacts 落后时直接去读申报实例。 */
export type LatestFiling = { filed: string; form: string; accn: string };

const archiveDir = (cik: string, accn: string) =>
  `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accn.replace(/-/g, '')}`;

type FilingIndex = { directory?: { item?: Array<{ name?: string }> } };

export function createSecFetcher(doFetch: FetchFn = fetchWithTimeout) {
  return {
    /** 最新一次 10-Q/10-K(按申报日最大);无定期报告返回 null。 */
    async latestFiling(cik: string): Promise<LatestFiling | null> {
      const body = await getJson<Submissions>(`https://data.sec.gov/submissions/${cikPath(cik)}.json`, doFetch);
      const { form = [], filingDate = [], accessionNumber = [] } = body.filings?.recent ?? {};

      const periodic = form.flatMap((f, i) =>
        isPeriodicForm(f) && filingDate[i] && accessionNumber[i]
          ? [{ filed: filingDate[i]!, form: f, accn: accessionNumber[i]! }]
          : [],
      );

      return periodic.length ? periodic.reduce((a, b) => (a.filed >= b.filed ? a : b)) : null;
    },

    async companyFacts(cik: string): Promise<CompanyFacts> {
      return getJson<CompanyFacts>(
        `https://data.sec.gov/api/xbrl/companyfacts/${cikPath(cik)}.json`,
        doFetch,
        FACTS_TIMEOUT_MS,
      );
    },

    /**
     * 单份申报的 XBRL 实例原文(**只在 companyfacts 落后时用**,见 job 的兜底分支)。
     * 两个请求:先 index.json 找实例文件名,再拉实例本身。
     *
     * 实例名靠 `_htm.xml` 后缀认 —— 这是 EDGAR 从 inline XBRL 抽出的实例文档,
     * 与同目录的 `_cal/_def/_lab/_pre.xml`(linkbase)和 FilingSummary.xml 区分开。
     * 2019 年起定期报告强制 inline XBRL,七家实测都有这个文件;找不到就抛,让上层记 failed。
     */
    async filingInstance(cik: string, accn: string): Promise<string> {
      const dir = archiveDir(cik, accn);
      const idx = await getJson<FilingIndex>(`${dir}/index.json`, doFetch);

      const name = idx.directory?.item?.find((it) => it.name?.endsWith('_htm.xml'))?.name;
      if (!name) throw new Error(`SEC filing ${accn}: 目录里没有 _htm.xml 实例`);

      const res = await doFetch(
        `${dir}/${name}`,
        { headers: { 'User-Agent': userAgent(), Accept: '*/*' } },
        FACTS_TIMEOUT_MS,
      );
      if (!res.ok) throw new Error(`SEC request failed: ${res.status} ${dir}/${name}`);

      return res.text();
    },
  };
}
