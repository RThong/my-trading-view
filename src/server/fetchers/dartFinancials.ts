import { fetchWithTimeout } from './http';
import type { FsFiling, Sec6kValues } from './sec6k';

/**
 * 韩国金融监督院 DART OpenAPI —— SK 海力士的四科目唯一来源。
 *
 * 为什么非它不可:海力士的 SEC 侧**零财务 XBRL**(companyfacts 只有 `ffd` 命名空间 5 个 tag),
 * 它的 6-K 与英文财报稿都只有营收 / 营业利润 / 净利 —— **没有营业成本、没有现金流**,
 * 毛利率和 FCF 都算不出来。DART 的「单一公司全部财务报表」端点给 BS/IS/CIS/CF/SCE 全表。
 *
 * 免费,注册选**개인/Individual**(只要 email、无手机验证),限 20,000 次/日。
 * 缺 DART_API_KEY 时整条线跳过,不影响其它公司。
 *
 * 时效 T+45(韩国分기보고서法定期限),与 TSM 的合并报表同档;更快的读数在 6-K(T+25),
 * 但那边只有营收与营业利润 —— 和 TSM「财报稿快但科目少」是同一个形状。
 */

const URL = 'https://opendart.fss.or.kr/api/fnlttSinglAcntAll.json';

/**
 * 四科目的 **account_id 链**。⚠️ **绝不能按 `account_nm`(中文名)匹配** —— 实测两个会静默取错的坑:
 *  · `기타영업외수익`(其它营业外收益)含「수익」,而且**排在 `매출액` 前面** → 按名字取营收会拿到它。
 *  · `유형자산의 처분`(处分)**排在 `유형자산의 취득`(购置)前面** → 按名字取 capex 会拿到
 *    处置回款,符号还是反的。
 *
 * 链有两档是因为 **2019 年 3Q 换过 taxonomy 前缀**:之前 `ifrs_*`、之后 `ifrs-full_*`,
 * 概念名完全一样。只留新档 → 历史只到 2019Q3;两档都留 → **回填到 2016Q1**。
 */
const ACCOUNT_IDS: Record<keyof Sec6kValues, string[]> = {
  revenue: ['ifrs-full_Revenue', 'ifrs_Revenue'],
  cogs: ['ifrs-full_CostOfSales', 'ifrs_CostOfSales'],
  ocf: ['ifrs-full_CashFlowsFromUsedInOperatingActivities', 'ifrs_CashFlowsFromUsedInOperatingActivities'],
  capex: [
    'ifrs-full_PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities',
    'ifrs_PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities',
  ],
};

/** 报告类型 → 该报告覆盖到的**期末**(海力士财年即日历年)。顺序即时间顺序。 */
export const REPORTS = [
  { code: '11013', monthDay: '03-31' }, // 1분기보고서
  { code: '11012', monthDay: '06-30' }, // 반기보고서
  { code: '11014', monthDay: '09-30' }, // 3분기보고서
  { code: '11011', monthDay: '12-31' }, // 사업보고서
] as const;

type Row = {
  account_id?: string;
  thstrm_amount?: string;
  thstrm_add_amount?: string;
  rcept_no?: string;
};
type Body = { status?: string; message?: string; list?: Row[] };

/**
 * 取一行的**年初至今累计**值。
 *
 * 一个源里有两种期间口径,这条规则把它们抹平(实测八种组合都成立):
 *  · CIS(损益表)季报:`thstrm_amount` 是**单季**、`thstrm_add_amount` 是累计 → 取后者。
 *  · CIS 年报:`thstrm_amount` 是**全年**、累计列是空的 → 退回前者(全年即累计)。
 *  · CF(现金流量表)所有报告:`thstrm_amount` 本身就是累计、累计列空 → 退回前者。
 *
 * 统一成累计后,整条走 `PeriodBasis: 'ytd'`,单季由下游相邻相减还原 —— 与 TSM 同一条路径。
 * 若改成「季报取单季、年报取全年」,年报那期 start 仍是 1-1、跨度 364 天,差分会因长度判据被丢掉,
 * **Q4 会静默消失**。
 */
