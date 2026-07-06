import { describe, expect, it } from 'bun:test';
import { parsePensfordXml } from './pensford';

const SAMPLE = `<TFCrecords timeStamp="07/03/2026 06:00:01 PM">
  <record><symbol>SOFR</symbol><desc>SOFR</desc><quoteDate>07/03/2026</quoteDate><quote>0.0366</quote><change>0</change></record>
  <record><symbol>SOFRSWAP Y5</symbol><desc>SOFR Swap 5-Year</desc><quoteDate>07/03/2026</quoteDate><quote>0.039389</quote><change>0</change></record>
  <record><symbol>FF2_Comdty</symbol><desc>2nd Fed Funds Future</desc><quoteDate>07/03/2026</quoteDate><quote>96.315000</quote><change>0</change></record>
</TFCrecords>`;

describe('parsePensfordXml', () => {
  const snap = parsePensfordXml(SAMPLE);
  it('把 timeStamp 归一成 YYYY-MM-DD', () => expect(snap.quoteDate).toBe('2026-07-03'));
  it('抓到全部记录', () => expect(snap.quotes.length).toBe(3));
  it('symbol 原样、value 转数字', () => {
    expect(snap.quotes.find((q) => q.symbol === 'SOFRSWAP Y5')?.value).toBe(0.039389);
    expect(snap.quotes.find((q) => q.symbol === 'FF2_Comdty')?.value).toBe(96.315);
  });
  it('日期按美式 MM/DD/YYYY 解析(月日不对称验证方向)', () => {
    const xml = `<TFCrecords timeStamp="01/15/2026 06:00:01 PM"><record><symbol>SOFR</symbol><quoteDate>01/15/2026</quoteDate><quote>0.03</quote></record></TFCrecords>`;
    expect(parsePensfordXml(xml).quoteDate).toBe('2026-01-15');
  });
  it('畸形记录(缺 symbol 或 quote)被跳过', () => {
    const xml = `<TFCrecords timeStamp="01/15/2026 06:00:01 PM"><record><quote>0.03</quote></record><record><symbol>SOFR</symbol><quote>0.03</quote></record></TFCrecords>`;
    expect(parsePensfordXml(xml).quotes.map((q) => q.symbol)).toEqual(['SOFR']);
  });
  it('无 timeStamp 抛错', () => {
    expect(() => parsePensfordXml('<TFCrecords></TFCrecords>')).toThrow();
  });
});
