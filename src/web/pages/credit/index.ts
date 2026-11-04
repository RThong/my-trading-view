import { curveTab, regimeTab, type Perspective } from '../tabs';

// 信用三 tab:利差走势(日频时间序列)+ 评级利差 / 期限结构(两条截面曲线,AI CDS 在「AI」视角)。
export const CREDIT: Perspective = {
  id: 'credit',
  label: '信用',
  tabs: [
    regimeTab('credit', '利差走势', 'credit'),
    curveTab('credit_rating', '评级利差', 'credit_rating'),
    curveTab('credit_term', '期限结构', 'credit_term'),
  ],
};
