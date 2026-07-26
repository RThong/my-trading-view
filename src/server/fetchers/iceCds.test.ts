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

  it('只留名单内 + SNRFOR + USD + 100bp 票息', () => {
    const tickers = snap.points.map((p) => p.ticker).sort();
    expect(tickers).toEqual(['APLINC', 'DELLN', 'MSFT', 'ORCLE']); // ABBVINC/AAUK 被滤掉
  });

  it('同名多到期取最长(on-the-run 5Y)', () => {
    expect(snap.points.find((p) => p.ticker === 'MSFT')!.price).toBeCloseTo(102.1425, 4); // 非 2027 的 100.0
  });

  it('Dell 取 100bp 档不取 500bp 档', () => {
    expect(snap.points.find((p) => p.ticker === 'DELLN')!.price).toBeCloseTo(101.3174, 4);
  });
});

// 换算锚点:对齐市场公开报道(Oracle ~200bp 史上最阔,Apple ~30-40bp 铁底)。
describe('cdsPriceToSpreadBp', () => {
  it('平价 100 → 票息 100bp', () => expect(cdsPriceToSpreadBp(100)).toBeCloseTo(100, 6));
  it('Oracle 95.26 → ~201bp(校准到市场值)', () => expect(cdsPriceToSpreadBp(95.2609)).toBeCloseTo(201, 0));
  it('Apple 102.89 → ~38bp(校准到市场值)', () => expect(cdsPriceToSpreadBp(102.8879)).toBeCloseTo(39, 0));
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
