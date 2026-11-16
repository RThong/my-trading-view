// 「数据健康」的单条例外:默认门槛按频率给(shared/calc/freshness 的 DEFAULT_LAG),这里只放不合默认的那几条。
// 单独一张表、不往注册表加字段:健康检查是旁路功能,不动现有序列定义。
import type { LagRule } from '../../../shared/calc/freshness';

export type HealthOverride = {
  /** 改门槛:发布本来就慢 / 不规律的序列 */
  rule?: LagRule;
  /** 本来就会好几天不变的阶梯序列(政策利率、按月填的派生量、标记序列):跳过「末尾 5 点相同」检查 */
  flatOk?: true;
  /** 写在备注列的说明(为什么放宽 / 已知停更原因) */
  note?: string;
};

export const HEALTH_OVERRIDES: Record<string, HealthOverride> = {
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
  jpCallMinusDeposit: { flatOk: true },
  // 中島上智的模型估计:发布 2~4 个月一次、不规律(判停更看 GitHub commit,见 AGENTS.md)
  jpTp10Nakajima: { rule: { late: 70, stale: 110 }, note: '2~4 个月发一次' },
  jpExpShort10Nakajima: { rule: { late: 70, stale: 110 }, note: '2~4 个月发一次' },
  // IMF PortWatch 本身约滞后 5 天(AIS 推算后批量更新)
  hormuzTransits: { rule: { late: 7, stale: 10 }, note: '源滞后约 5 天' },
  hormuzTankers: { rule: { late: 7, stale: 10 }, note: '源滞后约 5 天' },
  // BOJ 存量贷款约定利率滞后约 2 个月才发(AGENTS.md「日本银行 统计 API」)
  jpLoanRateStock: { rule: { late: 130, stale: 160 }, note: '滞后约 2 个月发' },
  jpLoanDepositSpread: { rule: { late: 130, stale: 160 }, note: '跟存量贷款利率,滞后约 2 个月' },
};
