import { describe, expect, it } from 'bun:test';
import { parseIceCds } from './iceCds';
import { cdsPriceToSpreadBp, missingCoreCds } from '../analytics/rateCurves';

// 真实端点样本(截断):含目标名、不同货币/票息干扰项、名单外实体、同名多到期。
const SAMPLE = [
  {
    clearingDate: '2026-07-24',
    name: 'Oracle Cop',
    instrumentName: 'ORCLE.SNRFOR.USD.XR14.100.2031-06-20',
    eodPrice: '95.2609',
  },
  {
    clearingDate: '2026-07-24',
    name: 'Apple Inc.',
    instrumentName: 'APLINC.SNRFOR.USD.XR14.100.2031-06-20',
    eodPrice: '102.8879',
  },
  // 干扰:同名 500bp 票息档 → 不取(coupon !== '100')
  {
    clearingDate: '2026-07-24',
    name: 'Dell Inc',
    instrumentName: 'DELLN.SNRFOR.USD.XR14.500.2031-06-20',
    eodPrice: '118.9287',
  },
  {
    clearingDate: '2026-07-24',
    name: 'Dell Inc',
    instrumentName: 'DELLN.SNRFOR.USD.XR14.100.2031-06-20',
    eodPrice: '101.3174',
  },
  // 高收益名只挂 500bp 档:按名单配置取 500(不被默认 100 档规则滤掉)
  {
    clearingDate: '2026-07-24',
    name: 'COREWEAVE INC',
    instrumentName: 'COREWEI.SNRFOR.USD.XR14.500.2031-12-20',
    eodPrice: '83.0764',
  },
  // 干扰:EUR 货币 → 不取
  {
    clearingDate: '2026-07-24',
    name: 'Anglo Amern plc',
    instrumentName: 'AAUK.SNRFOR.EUR.MM14.100.2031-06-20',
    eodPrice: '101.2074',
  },
  // 干扰:名单外实体
  {
    clearingDate: '2026-07-24',
    name: 'ABBVIE INC',
    instrumentName: 'ABBVINC.SNRFOR.USD.XR14.100.2031-06-20',
    eodPrice: '99.5',
  },
  // 同名多到期:取最长(on-the-run 5Y),不取短残留
  {
    clearingDate: '2026-07-24',
    name: 'Microsoft Corp',
    instrumentName: 'MSFT.SNRFOR.USD.XR14.100.2027-06-20',
    eodPrice: '100.0',
  },
  {
    clearingDate: '2026-07-24',
    name: 'Microsoft Corp',
    instrumentName: 'MSFT.SNRFOR.USD.XR14.100.2031-06-20',
    eodPrice: '102.1425',
  },
  // 缺价:空串 Number('')→0,不能伪装成有效价(否则 →约 2228bp 假数据),须滤掉
  {
    clearingDate: '2026-07-24',
    name: 'NVIDIA Corp',
    instrumentName: 'NVIDIA.SNRFOR.USD.XR14.100.2031-06-20',
    eodPrice: '',
  },
];

describe('parseIceCds', () => {
  const snap = parseIceCds(SAMPLE);

  it('date 取 clearingDate', () => expect(snap.date).toBe('2026-07-24'));

  it('缺价(空串→0)滤掉,不伪装成有效价', () => expect(snap.points.find((p) => p.ticker === 'NVIDIA')).toBeUndefined());

  it('只留名单内 + SNRFOR + USD + 该名配置的票息档', () => {
    const tickers = snap.points.map((p) => p.ticker).sort();
    expect(tickers).toEqual(['APLINC', 'COREWEI', 'DELLN', 'MSFT', 'ORCLE']); // ABBVINC/AAUK 被滤掉
  });

  it('同名多到期取最长(on-the-run 5Y)', () => {
    expect(snap.points.find((p) => p.ticker === 'MSFT')!.price).toBeCloseTo(102.1425, 4); // 非 2027 的 100.0
  });

  it('Dell 取 100bp 档不取 500bp 档', () => {
    expect(snap.points.find((p) => p.ticker === 'DELLN')!.price).toBeCloseTo(101.3174, 4);
  });
});

// 换算锚点:平价 = 票息;其余对齐同日市场公开报价(模型自身约 ±10~15bp,见 rateCurves 注释)。
describe('cdsPriceToSpreadBp', () => {
  it('平价 100 → 票息 100bp', () => expect(cdsPriceToSpreadBp(100)).toBeCloseTo(100, 3));
  it('500bp 档平价 → 500bp', () => expect(cdsPriceToSpreadBp(100, 500)).toBeCloseTo(500, 3));
  it('Oracle 95.26 → ~214bp(报价 ~200bp)', () => expect(cdsPriceToSpreadBp(95.2609)).toBeCloseTo(214, 0));
  it('Apple 102.89 → ~35bp(报价 ~39bp)', () => expect(cdsPriceToSpreadBp(102.8879)).toBeCloseTo(35, 0));
  // 2026-10-15 ICE 结算价 83.0764;同日报道收盘 ~1038bp(盘中峰值 1194.5)
  it('CoreWeave 83.08 → ~1053bp', () => expect(cdsPriceToSpreadBp(83.0764, 500)).toBeCloseTo(1053, 0));
  // 2026-10-20 ICE 结算价 94.7560;FT 同日报「创纪录 226bp」
  it('SpaceX 94.76 → ~227bp', () => expect(cdsPriceToSpreadBp(94.756)).toBeCloseTo(226.6, 0));
  // annuity 4.7 线性近似在这里只有 ~1138:风险久期随违约强度缩短,困境区必须非线性
  it('困境区不被压低:价 70 → >1700bp', () => expect(cdsPriceToSpreadBp(70, 500)).toBeGreaterThan(1700));
  it('深困境区不被上界截断:价 42 → ~21960bp', () => expect(cdsPriceToSpreadBp(42, 500)).toBeCloseTo(21960, -1));
  it('价 ≤ 回收价 40 → 无解 NaN', () => expect(cdsPriceToSpreadBp(40, 500)).toBeNaN());
  it('价高于 s=0 理论价(负 spread)→ 无解 NaN', () => expect(cdsPriceToSpreadBp(105)).toBeNaN());
});

describe('missingCoreCds', () => {
  const all = new Set(['ORCLE', 'MSFT', 'ALPHINC', 'AMZN', 'APLINC', 'NVIDIA', 'BROINC', 'DELLN', 'INTC', 'METAPL']);

  it('core 齐 → 空', () => expect(missingCoreCds(all)).toEqual([]));
  it('缺 core(Oracle)→ 报显示名', () => {
    const got = new Set([...all].filter((t) => t !== 'ORCLE'));
    expect(missingCoreCds(got)).toEqual(['Oracle']);
  });
  it('只缺非 core(Broadcom/Dell/Intel)→ 空(容忍)', () => {
    const got = new Set([...all].filter((t) => !['BROINC', 'DELLN', 'INTC'].includes(t)));
    expect(missingCoreCds(got)).toEqual([]);
  });
});