const cumulative = (r: Row): number | null => {
  const raw = (r.thstrm_add_amount ?? '').trim() || (r.thstrm_amount ?? '').trim();
  if (!raw || raw === '-') return null;

  const n = Number(raw.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

type FetchFn = (url: string, init?: RequestInit, timeoutMs?: number) => Promise<Response>;

export type DartReport = { filing: FsFiling; values: Sec6kValues };

/** 该期还没到(DART 返回 013)—— 正常状态,不是故障。 */
export class DartNoData extends Error {}

/**
 * 拉一份报告并抽出四科目(**韩元原值**,不缩放 —— 下游 deriveSeries 按基础货币单位除 1e6)。
 * 任一科目缺失就抛:四个缺一个就算不出毛利率或 FCF,与其落一份残缺的不如让上层记 failed。
 */
export async function fetchDartReport(
  corpCode: string,
  year: number,
  report: (typeof REPORTS)[number],
  apiKey: string,
  doFetch: FetchFn = fetchWithTimeout,
): Promise<DartReport> {
  const params = new URLSearchParams({
    crtfc_key: apiKey,
    corp_code: corpCode,
    bsns_year: String(year),
    reprt_code: report.code,
    fs_div: 'CFS', // 合并口径。OFS(单独)不含子公司,和其它公司不可比
  });

  const res = await doFetch(`${URL}?${params}`);
  if (!res.ok) throw new Error(`DART ${year}/${report.code} → HTTP ${res.status}`);

  const body = (await res.json()) as Body;
  // 013 = 조회된 데이타가 없습니다(那期还没交),和真错误分开:上层据此停止往后拉。
  if (body.status === '013') throw new DartNoData(`DART ${year}/${report.code}: 该期尚无数据`);
  if (body.status !== '000') throw new Error(`DART ${year}/${report.code} → ${body.status} ${body.message}`);

  const rows = body.list ?? [];
  const values = Object.fromEntries(
    (Object.keys(ACCOUNT_IDS) as Array<keyof Sec6kValues>).map((concept) => {
      // 按链序取第一个命中且有值的 account_id(前缀换代时两档可能并存)。
      const hit = ACCOUNT_IDS[concept]
        .flatMap((id) => rows.filter((r) => r.account_id === id))
        .find((r) => cumulative(r) !== null);
      const v = hit ? cumulative(hit) : null;
      if (v === null) throw new Error(`DART ${year}/${report.code}: ${concept} 没取到(account_id 可能换了)`);

      // **只有 capex 取绝对值**:它在现金流量表里是流出(负数),库里统一存正值。
      // ⚠️ 其余三个科目**必须保留符号** —— 亏损年的累计 OCF 是负的(实测海力士 2023:
      // Q1 累计 −2.01조、H1 −0.69조)。一律 abs 会把它翻成正,再经 YTD 差分,
      // 单季 OCF 的符号与大小全错(2023Q2 会算成 −1.31 而真值是 +1.32),而且不报错。
      return [concept, concept === 'capex' ? Math.abs(v) : v];
    }),
  ) as Sec6kValues;

  // rcept_no(接收번호)前 8 位就是申报日 —— 拿它当 accn 与 filed,溯源指到那一份公示。
  const rcept = rows.find((r) => r.rcept_no)?.rcept_no ?? `${year}${report.code}`;
  const filed = /^\d{8}/.test(rcept)
    ? `${rcept.slice(0, 4)}-${rcept.slice(4, 6)}-${rcept.slice(6, 8)}`
    : `${year}-12-31`;

  return { filing: { accn: rcept, filed, periodEnd: `${year}-${report.monthDay}` }, values };
}

/**
 * 某个日期时,**法定上应该已经交出来的**最新期末。DART 是 T+45(分기/반기)/ T+90(사업보고서)。
 * 按法定期限判、不留余量:公司提前交了就该当天拿到。代价是从法定日到它真的出现之间,
 * 每轮多打 4 次 013 —— 对 20,000/日 的限额可以忽略。只用来决定「要不要拉」,不参与取值。
 */
export function latestExpectedPeriod(now: Date): { year: number; report: (typeof REPORTS)[number] } {
  const candidates = [-1, 0].flatMap((offset) =>
    REPORTS.map((report) => {
      const year = now.getUTCFullYear() + offset;
      const end = Date.parse(`${year}-${report.monthDay}T00:00:00Z`);
      const graceDays = report.code === '11011' ? 90 : 45; // 사업보고서 90 天,分기/반기 45 天
      return { year, report, due: end + graceDays * 86_400_000 };
    }),
  );

  // candidates 跨去年+今年共 8 档,去年 Q1 的到期日必然已过 → 一定非空。
  const due = candidates.filter((c) => c.due <= now.getTime()).sort((a, b) => a.due - b.due);
  return due.at(-1)!;
}
