import { curveTab, regimeTab, type Perspective } from '../tabs';
import { PolicyPathPanel } from './PolicyPathPanel';

export const RATES: Perspective = {
  id: 'rates',
  label: '利率',
  tabs: [
    curveTab('treasury', '收益曲线', 'treasury'),
    // 挂 BTC 现货当对照:它是流动性链条最末端、beta 最高的那个,曲线松紧的传导在它身上最先见效。
    // 两格差值:10Y − 1Y 读政策松紧,30Y − 10Y 读超长端的久期索价。
    regimeTab('tenor_history', '期限走势', 'ustHistory'),
    curveTab('sofr_ois', 'SOFR OIS', 'sofr_ois'),
    regimeTab('ois_history', 'OIS 走势', 'oisHistory'),
    // 加息定价:OIS 远期 vs 当前政策利率 / 点阵图(快照)+ 累计计入次数的逐日走势(带 CPI / PCE 发布日竖线)。
    { id: 'policy_path', label: '加息定价', render: () => <PolicyPathPanel /> },
    regimeTab('policy_repricing', '定价走势', 'policyRepricing'),
    regimeTab('rates_vol', '利率波动率', 'ratesVol'),
    // 长端分解三件套。名义在「收益曲线 / 期限走势」,通胀那一块在「通胀」视角的 BEI 两格,
    // 剩下的实际腿与期限溢价腿放这里 —— 长端上行时靠这几格分「动的是通胀还是实际利率」。
    curveTab('real_curve', '实际收益率', 'real'),
    // 30Y − 10Y:实际曲线自身的长端陡峭度。剥掉通胀后,这条走阔就是久期风险补偿在抬。
    regimeTab('real_history', '实际走势', 'realHistory'),
    regimeTab('rates_decomp', '长端分解', 'ratesDecomp'),
  ],
};
