import { describe, expect, it } from 'bun:test';
import { cotToNet, tffToNetOi } from './cftcCot';

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

describe('tffToNetOi', () => {
  const row = (date: string, am: [string, string], lm: [string, string], oi: string) => ({
    report_date_as_yyyy_mm_dd: date,
    asset_mgr_positions_long: am[0],
    asset_mgr_positions_short: am[1],
    lev_money_positions_long: lm[0],
    lev_money_positions_short: lm[1],
    open_interest_all: oi,
  });

  it('净持仓归一化到 OI 的 %,两类各一条,升序', () => {
    const out = tffToNetOi([
      row('2026-09-08T00:00:00.000', ['52955', '90368'], ['91185', '114455'], '431671'),
      row('2020-01-07T00:00:00.000', ['30000', '20000'], ['10000', '40000'], '200000'),
    ]);

    expect(out.assetMgr.map((p) => p.date)).toEqual(['2020-01-07', '2026-09-08']); // 升序
    expect(out.assetMgr[0].value).toBeCloseTo(5, 10); // (30000−20000)/200000 = +5%
    expect(out.levMoney[0].value).toBeCloseTo(-15, 10); // (10000−40000)/200000 = −15%
    expect(out.assetMgr[1].value).toBeCloseTo(((52955 - 90368) / 431671) * 100, 10);
  });

  it('OI 为 0 / 缺失的行整行丢掉(否则净持仓占比是 Infinity)', () => {
    const out = tffToNetOi([
      row('2026-09-08T00:00:00.000', ['100', '200'], ['100', '200'], '0'),
      row('2026-09-01T00:00:00.000', ['100', '200'], ['100', '200'], undefined as unknown as string),
    ]);

    expect(out.assetMgr).toEqual([]);
    expect(out.levMoney).toEqual([]);
  });
});
