/**
 * 美股交易日工具。两条路径:
 *  - lastClosedFrom(tradingDays):给定权威交易日列表(moomoo Qot_RequestTradeDate),
 *    返回最近一个*已收盘*的交易日。认假期(因为列表本身已扣假期)。打戳主用这个。
 *  - lastClosedTradingDate():无列表时的兜底——本地按 ET 推算,只跳周末、不认假期。
 * 「已收盘」判定:美东 16:00 前视为当日未收盘。
 */

/** 把某瞬间换算成美东(America/New_York)的日期与小时。 */
function nyParts(now: Date): { date: string; hour: number } {
  const m = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
    }).formatToParts(now).map((p) => [p.type, p.value]),
  );
  // 某些 Node/Bun 下午夜会返回 '24' 而非 '00',归一化。
  return { date: `${m.year}-${m.month}-${m.day}`, hour: Number(m.hour) % 24 };
}

/**
 * 权威交易日列表(升序 'YYYY-MM-DD',已扣假期)→ 最近一个已收盘交易日。
 * 美东 16:00 前,今日视为未收盘(只认严格早于今日的)。列表为空返回 null。
 */
export function lastClosedFrom(tradingDays: string[], now: Date = new Date()): string | null {
  const { date: today, hour } = nyParts(now);
  // tradingDays 契约为升序(见 fetchUsTradingDates),filter 保序 → 取末位即最大。
  const eligible = tradingDays.filter((d) => d < today || (d === today && hour >= 16));
  return eligible.length ? eligible[eligible.length - 1] : null;
}

/**
 * 兜底:无权威列表时,按 ET 本地推算最近已收盘交易日。
 * 规则:ET 未到 16:00 先回退一天;再跨过周六/周日。**不认交易所节假日**
 * (节假日会得到上一个周五/周四,可能差一天)——所以优先用 lastClosedFrom。
 */
export function lastClosedTradingDate(now: Date = new Date()): string {
  const { date, hour } = nyParts(now);
  const [y, mo, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (hour < 16) dt.setUTCDate(dt.getUTCDate() - 1);
  while (dt.getUTCDay() === 0 || dt.getUTCDay() === 6) dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}
