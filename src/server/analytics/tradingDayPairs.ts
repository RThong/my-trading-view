/**
 * 给「一次问两天、两天都得是交易日」的源(Cboe VIX 分解,见 fetchers/cboeVixDecomp)排请求配对。纯日期计算。
 * 我们没有交易所假日历,假日靠源的报错认:配对要让一个假日最多连累一天,且能在第二轮单独判出来。
 */

const DAY_MS = 86_400_000;

function addDays(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

export function orderPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/** 库里离 d 最近的已知交易日(不含 d 自己) */
export function nearestKnown(d: string, known: string[]): string | undefined {
  const t = Date.parse(d);
  return known
    .filter((k) => k !== d)
    .reduce<string | undefined>(
      (best, k) => (!best || Math.abs(Date.parse(k) - t) < Math.abs(Date.parse(best) - t) ? k : best),
      undefined,
    );
}

/**
 * 缺的天(升序)两两配对。最新一天单独配库里离它最近的已知交易日:它常是「还没发布」,
 * 源对整对回空,和别的天配在一起会连累那天也拉不到。单出来的天同样配已知交易日,库里没有就配前一个日历日碰运气。
 */
export function planPairs(todo: string[], known: string[]): [string, string][] {
  const rest = todo.slice(0, -1);
  const pairs = Array.from({ length: Math.floor(rest.length / 2) }, (_, i) => orderPair(rest[2 * i], rest[2 * i + 1]));
  const singles = [rest.length % 2 ? rest.at(-1) : undefined, todo.at(-1)].filter((d): d is string => !!d);
  return [...pairs, ...singles.map((d) => orderPair(d, nearestKnown(d, known) ?? addDays(d, -1)))];
}
