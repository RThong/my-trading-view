import { curveTab, regimeTab, type Perspective } from '../tabs';

// 信用五 tab:利差走势(日频时间序列)+ 评级走势(按评级的时间序列,看压力是否从 CCC 往上扩散)
// + 评级利差 / 期限结构(两条截面曲线,AI CDS 在「AI」视角)+ 杠杆(美股融资余额:利差是借钱多贵,这格是借了多少)。
export const CREDIT: Perspective = {
  id: 'credit',
  label: '信用',
  tabs: [
    regimeTab('credit', '利差走势', 'credit'),
    regimeTab('credit_by_rating', '评级走势', 'creditRating'),
    curveTab('credit_rating', '评级利差', 'credit_rating'),
    curveTab('credit_term', '期限结构', 'credit_term'),
    regimeTab('credit_leverage', '杠杆', 'leverage'),
  ],
};
