import { describe, expect, test } from 'bun:test';
import { labelToIso, readRows, parseBojGap } from './bojOutputGap';

describe('labelToIso', () => {
  test('data1 的日历季度标签 → 季末', () => {
    expect(labelToIso('1983.1Q')).toBe('1983-03-31');
    expect(labelToIso('2026.1Q')).toBe('2026-03-31');
    expect(labelToIso('2025.4Q')).toBe('2025-12-31');
  });

  // data2 是财年半期,标签里有两个季度;取**最后一个** = 半期末。
  // 取第一个的话 2025 下半期会落成 2025-12-31、与 data1 的 2025.4Q 撞在同一天 —— 两张表就被悄悄对齐了。
  test('data2 的半期标签 → 区间末那一季的季末', () => {
    expect(labelToIso('1983.1 : 1983.2Q-1983.3Q')).toBe('1983-09-30');
    expect(labelToIso('2025.2 : 2025.4Q-2026.1Q')).toBe('2026-03-31');
  });

  test('表头 / 说明文字 → null', () => {
    expect(labelToIso('四半期')).toBeNull();
    expect(labelToIso('FY, semi-annual')).toBeNull();
    expect(labelToIso('2026.5Q')).toBeNull(); // 季号越界不当成日期
  });
});

// 官方 sheet 的真实形状:A 列是共享字符串,数值列内联;待发布行只有短观 DI(E 列)。
const shared = ['需給ギャップ', '2025.4Q', '2026.1Q', '2026.2Q', '2025.2 : 2025.4Q-2026.1Q'];
const quarterly =
  `<worksheet><sheetData>` +
  `<row r="2"><c r="A2" t="s"><v>0</v></c><c r="B2" t="s"><v>0</v></c></row>` + // 表头:A 是字符串但不是日期
  `<row r="177"><c r="A177" t="s"><v>1</v></c><c r="B177"><v>0.573</v></c><c r="E177"><v>-22.4</v></c></row>` +
  `<row r="178"><c r="A178" t="s"><v>2</v></c><c r="B178"><v>0.534</v></c><c r="E178"><v>-22.4</v></c></row>` +
  // 待发布行:GDP 还没出,B 空 —— 但短观 DI 有值。按行号取末行会拿到它。
  `<row r="179"><c r="A179" t="s"><v>3</v></c><c r="B179"/><c r="E179"><v>-22.3</v></c></row>` +
  `<row r="180"><c r="A180" s="4"/></row>` + // 空行
  `</sheetData></worksheet>`;
const semiannual =
  `<worksheet><sheetData>` +
  `<row r="5"><c r="A5" t="s"><v>0</v></c></row>` +
  `<row r="91"><c r="A91" t="s"><v>4</v></c><c r="B91"><v>0.691</v></c><c r="C91"><v>0.64</v></c>` +
  `<c r="D91"><v>0.138</v></c><c r="E91"><v>-0.337</v></c><c r="F91"><v>0.25</v></c></row>` +
  `</sheetData></worksheet>`;

describe('readRows', () => {
  test('跳表头 / 空行,且**丢掉总量列为空的待发布行**', () =>
    expect(readRows(quarterly, shared, ['B'], '1994-01-01')).toEqual([
      { date: '2025-12-31', values: [0.573] },
      { date: '2026-03-31', values: [0.534] },
    ]));

  // 写入器换了就会冒出显式 t="n"。只认「无 t」的话整列读不到,而症状(抛「一行都没解析出」)
  // 会把人指向「行标签格式改版」这个假因 —— 白名单一行,省掉那趟弯路。
  test('显式 t="n" 照样是数值,其它 t 仍排掉', () => {
    const typed = quarterly
      .replace('<c r="B177">', '<c r="B177" t="n">')
      .replace('<c r="B178"><v>0.534</v>', '<c r="B178" t="str"><v>0.534</v>');
    expect(readRows(typed, shared, ['B'], '1994-01-01')).toEqual([{ date: '2025-12-31', values: [0.573] }]);
  });

  test('since 过滤', () =>
    expect(readRows(quarterly, shared, ['B'], '2026-01-01').map((r) => r.date)).toEqual(['2026-03-31']));

  // 取错列 = 画出一条量级差 40 倍、却不报错的线(E 是短观 DI,−22 那个尺)。
  test('不会把短观 DI(E 列)当成缺口', () => {
    const vals = readRows(quarterly, shared, ['B'], '1994-01-01').flatMap((r) => r.values);
    expect(vals).not.toContain(-22.4);
  });
});

describe('parseBojGap', () => {
  const out = parseBojGap(quarterly, semiannual, shared, '1994-01-01');

  test('六条序列各归各位', () => {
    expect(out.outputGap.at(-1)).toEqual({ date: '2026-03-31', value: 0.534 });
    expect(out.potentialGrowth).toEqual([{ date: '2026-03-31', value: 0.691 }]);
    expect(out.potHours).toEqual([{ date: '2026-03-31', value: -0.337 }]);
  });

  test('四项贡献度相加 ≈ 潜在增速', () => {
    const sum = [out.potTfp, out.potCapital, out.potHours, out.potWorkers].reduce((a, s) => a + s[0].value, 0);
    expect(sum).toBeCloseTo(out.potentialGrowth[0].value, 3);
  });

  // 季度表与半期表**不共用时间轴**:同一天出现在两条里是巧合(2026.1Q 与 2025 下半期都落 3/31),
  // 不构成对齐关系。这里只钉住「两条各自独立解析」,别把它们 join 起来用。
  test('两张表哪张解不出都抛错(表结构改版比「暂时没数据」更可能)', () => {
    expect(() => parseBojGap('<worksheet/>', semiannual, shared, '1994-01-01')).toThrow();
    expect(() => parseBojGap(quarterly, '<worksheet/>', shared, '1994-01-01')).toThrow();
  });
});
