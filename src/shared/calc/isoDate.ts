/**
 * ISO 日期字符串(YYYY-MM-DD)里最晚的一个。字典序就是时间序,直接比字符串。
 * 别换成 `Math.max`:它对字符串返回 NaN(lint 的 useMathMinMax 会这么建议,这里用 if 写法就是为了不被它改写)。
 * 空数组抛错,和原来的 `reduce` 不带初值一致 —— 调用方都先判过非空。
 */
export function latestIso(dates: readonly string[]): string {
  return dates.reduce((latest, d) => {
    if (d > latest) return d;
    return latest;
  });
}
