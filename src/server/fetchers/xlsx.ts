// xlsx(= zip + XML)的最小读法。原在 nyfedRstar 里,接日银产出缺口时第二个消费者出现 → 抽出来。
//
// **刻意不引 SheetJS 之类的库**:这两个源要的只是「按表名拿到 sheet XML」和「共享字符串表」,
// 单元格解析各自按列写正则更精确(见各 fetcher 里的注释:按列号取会静默画错线)。
import { unzipSync, strFromU8 } from 'fflate';

/**
 * 按**工作表名**解出它在 zip 里的路径。
 *
 * ⚠️ 不能直接写死 `sheet2.xml`:zip 里的 sheetN 编号与工作簿的表顺序无绑定关系,官方在前面
 * 插一张表,`sheet2.xml` 就成了别的表 —— 而那种表照样可能「A 列是数值、K 列也是数值」,
 * 于是静默产出错误的数,不报错。按名字解 → 改版时是「找不到」抛错,不是悄悄画错线。
 */
export function resolveSheetPath(workbookXml: string, relsXml: string, name: string): string | null {
  const rid = new RegExp(`<sheet[^>]*\\bname="${name}"[^>]*\\br:id="([^"]+)"`).exec(workbookXml)?.[1];
  if (!rid) return null;

  const target = new RegExp(`<Relationship[^>]*\\bId="${rid}"[^>]*\\bTarget="([^"]+)"`).exec(relsXml)?.[1];
  if (!target) return null;

  // Target 多为相对 workbook.xml 的 'worksheets/sheetN.xml';偶见绝对 '/xl/...'。
  return target.startsWith('/') ? target.slice(1) : `xl/${target}`;
}

/**
 * 共享字符串表(`t="s"` 的单元格存的是这张表的下标)。
 *
 * ⚠️ 先剥 `<rPh>`:日文表的 `<si>` 里嵌着注音(furigana),它也是 `<t>`。不剥的话
 * 「需給ギャップ」会读成「需給ギャップジュキュウ」—— 按名字匹配表头时对不上,却不报错。
 */
export function parseSharedStrings(xml: string): string[] {
  return [...xml.matchAll(/<si>(.*?)<\/si>/gs)].map(([, si]) =>
    [...si.replace(/<rPh[^>]*>.*?<\/rPh>/gs, '').matchAll(/<t[^>]*>(.*?)<\/t>/gs)].map((m) => m[1]).join(''),
  );
}

/** 解开 xlsx:`sheet(名)` 拿工作表 XML(找不到返回 null),`sharedStrings()` 拿共享字符串表。 */
export function openXlsx(buf: ArrayBuffer) {
  const files = unzipSync(new Uint8Array(buf));
  const read = (p: string) => (files[p] ? strFromU8(files[p]) : null);
  const workbook = read('xl/workbook.xml');
  const rels = read('xl/_rels/workbook.xml.rels');

  return {
    sheet: (name: string) => {
      const path = workbook && rels ? resolveSheetPath(workbook, rels, name) : null;
      return path ? read(path) : null;
    },
    sharedStrings: () => parseSharedStrings(read('xl/sharedStrings.xml') ?? ''),
  };
}
