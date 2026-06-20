/**
 * 返回最近一个*已收盘*的 US 股票交易日(按 America/New_York 时区计算)。
 * 用于给期权快照打日期戳,这样周末或盘前跑批时就不会给非交易日生成误导性的数据行。
 *
 * 规则:
 *  - 如果当前 NY 时间还没到下午 4:00 ET,说明今天还没收盘 ——
 *    先回退一个自然日,再去判断周末。
 *  - 然后跨过周六/周日继续回退,直到落在周一至周五。
 *  - 不处理 US 交易所节假日;遇到节假日时会返回上一个周五
 *    (周中节假日则返回周四),这其实是正确的:最近一个已收盘的
 *    交易日本来就是那一天。
 */
export function lastClosedTradingDate(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const m = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const y = Number(m.year);
  const mo = Number(m.month) - 1;
  const d = Number(m.day);
  // 某些 Node/Bun 版本下,Intl 会把午夜返回成 '24' 而不是 '00';
  // 这里做归一化处理。
  const hour = Number(m.hour) % 24;

  const date = new Date(Date.UTC(y, mo, d));
  if (hour < 16) {
    date.setUTCDate(date.getUTCDate() - 1);
  }
  while (date.getUTCDay() === 0 || date.getUTCDay() === 6) {
    date.setUTCDate(date.getUTCDate() - 1);
  }
  return date.toISOString().slice(0, 10);
}
