// 日本财务省(MOF)JGB 收益率曲线:官方免费 CSV,日频 15 档(含 2Y)。历史文件到上月末 + 当月文件拼接。
import { fetchWithTimeout } from './http';

export type JgbCurve = { tenors: string[]; series: Record<string, { date: string; value: number }[]> };

const MOF_BASE = 'https://www.mof.go.jp/english/policy/jgbs/reference/interest_rate';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

// YYYY/M/D → YYYY-MM-DD(个位补零);非法返回 null。
function toIso(d: string | undefined): string | null {
  const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec((d ?? '').trim());
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null;
}

/** 解析 MOF CSV 文本 → tenor→序列。两行表头;缺值 '-' 跳过;since 过滤;去 BOM。 */
export function parseMofJgbCsv(text: string, since: string): JgbCurve {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  const headerIdx = lines.findIndex((l) => l.startsWith('Date,'));
  if (headerIdx < 0) return { tenors: [], series: {} };

  const tenors = lines[headerIdx].split(',').slice(1).map((s) => s.trim());
  const series: Record<string, { date: string; value: number }[]> = {};
  for (const t of tenors) series[t] = [];

  for (const line of lines.slice(headerIdx + 1)) {
    const cols = line.split(',');
    const date = toIso(cols[0]);
    if (!date || date < since) continue;
    tenors.forEach((t, i) => {
      const raw = cols[i + 1]?.trim();
      if (!raw || raw === '-') return;
      const v = Number(raw);
      if (Number.isFinite(v)) series[t].push({ date, value: v });
    });
  }
  return { tenors, series };
}

/** 拉全历史 + 当月 CSV 并合并(当月覆盖同日),since 过滤。 */
export async function fetchJgbCurve(since = '2018-01-01'): Promise<JgbCurve> {
  const get = (path: string) =>
    fetchWithTimeout(`${MOF_BASE}/${path}`, { headers: { 'User-Agent': UA } }).then((r) => r.text());
  const [hist, cur] = await Promise.all([get('historical/jgbcme_all.csv'), get('jgbcme.csv')]);
  const h = parseMofJgbCsv(hist, since);
  const c = parseMofJgbCsv(cur, since);

  const tenors = h.tenors.length ? h.tenors : c.tenors;
  const series: Record<string, { date: string; value: number }[]> = {};
  for (const t of tenors) {
    const byDate = new Map<string, number>();
    for (const p of h.series[t] ?? []) byDate.set(p.date, p.value);
    for (const p of c.series[t] ?? []) byDate.set(p.date, p.value); // 当月覆盖
    series[t] = [...byDate].sort(([a], [b]) => a.localeCompare(b)).map(([date, value]) => ({ date, value }));
  }
  return { tenors, series };
}
