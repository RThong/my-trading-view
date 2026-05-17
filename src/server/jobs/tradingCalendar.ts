/**
 * Returns the date of the most recently *closed* US equity trading session,
 * in America/New_York. Used to stamp option snapshots so weekend or
 * pre-close runs don't create misleading rows for non-trading days.
 *
 * Rules:
 *  - If current NY time is before 4:00 PM ET, today's session hasn't
 *    closed yet — roll back one calendar day before checking weekends.
 *  - Then roll back over Saturdays/Sundays until we land on Mon-Fri.
 *  - US exchange holidays are not handled; on a holiday this returns
 *    the previous Friday (or Thursday for mid-week holidays), which is
 *    actually correct: the last closed session WAS that prior day.
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
  // Intl returns '24' instead of '00' for midnight in some Node/Bun builds;
  // normalize.
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
