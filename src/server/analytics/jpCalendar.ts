// 日本债市营业日:周一~周五,去掉国民の祝日・休日(内閣府表,见 fetchers/jpHolidays)和年末年始(12-31 ~ 1-3,
// 银行休业、JSDA 不发)。纯计算,假日表由调用方传入。
const DAY_MS = 86_400_000;
const YEAR_END = new Set(['12-31', '01-01', '01-02', '01-03']);

export function addDays(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

export function isJpBusinessDay(iso: string, holidays: ReadonlySet<string>): boolean {
  const wd = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return wd !== 0 && wd !== 6 && !holidays.has(iso) && !YEAR_END.has(iso.slice(5));
}

/** iso 之后(不含)第一个营业日 */
export function nextJpBusinessDay(iso: string, holidays: ReadonlySet<string>): string {
  let d = addDays(iso, 1);
  while (!isJpBusinessDay(d, holidays)) d = addDays(d, 1);
  return d;
}

/** iso 之前(不含)最近一个营业日 */
export function prevJpBusinessDay(iso: string, holidays: ReadonlySet<string>): string {
  let d = addDays(iso, -1);
  while (!isJpBusinessDay(d, holidays)) d = addDays(d, -1);
  return d;
}

/** from ~ to(含)之间的营业日,升序 */
export function jpBusinessDaysBetween(from: string, to: string, holidays: ReadonlySet<string>): string[] {
  const n = Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS) + 1;
  return Array.from({ length: Math.max(0, n) }, (_, i) => addDays(from, i)).filter((d) => isJpBusinessDay(d, holidays));
}
