export type JobStatus = {
  name: string;
  status: 'success' | 'partial' | 'failed' | 'running';
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  error: string | null;
};

export type HealthResponse = {
  jobs: JobStatus[];
};

export type OptionIVPoint = {
  date: string;        // 格式 'YYYY-MM-DD'
  callIv: number;
  putIv: number;
  skew: number;
};

export type Position = {
  code: string;
  name: string;
  qty: number | null;
  costPrice: number | null;
  price: number | null;      // 现价
  marketVal: number | null;  // 市值(proto val)
  plVal: number | null;      // 浮动盈亏(proto plVal)
  plRatio: number | null;    // 盈亏比例(proto plRatio)
};

export type PositionsResponse = {
  accId: number;
  asOf: string;              // ISO 时间戳
  positions: Position[];
};
