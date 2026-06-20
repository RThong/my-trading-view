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
  isMock: boolean;
};
