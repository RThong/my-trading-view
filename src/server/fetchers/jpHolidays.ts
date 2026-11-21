import { fetchWithTimeout } from './http';

// 内閣府「国民の祝日」CSV(Shift-JIS,免 key,约 20KB):1955 年起全部祝日・振替休日・国民の休日,
// 每年 2 月前后把次年加进去。列 `国民の祝日・休日月日,国民の祝日・休日名称`,日期写 `2026/11/3`(不补零)。
const URL = 'https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv';
const HEADER = '国民の祝日・休日月日,国民の祝日・休日名称';

/** CSV → 假日集合(ISO 日期)。表头逐字核对;认不出的行抛错 */
export function parseJpHolidays(csv: string): Set<string> {
  const [head, ...lines] = csv.trim().split(/\r?\n/);
  if (head !== HEADER) throw new Error(`内閣府祝日表:表头变了「${head}」`);

  return new Set(
    lines.map((line) => {
      const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2}),/.exec(line);
      if (!m) throw new Error(`内閣府祝日表:坏行「${line}」`);
      return `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`;
    }),
  );
}

/** 拉假日表;表里最晚一年早于 needYear(还没把明年加进去)就抛错,免得悄悄把明年的祝日当营业日 */
export async function fetchJpHolidays(needYear: number): Promise<Set<string>> {
  const res = await fetchWithTimeout(URL, {}, 20_000);
  if (!res.ok) throw new Error(`内閣府祝日表 HTTP ${res.status}`);

  const set = parseJpHolidays(new TextDecoder('shift_jis').decode(await res.arrayBuffer()));
  const maxYear = Math.max(...[...set].map((d) => Number(d.slice(0, 4))));
  if (maxYear < needYear) throw new Error(`内閣府祝日表只到 ${maxYear} 年,还没有 ${needYear} 年`);

  return set;
}
