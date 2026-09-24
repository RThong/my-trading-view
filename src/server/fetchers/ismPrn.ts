/**
 * ISM PMI(制造业 / 服务业月报),经 **PR Newswire** 全文取数。
 *
 * 为什么不是 ISM 官网:ismworld.org 的 Report On Business 页全部跳 SSO,SSO 页是一个
 * **reCAPTCHA v3 自动提交表单** —— 脚本拉不到,也不该绕。FRED 2016 年起没有 ISM;
 * DBnomics 虽有 `ISM` provider,但停更在 2026-01,且那个数据集里的序列不是头条 PMI。
 * PR Newswire 是 ISM 自己的官方分发渠道,每月全文(头条 + 全部分项 + 表格)公开可读。
 *
 * 取数方式:
 *  1. newsroom 列表页(按发布时间倒序)里按 slug 认出月报 URL;
 *  2. 单篇里取 **「AT A GLANCE」那张表**,按行首标签取头条与 Prices 两行 —— 不按行号,
 *     分项顺序历年有调整;不从正文句子里抠数,正文措辞每月都在变。
 *
 * ⚠️ 2020 年前服务业叫 Non-Manufacturing(NMI®),slug 是 `nmi-at-…`、头条行标签是 `NMI® /PMI®`;
 *    制造业旧版头条行叫 `PMI®`、新版叫 `Manufacturing PMI®`。两代都要认。
 * ⚠️ 服务业那张表**右半边是制造业的对照列**(同一行 10 格:服务业 5 格 + 制造业 5 格),
 *    只取前两格数值,别取到制造业那半。
 */
import { fetchWithTimeout } from './http';

export type IsmSector = 'mfg' | 'svc';

/** 一篇月报解析出的东西:当月与上月各一对(头条 PMI, Prices)。 */
export type IsmRelease = {
  sector: IsmSector;
  /** 报告月,`YYYY-MM-01`(与 FRED 月频序列同一个日期约定) */
  month: string;
  prevMonth: string;
  pmi: { cur: number; prev: number };
  prices: { cur: number; prev: number };
};

const NEWSROOM = 'https://www.prnewswire.com/news/institute-for-supply-management/';
const BASE = 'https://www.prnewswire.com';
// PRN 对非浏览器 UA 照常返回,但带上它省得哪天被按 UA 挡掉。
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' };

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

/**
 * 月报 slug 白名单:`(manufacturing-|services-)?(pmi|nmi)-at-<头条>`,外加改名那一篇的特例。
 * 例:`manufacturing-pmi-at-54-6-august-2026-…`、`services-pmi-at-55-4-…`、
 *     旧版 `pmi-at-591-january-manufacturing-…`、`nmi-at-599-january-non-manufacturing-…`、
 *     2020-07 改名当月 `services-pmi-formerly-non-manufacturing-nmi-at-58-1`。
 *
 * ⚠️ **必须是白名单,不能放宽成「任意位置出现 `pmi-at-`」**:ISM 在同一个 newsroom 还发
 * **Hospital PMI**(`hospital-pmi-at-…`,存档里 80 多篇),放宽就会把医院的数吸进来。
 * 年度季节因子调整、研讨会、奖项等非月报 slug 不含 `-at-`,本来就不会命中。
 */
const REPORT_SLUG = /^(?:(?:manufacturing|services)-)?(?:pmi|nmi)-at-|^services-pmi-formerly-non-manufacturing-nmi-at-/;

export type IsmCandidate = {
  path: string;
  /** 从 slug 能直接读出的(扇区, 报告月)。2020 年前的 slug 不带年份 → null,只能拉正文才知道。 */
  hint: { sector: IsmSector; month: string } | null;
};

/**
 * slug → (扇区, 报告月)。2020 年后的 slug 带年份,两种写法都有:
 * `…-august-2026-ism-manufacturing-pmi-report`、`…-january-2023-manufacturing-ism-report-on-business`。
 * ⚠️ hint 决定「跳不跳过拉正文」,读错扇区 = 那个月永远不会被拉 —— 所以只从 slug **开头**判扇区。
 */
export function hintFromSlug(slug: string): IsmCandidate['hint'] {
  const m =
    /-(january|february|march|april|may|june|july|august|september|october|november|december)-(\d{4})-(?:(?:non-manufacturing|manufacturing|services)-)?ism-/.exec(
      slug,
    );
  if (!m) return null;

  const sector: IsmSector = /^(?:services-|nmi-)/.test(slug) ? 'svc' : 'mfg';
  const month = `${m[2]}-${String(MONTHS.indexOf(m[1]) + 1).padStart(2, '0')}-01`;
  return { sector, month };
}

