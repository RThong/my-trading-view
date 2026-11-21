import { fetchWithTimeout } from './http';

/**
 * JSDA 公社債店頭売買参考統計値(日证协,每个营业日 15:00 时点各社报价的平均):
 * `market.jsda.or.jp/shijyo/saiken/baibai/baisanchi/files/{YYYY}/S{YYMMDD}.csv`(免 key,Shift-JIS,约 2MB,**无表头**,
 * 列定义见同目录 `files/baisan_csv.pdf`)。
 *
 * ⚠️ 文件名日期 = **发表日 = 报价日的下一营业日**(也是受渡日,日本国债 T+1),第 0 列写的也是它,不是报价日。
 *    报价日当天约 17:30~18:30 JST 挂出;构造 URL 要日本假日表(见 analytics/jpCalendar)。
 * ⚠️ **限流**:连续请求即 429,冷却约 10 分钟,冷却中再请求会延长。每轮只打一次,失败别立刻重试;别先拉目录页。
 * ⚠️ 物価連動国債(第 1 列 `05`)**只给价格**:利率列 99.999、收益率列 999.999;报价社数不足时价格填 999.99。
 *    票息不在文件里 → 自己维护 JGBI_COUPON。
 */
const BASE = 'https://market.jsda.or.jp/shijyo/saiken/baibai/baisanchi/files';
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  'Accept-Language': 'ja',
};

/** 物価連動国債各回的年票息 %(财务省发行要项)。最新一回发行时补一行,缺了 job 会报错 */
export const JGBI_COUPON: Record<number, number> = { 31: 0.6 };

// 列号(0 起)
const C = { date: 0, kind: 1, name: 3, maturity: 4, yieldCmpd: 6, price: 7 } as const;

export type JsdaJgbiDay = {
  /** 受渡日(= 文件名日期) */
  settle: string;
  jgbi: { no: number; maturity: string; coupon: number; price: number | null };
  /** 与 JGBi 同到期年月的长期国债(10 年利付)及其平均値複利 % */
  nominal: { name: string; yield: number };
};

function iso(yyyymmdd: string) {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}
function unquote(s: string) {
  return s.replace(/^"|"$/g, '');
}

/** 取编号最大的 JGBi(换券照 BB:新一回一上市就切)和与它同到期年月的长期国债 */
export function parseJsdaJgbi(csv: string): JsdaJgbiDay {
  const rows = csv
    .trim()
    .split(/\r?\n/)
    .map((l) => l.split(',').map(unquote));
  const settleRaw = rows[0]?.[C.date] ?? '';
  if (!/^\d{8}$/.test(settleRaw)) throw new Error(`JSDA:首行日期认不出「${rows[0]?.slice(0, 4).join(',')}」`);

  const jgbis = rows
    .filter((r) => r[C.kind] === '05' && /^物価連動国債 \d+$/.test(r[C.name] ?? ''))
    .map((r) => ({ no: Number(r[C.name]!.split(' ')[1]), r }));
  if (!jgbis.length) throw new Error('JSDA:没有物価連動国債行(版式可能变了)');
  const { no, r } = jgbis.reduce((a, b) => (b.no > a.no ? b : a));

  const coupon = JGBI_COUPON[no];
  if (coupon === undefined) throw new Error(`JSDA:物価連動国債 ${no} 的票息没登记(在 JGBI_COUPON 里补)`);
  const maturity = iso(r[C.maturity]!);
  const rawPrice = Number(r[C.price]);
  if (!Number.isFinite(rawPrice) || rawPrice <= 0)
    throw new Error(`JSDA:物価連動国債 ${no} 价格认不出「${r[C.price]}」`);

  const nom = rows.find(
    (x) => /^長期国債 \d+$/.test(x[C.name] ?? '') && x[C.maturity]?.slice(0, 6) === r[C.maturity]!.slice(0, 6),
  );
  const nomYield = Number(nom?.[C.yieldCmpd]);
  if (!nom || !(nomYield > -5 && nomYield < 50)) {
    throw new Error(`JSDA:找不到与物価連動国債 ${no}(${maturity})同到期年月的长期国债收益率`);
  }

  return {
    settle: iso(settleRaw),
    // 999.99 = 报价社数不足、不公表
    jgbi: { no, maturity, coupon, price: rawPrice >= 999 ? null : rawPrice },
    nominal: { name: nom[C.name]!, yield: nomYield },
  };
}

