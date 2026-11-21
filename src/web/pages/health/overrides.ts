// 「数据健康」的单条例外:默认门槛按频率给(shared/calc/freshness 的 DEFAULT_LAG),这里只放不合默认的那几条。
// 单独一张表、不往注册表加字段:健康检查是旁路功能,不动现有序列定义。
import type { LagRule } from '../../../shared/calc/freshness';
import type { SeriesKey } from '../../../shared/regimeSeries';

export type HealthOverride = {
  /** 改门槛:发布本来就慢 / 不规律的序列 */
  rule?: LagRule;
  /** 本来就会好几天不变的阶梯序列(政策利率、按月填的派生量、标记序列):跳过「末尾 5 点相同」检查 */
  flatOk?: true;
  /** 已知结构性缺口(换源才能修):照常显示最新日期,状态记「不判」 */
  skip?: true;
  /** 写在备注列的说明(为什么放宽 / 已知停更原因) */
  note?: string;
};

// 门槛按 2026-11-17 全量库回测定:过去两年每个工作日当「今天」按规则判一遍,看各序列误报多少天。
// 日本连休(新年 12-31~1-3、黄金周、秋分前后)常连停 3 个工作日,默认「落后 2 个算偏晚」两年误报 10 天
const JP_DAILY: HealthOverride = { rule: { late: 4, stale: 7 }, note: '日本连休常连停 3 个工作日' };

// 键限定为注册表里 /api/regime 的序列键:拼错编译期就报
const HEALTH_OVERRIDES: { [K in SeriesKey]?: HealthOverride } = {
  fedTargetUpper: { flatOk: true },
  fedTargetLower: { flatOk: true },
  iorb: { flatOk: true },
  // 两次议息之间 SOFR 定盘常连着好几天同一个数
  sofr: { flatOk: true },
  repoStress: { flatOk: true },
  repoUsage: { flatOk: true, note: '平时多为 0' },
  weekendFlag: { flatOk: true },
  oilRollCrack: { flatOk: true },
  oilRollBrentWti: { flatOk: true },
  // 拆借月均 − 存款挂牌:两腿都按月,日线上一个月内不变
  jpCallMinusDeposit: { flatOk: true, ...JP_DAILY },
  // 日本市场的日频序列(曲线那几档见下方 PATTERNS)
  jgbVix: JP_DAILY,
  mufg: JP_DAILY,
  jp2yMinusDeposit: JP_DAILY,
  jp2yMinusCall: JP_DAILY,
  jpReal10: JP_DAILY,
  jpNom10Jgbi: JP_DAILY,
  jpBei10: JP_DAILY,
  // DTCC 通胀掉期:一天不足 3 笔不出点,美国假日前后常连缺 2~3 天(两年回测最长 3)
  zcis1y: { rule: { late: 4, stale: 7 }, note: '成交少的日子不出点' },
  zcis2y: { rule: { late: 4, stale: 7 }, note: '成交少的日子不出点' },
  // 中島上智的模型估计:发布 2~4 个月一次、不规律(判停更看 GitHub commit,见 AGENTS.md)
  jpTp10Nakajima: { rule: { late: 70, stale: 110 }, note: '2~4 个月发一次' },
  jpExpShort10Nakajima: { rule: { late: 70, stale: 110 }, note: '2~4 个月发一次' },
  // IMF PortWatch 本身约滞后 5 天(AIS 推算后批量更新)
  hormuzTransits: { rule: { late: 7, stale: 10 }, note: '源滞后约 5 天' },
  hormuzTankers: { rule: { late: 7, stale: 10 }, note: '源滞后约 5 天' },
  // BOJ 存量贷款约定利率滞后约 2 个月才发(AGENTS.md「日本银行 统计 API」)
  jpLoanRateStock: { rule: { late: 130, stale: 160 }, note: '滞后约 2 个月发' },
  jpLoanDepositSpread: { rule: { late: 130, stale: 160 }, note: '跟存量贷款利率,滞后约 2 个月' },
  // KW 源(联储理事会)每周更新一次,周二前后补到上周五 → 更新前常落后 5~6 个工作日
  tp10Kw: { rule: { late: 7, stale: 12 }, note: '源每周更新一次' },
  expShort10Kw: { rule: { late: 7, stale: 12 }, note: '源每周更新一次' },
  // HLW 季频、日期记季初,发布再滞后一个多季度 → 新一期出来前常落后 230~250 天
  rstarHlwCurrent: { rule: { late: 260, stale: 330 }, note: '日期记季初,发布滞后一个多季度' },
  lProxyHlwT5yifr: { rule: { late: 260, stale: 330 }, note: '跟 HLW r*' },
  // aiChain KNOWN_GAPS['ORCL.cogs']:2011 后不报标准营业成本科目,库里只剩 2011 年前的旧行
  'fund:ORCL:gm': { skip: true, note: '已知缺口:2011 后不报标准营业成本,毛利率算不出' },
};

// 曲线 / CDS 这类非 regime 的 id 编译期查不了拼写,改由 overrides.test 核对每条规则至少对上一条注册表 id
export const PATTERNS: [RegExp, HealthOverride][] = [
  [/^jgb\d+y$/, JP_DAILY],
  // ICE BofA 利差只到 0.01、短端美债在两次议息之间常连 5 天同一个数:真实的不变,不是源停了
  [/^credit:/, { flatOk: true }],
  [/^ust(1m|3m)$/, { flatOk: true }],
  // DTCC 成交披露:有成交才有点。2026 下半年最长隔 2 个工作日,更早一年最长隔过 11 天
  [/^cds:SoftBank \(JPY\)$/, { rule: { late: 4, stale: 8 }, note: '成交稀,有成交才有点' }],
];

// 查表入口:页面拿的是注册表 id(普通字符串,含曲线 / 期权等非 regime 的),放宽成按字符串查
const BY_ID: Readonly<Record<string, HealthOverride | undefined>> = HEALTH_OVERRIDES;

/** 规则表与逐条表合并,逐条的优先。 */
export function healthOverride(id: string): HealthOverride | undefined {
  const matched = PATTERNS.filter(([re]) => re.test(id)).map(([, o]) => o);
  const own = BY_ID[id];
  if (!matched.length) return own;

  return Object.assign({}, ...matched, own);
}