/** 列表页 HTML → 月报候选(去重,保持页面上的出现顺序 = 新 → 旧)。 */
export function parseNewsroom(html: string): IsmCandidate[] {
  const paths = [...html.matchAll(/\/news-releases\/([a-z0-9-]+)-\d{9}\.html/g)]
    .filter((m) => REPORT_SLUG.test(m[1]))
    .map((m) => ({ path: m[0], slug: m[1] }));

  return [...new Map(paths.map((p) => [p.path, p])).values()].map(({ path, slug }) => ({
    path,
    hint: hintFromSlug(slug),
  }));
}

const cellText = (s: string) =>
  s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&reg;|&#174;|®/g, '')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

const rowsOf = (table: string) =>
  [...table.matchAll(/<tr[\s\S]*?<\/tr>/g)].map((r) =>
    [...r[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => cellText(c[1])),
  );

const num = (s: string | undefined) => {
  const v = Number(s);
  // 扩散指数定义域就是 0~100;越界说明取错了列(比如取到了「变动」那格的 +1.3)。
  return Number.isFinite(v) && v >= 0 && v <= 100 && s !== '' ? v : null;
};

const shiftMonth = (month: string, by: number) => {
  const d = new Date(`${month}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + by);
  return d.toISOString().slice(0, 10);
};

/**
 * 单篇月报 HTML → 解析结果;认不出「AT A GLANCE」表 / 缺头条或 Prices 行 → null。
 * null 由调用方当「源结构变了」报出来,**不当成「这篇不是月报」静默跳过** ——
 * 候选已经按 slug 筛过,能走到这里的都应该是月报。
 */
export function parseIsmRelease(html: string): IsmRelease | null {
  const table = [...html.matchAll(/<table[\s\S]*?<\/table>/g)]
    .map((t) => rowsOf(t[0]))
    .find((rows) => /AT A GLANCE/i.test(rows[0]?.join(' ') ?? ''));
  if (!table) return null;

  // 报告月不一定在首行:2021~2023 那批的首行只有「MANUFACTURING AT A GLANCE」,「July 2023」在第二行。
  // 取前三行拼起来找;表头行的「Series Index Jul」是缩写且不带年份,不会误中。
  // ⚠️ 2020-10~2022-02 那批把年份拆进两个 span(`202</span><span>1`),去标签后成了「202 1」——
  // 只在标题里把数字间的空白粘回去;数据格不能这么做,会把相邻两个读数粘成一个。
  const title = table
    .slice(0, 3)
    .map((r) => r.join(' '))
    .join(' ')
    .replace(/(\d)\s+(?=\d)/g, '$1');
  const when =
    /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i.exec(title);
  if (!when) return null;

  // 服务业表的标题里也有 MANUFACTURING(「与制造业对照」),所以先判服务业。
  // ⚠️ 制造业要**明确命中**「MANUFACTURING AT A GLANCE」,不做兜底:认不出的表(比如哪天 Hospital
  // 那种版式混进来)宁可返回 null 报失败,也不能默认当成制造业写进库 —— 库没有删除路径。
  const sector: IsmSector | null = /NON-MANUFACTURING|SERVICES/i.test(title)
    ? 'svc'
    : /MANUFACTURING AT A GLANCE/i.test(title)
      ? 'mfg'
      : null;
  if (!sector) return null;
  const month = `${when[2]}-${String(MONTHS.indexOf(when[1].toLowerCase()) + 1).padStart(2, '0')}-01`;

  const headline = table.find((r) => /^(?:Manufacturing |Services )?(?:PMI|NMI)\b/.test(r[0] ?? ''));
  const prices = table.find((r) => r[0] === 'Prices');
  const pair = (r: string[] | undefined) => {
    const cur = num(r?.[1]);
    const prev = num(r?.[2]);
    return cur !== null && prev !== null ? { cur, prev } : null;
  };

  const pmiPair = pair(headline);
  const pricesPair = pair(prices);
  if (!pmiPair || !pricesPair) return null;

  return { sector, month, prevMonth: shiftMonth(month, -1), pmi: pmiPair, prices: pricesPair };
}

export function createIsmFetcher() {
  const getText = async (url: string) => {
    const r = await fetchWithTimeout(url, { headers: HEADERS });
    if (!r.ok) throw new Error(`PRN ${r.status} ${url}`);
    return r.text();
  };

  return {
    /** newsroom 第 page 页(1 起),每页 pageSize 条。 */
    listReleases: async (page: number, pageSize: number) =>
      parseNewsroom(await getText(`${NEWSROOM}?page=${page}&pagesize=${pageSize}`)),
    fetchRelease: async (path: string) => parseIsmRelease(await getText(`${BASE}${path}`)),
  };
}