/** 拉受渡日 settle 那份文件;还没挂出(404)→ null。429 等其它错误抛出,由调用方记失败、下一个触发点再试 */
export async function fetchJsdaJgbi(settle: string): Promise<JsdaJgbiDay | null> {
  const ymd = settle.replaceAll('-', '');
  const res = await fetchWithTimeout(`${BASE}/${ymd.slice(0, 4)}/S${ymd.slice(2)}.csv`, { headers: HEADERS }, 60_000);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`JSDA 売買参考統計値 S${ymd.slice(2)} HTTP ${res.status}`);

  return parseJsdaJgbi(new TextDecoder('shift_jis').decode(await res.arrayBuffer()));
}

/**
 * 日本相互证券 BB「BEIの推移」(`www.bb.jbts.co.jp/ja/historical/marketdata05.html`):页面 `initChart(...)` 里内嵌
 * 2024-04-01 起的日度三条 [10 年物价连动债复利、10 年利付国债复利、BEI](%),**按月更新**。财务省 BEI 资料用的就是这份。
 * 只用来一次性回填(之后靠 JSDA 每天增量)。
 */
const BB_URL = 'https://www.bb.jbts.co.jp/ja/historical/marketdata05.html';

export type BbBeiRow = { date: string; real: number; nominal: number; bei: number };

export function parseBbBei(html: string): BbBeiRow[] {
  const start = html.indexOf('initChart(');
  if (start < 0) throw new Error('BB:页面里没有 initChart(版式可能变了)');
  const body = html.slice(start, html.indexOf('</script>', start));
  // 参数是一行一个带 `// 注释` 的 JS 字符串字面量,内容又是 JSON:按注释名取下一行,两次 JSON.parse
  const arg = (label: string): unknown => {
    const lines = body.split('\n');
    const i = lines.findIndex((l) => l.trim() === `// ${label}`);
    if (i < 0) throw new Error(`BB:initChart 缺参数「${label}」`);
    return JSON.parse(JSON.parse(lines[i + 1]!.trim().replace(/,$/, '')) as string);
  };

  const legend = arg('affiliate') as string[];
  const want = ['１０年物価連動債<br>複利利回り', '10年利付国債<br>複利利回り', 'BEI'];
  if (JSON.stringify(legend) !== JSON.stringify(want)) throw new Error(`BB:图例变了 ${JSON.stringify(legend)}`);
  const labels = arg('label') as string[];
  const [real, nominal, bei] = arg('tabledata') as number[][];
  if (![real, nominal, bei].every((s) => s?.length === labels.length)) throw new Error('BB:三条序列与日期长度不一致');

  const rows = labels.map((l, i) => {
    if (!/^\d{4}\/\d{2}\/\d{2}$/.test(l)) throw new Error(`BB:日期认不出「${l}」`);
    const row = { date: l.replaceAll('/', '-'), real: real![i]!, nominal: nominal![i]!, bei: bei![i]! };
    if (![row.real, row.nominal, row.bei].every(Number.isFinite)) throw new Error(`BB:${l} 有空值`);
    return row;
  });

  // ⚠️ 源自己有重复段(2026-11 实测:2026-05 整月贴了两遍,值完全相同)→ 同值去重;同一天值不同说明数据乱了,抛错
  const byDate = Map.groupBy(rows, (r) => r.date);
  const conflict = [...byDate].find(([, rs]) => new Set(rs.map((r) => `${r.real},${r.nominal},${r.bei}`)).size > 1);
  if (conflict) throw new Error(`BB:${conflict[0]} 出现多次且值不同`);

  return [...byDate.values()].map((rs) => rs[0]!).sort((a, b) => a.date.localeCompare(b.date));
}

export async function fetchBbBei(): Promise<BbBeiRow[]> {
  const res = await fetchWithTimeout(BB_URL, { headers: HEADERS }, 30_000);
  if (!res.ok) throw new Error(`BB BEIの推移 HTTP ${res.status}`);

  return parseBbBei(await res.text());
}
