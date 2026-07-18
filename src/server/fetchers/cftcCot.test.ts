import { describe, expect, it } from 'bun:test';
import { cotToNet } from './cftcCot';

describe('cotToNet', () => {
  it('net = 多 − 空,日期取 ISO,升序', () => {
    const rows = [
      {
        report_date_as_yyyy_mm_dd: '2026-07-07T00:00:00.000',
        noncomm_positions_long_all: '112247',
        noncomm_positions_short_all: '236025',
      },
      {
        report_date_as_yyyy_mm_dd: '2020-01-07T00:00:00.000',
        noncomm_positions_long_all: '50000',
        noncomm_positions_short_all: '30000',
      },
    ];
    const out = cotToNet(rows);
    expect(out.map((p) => p.date)).toEqual(['2020-01-07', '2026-07-07']); // 升序
    expect(out[0]).toEqual({ date: '2020-01-07', value: 20000 });
    expect(out[1].value).toBe(112247 - 236025); // -123778
  });
});
