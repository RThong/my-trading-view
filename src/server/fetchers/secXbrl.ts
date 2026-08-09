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
// 与 analytics/secFundamentals 的同名判据**必须一致** —— 这边定水位、那边抽数据,
// 一边认一边不认就会变成「水位永远追不上」或「拉了却抽不出行」。
//  · 含修订件(`/A`):它带来重述,水位必须跟着前进,否则重述后的值永远不进库。
//  · 含 `6-K` / `20-F`:外国私人发行人(FPI)不交 10-Q/10-K。有的 FPI 把 6-K 做了完整
//    inline XBRL(实测 ARM),不认这两档它就是「submissions 里没有定期报告」→ 直接 failed。
const isPeriodicForm = (form: string): boolean => /^(10-[QK](\/A)?|20-F(\/A)?|6-K)$/.test(form);

// companyfacts 有几 MB,默认 15s 在慢网下会临界超时。
const FACTS_TIMEOUT_MS = 60_000;

type FetchFn = (url: string, init?: RequestInit, timeoutMs?: number) => Promise<Response>;

async function getJson<T>(url: string, doFetch: FetchFn, timeoutMs?: number): Promise<T> {
  const res = await doFetch(url, { headers: { 'User-Agent': userAgent(), Accept: 'application/json' } }, timeoutMs);
  if (!res.ok) throw new Error(`SEC request failed: ${res.status} ${url}`);

  return (await res.json()) as T;
}

type Submissions = {
  filings?: { recent?: { form?: string[]; filingDate?: string[]; reportDate?: string[]; accessionNumber?: string[] } };
};

/** submissions 里最新的那份定期报告。accn 用于 companyfacts 落后时直接去读申报实例。 */
export type LatestFiling = { filed: string; form: string; accn: string };

/** 一份定期报告的定位信息。periodEnd 取 submissions 的 reportDate = 该份覆盖到的期末。 */
export type PeriodicFiling = LatestFiling & { periodEnd: string };

const archiveDir = (cik: string, accn: string) =>
  `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accn.replace(/-/g, '')}`;

type FilingIndex = { directory?: { item?: Array<{ name?: string }> } };

export function createSecFetcher(doFetch: FetchFn = fetchWithTimeout) {
  return {
    /**
     * 最新一次定期报告(按申报日最大);没有则 null。
     *
     * ⚠️ **光看 form 名不够,还要求它真的覆盖一个期间**(`reportDate` 存在且 ≠ `filingDate`)。
     * `6-K` 既是 FPI 的季报、也是它的**事件公告**,后者只带封面页 inline XBRL、零个 us-gaap 事实
     * (实测 ARM 2026-04-21 那份实例只有 1333 字节)。若拿它定水位,会得到一盏**每年两三个月的
     * 常驻黄灯**:远端水位被推高 → 不 skip → 每轮白拉几 MB companyfacts → 期末没前进 →
     * `advanced()` 恒 false → processed_filed 永不前进 → job 记 partial,面板还挂着假滞后标注。
     * 实测 ARM 的公告 6-K 密集出现,`2025-08-11 → 2025-11-05` 之间就有 86 天。
     *
     * 同一条判据 `periodicFilings` 与 sec6k 的 `listQuarterly6K` 早就在用了,这里当初漏了。
     * (它与 C 节「抽数与定水位的 form 判据必须一致」不冲突:一致的是**认哪些 form**,
     *  「这份申报覆不覆盖一个期间」是正交的另一条。)
     */
    async latestFiling(cik: string): Promise<LatestFiling | null> {
      const body = await getJson<Submissions>(`https://data.sec.gov/submissions/${cikPath(cik)}.json`, doFetch);
      const { form = [], filingDate = [], reportDate = [], accessionNumber = [] } = body.filings?.recent ?? {};

      const periodic = form.flatMap((f, i) =>
        isPeriodicForm(f) && filingDate[i] && accessionNumber[i] && reportDate[i] && reportDate[i] !== filingDate[i]
          ? [{ filed: filingDate[i]!, form: f, accn: accessionNumber[i]! }]
          : [],
      );

      return periodic.length ? periodic.reduce((a, b) => (a.filed >= b.filed ? a : b)) : null;
    },

    /**
     * 全部 10-Q/10-K(含修订件),按期末升序。**只给一次性回填用**(jobs/secBackfillInstances):
     * 日常 job 只需要最新那一份,不必把整张清单摊开。
     * 丢掉 reportDate 撞上 filingDate 的 —— 老申报里 SEC 有时把申报日填进 reportDate,那不是期末。
     */
    async periodicFilings(cik: string): Promise<PeriodicFiling[]> {
      const body = await getJson<Submissions>(`https://data.sec.gov/submissions/${cikPath(cik)}.json`, doFetch);
      const { form = [], filingDate = [], reportDate = [], accessionNumber = [] } = body.filings?.recent ?? {};

      return form
        .flatMap((f, i) =>
          isPeriodicForm(f) && filingDate[i] && accessionNumber[i] && reportDate[i] && reportDate[i] !== filingDate[i]
            ? [{ filed: filingDate[i]!, form: f, accn: accessionNumber[i]!, periodEnd: reportDate[i]! }]
            : [],
        )
        .sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
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
