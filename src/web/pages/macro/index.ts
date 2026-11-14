import { regimeTab, type Perspective } from '../tabs';

export const MACRO: Perspective = {
  id: 'macro',
  label: '宏观',
  tabs: [
    regimeTab('macro', '美元', 'macro'),
    regimeTab('ism', 'ISM 景气', 'ism'),
    // 就业:芝加哥联储 CFLMI 把失业拆成流入(离职)/ 流出(找到工作)两个流量,回答「少招人还是多裁人」
    regimeTab('labor', '就业', 'labor'),
  ],
};
