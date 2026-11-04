// 6-K 报表正文的解析原语(纯函数):HTML 扁平化,按行标签抽数字。
// 从 sec6k 拆出来是因为这是文本扫描计算,不是取数流程:逐词状态机允许用循环(见 biome.jsonc 的 no-loop 放行名单)。

/** HTML → 以 `|` 保留单元格边界的扁平文本。表格结构全靠这些竖线定位。 */
export function flattenHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, '|')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&#\d+;/g, ' ')
    .replace(/\|+/g, '|')
    .replace(/[ \t\r\n]+/g, ' ');
}

/**
 * 一个行标签和它的第一个数字之间最多隔几个单元格。表格里通常是 `标签|$|数字`(隔 1~2 格)。
 * **这个上限是必需的守卫**:没有它,标签匹配到散文时会一路扫到下一张表,把别人的数字当成
 * 自己的 —— 实测踩过:「Gross profit」先命中指引句「Gross profit margin is expected to be
 * between 65% and 67%」,然后扫到表格里 Net sales 的 1,270,381,算出 cogs = 0。
 */
const MAX_CELLS_TO_FIRST_NUMBER = 8;

/**
 * 从某个行标签起,顺序取前 n 个「数字单元格」的值。
 * 负号有**两种写法**,都得吃:`(350,762,799)` 与 `(628,052,531|)`(右括号被拆到下一格)。
 * 小数点也要吃:ASML 的报表是 `9,326.5` 这种一位小数。
 */
export function numsAfter(txt: string, label: string, n: number, from = 0): number[] {
  const i = txt.indexOf(label, from);
  if (i < 0) return [];

  const cells = txt.slice(i + label.length, i + label.length + 1500).split('|');
  const out: number[] = [];
  // 命令式:拿够 n 个就停,不把 1500 字窗口里的格子全分类一遍(每个标签、每份报表都要跑)
  for (let k = 0; k < cells.length && out.length < n; k++) {
    const c = cells[k].trim();
    if (!/^\(?[\d,]+(\.\d+)?\)?$/.test(c) || !/\d/.test(c)) continue;
    // 第一个数字离标签太远 = 这不是那一行,是标签撞进了散文里。宁可空着让上层抛。
    if (out.length === 0 && k > MAX_CELLS_TO_FIRST_NUMBER) return [];

    const neg = c.startsWith('(') || cells[k + 1]?.trim() === ')';
    out.push((neg ? -1 : 1) * Number(c.replace(/[(),]/g, '')));
  }
  return out;
}

/**
 * `numsAfter` 的**另一种表格编码**版本:数字和标签在**同一个文本块**里,靠空格分隔而不是
 * 单元格分隔。实测 ASML 2025Q2 起的报表就是这样(整份文档 `<table>` 数为 0),而 2025Q1
 * 及更早是单元格式的 —— 同一家公司换过编码,所以两种都得吃。
 *
 * 规则:标签后连续吃数字,**遇到第一个带字母的词就停**(那是下一行的标签)。
 * 允许 `$` `€` `%` 这类符号夹在中间。标签后连着 3 个以上非数字词还没见到数字 → 判定
 * 「标签撞进散文」,返回空。
 *
 * ⚠️ 不能拿它去解析 TSM 那种:那边行标签后跟着 `(Notes 20, 31 and 37)`,
 * 拆词后 `20,` `31` `37)` 全是数字样,会被当成数值。那边必须用整格判定的 numsAfter。
 */
export function numsInRow(txt: string, label: string, n: number, from = 0): number[] {
  const i = txt.indexOf(label, from);
  if (i < 0) return [];

  const out: number[] = [];
  let skipped = 0;
  for (const raw of txt.slice(i + label.length, i + label.length + 800).split(/[\s|]+/)) {
    const t = raw.trim();
    if (!t || t === '$' || t === '€' || t === '%' || t === ')') continue;

    if (/^\(?-?[\d,]+(\.\d+)?\)?$/.test(t) && /\d/.test(t)) {
      out.push((t.startsWith('(') ? -1 : 1) * Number(t.replace(/[(),]/g, '')));
      if (out.length >= n) break;
      continue;
    }
    if (out.length > 0) break; // 数字串结束 = 这一行读完了
    if (++skipped > 3) return []; // 标签后一直没数字 → 不是那一行
  }
  return out;
}
