// 半导体恐贪指数面板的数据层:取数 + 子指标配置 + 恐贪档位。
// 数据已是 0-100 分数(server 归一好),前端只负责取数与展示(见 SoxFngPanel)。
import useSWR from 'swr';

export type FngPoint = { date: string; value: number };
// series = 0-100 归一分(徽标/复合);raw = 原生值(比率/波动率,画图用);momLines = 动量图的价+均线。
export type SoxFngData = {
  series: Record<string, FngPoint[]>;
  raw: Record<string, FngPoint[]>;
  momLines: { price: FngPoint[]; ma: FngPoint[] };
};

const NO_DATA: SoxFngData = { series: {}, raw: {}, momLines: { price: [], ma: [] } };
const SWR_OPTS = { revalidateOnFocus: false, revalidateIfStale: false, revalidateOnReconnect: false };

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(String(r.status));
  return r.json() as Promise<T>;
}

export function useSoxFngData() {
  const { data = NO_DATA, error, isLoading } = useSWR('/api/sox-fng', getJson<SoxFngData>, SWR_OPTS);
  return { data, error: error as Error | undefined, isLoading };
}

// 恐贪五档(沿用 CNN 阈值);color 用于徽标/hero 指针,深色底下的高饱和度。
export type Band = { label: string; color: string };
const BANDS: { max: number; band: Band }[] = [
  { max: 25, band: { label: '极度恐惧', color: '#dc2626' } },
  { max: 45, band: { label: '恐惧', color: '#f97316' } },
  { max: 55, band: { label: '中性', color: '#eab308' } },
  { max: 75, band: { label: '贪婪', color: '#84cc16' } },
  { max: 101, band: { label: '极度贪婪', color: '#22c55e' } },
];
export function bandOf(v: number): Band {
  return (BANDS.find((b) => v <= b.max) ?? BANDS[BANDS.length - 1]).band;
}

// 一条 = 一个子指标(复合指数 index 打头);label 段标题、title 副标题、desc 右侧介绍。顺序即展示顺序。
// unit:图表/数值格式 —— pct=分数按 % 显示(默认),ratio=比率按原值(如 put/call 1.79)。
export type PaneCfg = { key: string; label: string; title: string; desc: string; unit?: 'pct' | 'ratio' };
export const SOX_FNG_PANES: PaneCfg[] = [
  {
    key: 'index',
    label: '温度计',
    title: '半导体风险情绪温度计',
    desc: '定义:半导体板块风险情绪温度计(0-100),CNN 恐贪法移植到 SOXX。粗略情绪读数,非精确心理测量,非交易信号。\n6 个子指标(动量/新高低/广度/put-call/波动/避险)各归一 0-100 等权平均。\n<25 = 相对偏冷(极度恐惧端);>75 = 相对偏热(极度贪婪端)。',
  },
  {
    key: 'mom',
    label: '动量',
    title: '动量 (SOXX vs 125日均线)',
    desc: '定义:SOXX 相对自身 125 日均线的位置,取滚动一年百分位。\n高 = 价在均线上方越走越强(贪);低 = 跌破/走弱(恐)。',
  },
  {
    key: 'hl',
    label: '新高低',
    title: '52周新高低 (成分股广度)',
    desc: '定义:25 只成分股里创 52 周新高数 − 新低数,占有效数比例,取百分位。\n高 = 多数个股跟得上(健康贪);低 = 领涨面塌(恐)。',
  },
  {
    key: 'breadth',
    label: '广度',
    title: '涨跌成交量广度',
    desc: '定义:成分股上涨量 − 下跌量,占总量比例,取百分位。\n高 = 资金站在上涨方(贪);低 = 抛压主导(恐)。',
  },
  {
    key: 'vol',
    label: '波动',
    title: '波动 (SOXX 20日已实现波动,已反向)',
    desc: '定义:SOXX 20 日已实现波动(年化),取百分位后**反向**(高波动=恐慌 → 低分)。\n高分 = 平静(贪);低分 = 波动爆炸(恐)。',
  },
  {
    key: 'safe',
    label: '避险',
    title: '避险需求 (SOXX − IEF 20日收益)',
    desc: '定义:SOXX 20 日收益 − IEF(7-10年国债)20 日收益,取百分位。\n高 = 股跑赢债、追风险(贪);低 = 钱躲进国债(恐)。',
  },
  {
    key: 'putcall',
    label: '看跌看涨',
    title: 'put/call 量比 (SOXX 期权)',
    unit: 'ratio',
    desc: '定义:SOXX 当日看跌/看涨期权成交量比(~30 天到期)。暂以 1.0 作启发式中性点(越高越恐、越低越贪),未经 SOXX 历史校准,故首日即可参与复合。\n>1 = 买看跌多于看涨(偏冷);<1 = 看涨占优(偏热)。\n注:单日单到期日成交量,噪声偏大;中性点与斜率待几个月数据校准。',
  },
];
