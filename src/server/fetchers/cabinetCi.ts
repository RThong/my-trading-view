import * as XLSX from 'xlsx';
import { fetchWithTimeout } from './http';

// 内閣府「景気動向指数」长期系列(CI 指数,2020=100,月频,1985-01 起)。先行 / 一致两条,读时现拉、不落库。
// 页面 esri.cao.go.jp/jp/stat/di/di.html 上的「長期系列(CI指数、DI指数、DI累積指数)」xlsx,文件名带发布月日(如 1109ci.xlsx),
// 每月换名 → 先抓页面找链接。速報之后会出改訂值,现拉总是拿到最新一版。
// .xlsx 本可用 fflate,这里用 SheetJS(已为 JPX .xls 引入)省掉多行表头的手写解析。
const PAGE = 'https://www.esri.cao.go.jp/jp/stat/di/di.html';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

// CI 长期系列的起点(年, 月);官方文件 1980~1984 只有 DI
const CI_START = [1985, 1] as const;

export type CiMonth = { date: string; leading: number; coincident: number };
type Row = unknown[];

// 表头逐格核对(第 0 行是大类、第 2 行是列名):先行 / 一致 CI 在第 3 / 4 列,年 / 月在第 1 / 2 列
const HEADER: [row: number, col: number, label: string][] = [
  [0, 3, 'ＣＩ指数'],
  [0, 4, 'ＣＩ指数'],
  [2, 1, '西暦年'],
  [2, 2, '月'],
  [2, 3, '先行指数'],
  [2, 4, '一致指数'],
  // 基准年:换基准(如 2025=100)时整条换一套水平,单位和说明里的数字都会失真 → 当版式变了抛错
  [4, 3, '(令和2年=100)'],
  [4, 4, '(令和2年=100)'],
];

export function parseCiLongSeries(buf: ArrayBuffer): CiMonth[] {
  const wb = XLSX.read(buf);
  const rows = XLSX.utils.sheet_to_json<Row>(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true });
  const bad = HEADER.filter(([r, c, label]) => rows[r]?.[c] !== label);
  if (bad.length) throw new Error(`内閣府 CI:表头对不上(${bad.map(([r, c, l]) => `${r},${c}≠${l}`).join(' ')})`);

  // 数据行 = 年 / 月是数字的行;CI 从 1985 才有,之前的行只有 DI → 跳过;CI 开始后任何一格缺值都算版式变了
  const dated = rows.filter((r) => typeof r[1] === 'number' && typeof r[2] === 'number');
  const start = dated.findIndex((r) => typeof r[3] === 'number');
  if (start < 0) throw new Error('内閣府 CI:一行 CI 都没解析出来');
  // 起点钉死:CI 从 1985-01 开始。不钉的话 1985-01 那格缺值会被当成「CI 前的行」跳过,从 1985-02 悄悄开始
  const first = dated[start];
  if (first[1] !== CI_START[0] || first[2] !== CI_START[1]) {
    throw new Error(`内閣府 CI:首个 CI 月是 ${first[1]}-${first[2]},应为 ${CI_START.join('-')}`);
  }
  const months = dated.slice(start).map((r): CiMonth => {
    const date = `${r[1]}-${String(r[2]).padStart(2, '0')}-01`;
    if (typeof r[3] !== 'number' || typeof r[4] !== 'number') throw new Error(`内閣府 CI:${date} 缺值`);
    return { date, leading: r[3], coincident: r[4] };
  });

  // 月份必须连续(缺一个月 = 源出了问题,别画出跳一格的阶梯线)
  const gap = months.slice(1).find((m, i) => {
    const prev = new Date(`${months[i].date}T00:00:00Z`);
    prev.setUTCMonth(prev.getUTCMonth() + 1);
    return prev.toISOString().slice(0, 10) !== m.date;
  });
  if (gap) throw new Error(`内閣府 CI:月份不连续(${gap.date} 前缺月)`);

  return months;
}

export async function fetchCabinetCi(doFetch: typeof fetchWithTimeout = fetchWithTimeout): Promise<CiMonth[]> {
  const get = async (url: string) => {
    const res = await doFetch(url, { headers: { 'User-Agent': UA } }, 30_000);
    if (!res.ok) throw new Error(`内閣府 CI ${res.status}: ${url}`);
    return res;
  };
  // 「長期系列」那个文件形如 1109ci.xlsx(先行 / 一致 / 遅行的分项是 ci1 / ci2 / ci3 / ci_cont*,不要)
  const file = /href="(\d{4}ci\.xlsx)"/.exec(await (await get(PAGE)).text())?.[1];
  if (!file) throw new Error('内閣府 CI:页面上找不到长期系列 xlsx(改版了?)');

  return parseCiLongSeries(await (await get(new URL(file, PAGE).href)).arrayBuffer());
}
