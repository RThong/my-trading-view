import { curveTab, regimeTab, type Perspective } from '../tabs';

export const JAPAN: Perspective = {
  id: 'japan',
  label: '日本',
  tabs: [
    regimeTab('jpy', '日元', 'jpy'),
    // MOF 周度跨境证券流(52 周累计):日元 carry 的资金流上游,周频、看年度波段,和日元那几格的日频价格分开放
    regimeTab('jp_flows', '资金流', 'jpFlows'),
    curveTab('jgb_curve', '收益曲线', 'jgb'),
    // 只看各期限水平:利差 pane 与 8306 蜡烛挪去了「银行」那格(银行业传导在那边读)。
    regimeTab('jgb_history', '期限走势', 'jgbHistory'),
    // 日本银行股:10Y 主变量 + 8306,下面是利润层的验证项(利差 / 存款贝塔)。挨着曲线两格放,方便对读期限。
    regimeTab('jp_banks', '银行', 'jpBanks'),
    // 通胀两格:已发生(CGPI 先行 + 新核心核心)+ 预期(短観企业物价预期 1 年后 / 5 年后):「银行」利差里靠预期的那一截能不能兑现,看日银会不会继续加。
    regimeTab('jp_inflation', '通胀', 'jpInflation'),
    regimeTab('jgb_vol', '日债波动率', 'jgbVol'),
    // 产能面(日银试算,季度更新)。放日本视角最后一格:前面几格是市场怎么定价,这格是产能够不够 ——
    // BOJ 加息叙事的前提在这里,和曲线/日元那几格配读。
    regimeTab('jp_output_gap', '产出缺口', 'jpGap'),
    // 长端分解(中島上智模型)。对称利率视角同名那格,但只有一套模型 —— 读法差异写在两格 desc 里。
    regimeTab('jp_term_premium', '长端分解', 'jpTermPremium'),
  ],
};
