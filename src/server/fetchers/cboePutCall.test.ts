import { test, expect } from 'bun:test';
import { parsePutCallPage } from './cboePutCall';

// 页面载荷的形状:JSON 嵌在 self.__next_f.push 的字符串里,引号转义成 \"(2026-11-05 实抓的那几段)
function esc(s: string) {
  return s.replaceAll('"', '\\"');
}
function page(options: string) {
  return `<script>self.__next_f.push([1,"25:${esc(`{"data":{"optionsData":${options},"selectedDate":"2026-11-05"}}`)}"])</script>`;
}
function vol(call: number, put: number) {
  return `[{"name":"VOLUME","call":${call},"put":${put},"total":${call + put}}]`;
}
const DAY = `{"ratios":[{"name":"EQUITY PUT/CALL RATIO","value":"0.89"}],"SUM OF ALL PRODUCTS":${vol(10589764, 11225416)},"INDEX OPTIONS":${vol(5855427, 6267449)},"EQUITY OPTIONS":${vol(2719490, 2430016)}}`;

test('parsePutCallPage:按版块取成交量(不取页面上 2 位小数的比值)', () => {
  expect(parsePutCallPage(page(DAY))).toEqual({
    equity: { call: 2719490, put: 2430016 },
    index: { call: 5855427, put: 6267449 },
    total: { call: 10589764, put: 11225416 },
  });
});

test('parsePutCallPage:没数据的日子(周末 / 假日 / 还没发布)= null', () => {
  expect(parsePutCallPage(page('null'))).toBeNull();
});

test('parsePutCallPage:临时休市日(个股成交为 0、只有指数零星成交)也当没数据', () => {
  const closed = `{"SUM OF ALL PRODUCTS":${vol(12027, 20786)},"INDEX OPTIONS":${vol(12027, 20786)},"EQUITY OPTIONS":${vol(0, 0)}}`;
  expect(parsePutCallPage(page(closed))).toBeNull();
});

test('parsePutCallPage:结构认不出就抛错,不当成「今天没数」', () => {
  expect(() => parsePutCallPage('<html>改版了</html>')).toThrow('optionsData');
  expect(() => parsePutCallPage(page(DAY.replace('"INDEX OPTIONS"', '"INDEX"')))).toThrow('INDEX OPTIONS');
});
