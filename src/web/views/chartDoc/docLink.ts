// 把一份 ChartDoc 放进链接:/render#doc=<base64url(JSON)>&interval=1W&theme=light[&from=2022-12-01][&to=2023-06-30]。
// 命令行出图(scripts/render-chart.ts)拼链接、出图页(pages/editor/RenderPage)读链接,共用这一处格式。
// 放在 # 后面:不进服务端日志,也不受查询串长度限制。base64url 前先转 UTF-8,标题等中文才不乱
import type { Theme } from '../../hooks/theme';
import { type Interval, INTERVALS } from '../../hooks/interval';
import { type ChartDoc, isDate, parseChartDoc } from './chartDoc';

/**
 * from / to:横轴画哪一段,只给一头时另一头 = 共同时段起点 / 最新。
 * 都不给 = 文档的 range,文档也没有就是各线共同时段(同编辑器打开时的视图)
 */
export type RenderOptions = { interval: Interval; theme: Theme; from?: string; to?: string };

function toBase64Url(text: string): string {
  const bin = Array.from(new TextEncoder().encode(text), (b) => String.fromCharCode(b)).join('');
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): string {
  const bin = atob(s.replaceAll('-', '+').replaceAll('_', '/'));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/** 出图链接的 # 部分(不含 #) */
export function renderHash(doc: ChartDoc, { interval, theme, from, to }: RenderOptions): string {
  return new URLSearchParams({
    doc: toBase64Url(JSON.stringify(doc)),
    interval,
    theme,
    ...(from && { from }),
    ...(to && { to }),
  }).toString();
}

/** 读出图链接:文档过 parseChartDoc(同导入 JSON 的校验);周期 / 主题缺省日线、浅色 */
export function readRenderHash(hash: string): ({ doc: ChartDoc } & RenderOptions) | { error: string } {
  const q = new URLSearchParams(hash.replace(/^#/, ''));
  const raw = q.get('doc');
  if (!raw) return { error: '链接里没有 doc' };

  let doc: ChartDoc | null = null;
  try {
    doc = parseChartDoc(JSON.parse(fromBase64Url(raw)));
  } catch {
    doc = null;
  }
  if (!doc) return { error: 'doc 不是合法的 ChartDoc(同编辑器「导入 JSON」的校验)' };

  const interval = INTERVALS.find((i) => i === q.get('interval')) ?? '1D';
  const theme: Theme = q.get('theme') === 'dark' ? 'dark' : 'light';
  const from = q.get('from') ?? undefined;
  if (from !== undefined && !isDate(from)) return { error: `from 要写成 YYYY-MM-DD:${from}` };
  const to = q.get('to') ?? undefined;
  if (to !== undefined && !isDate(to)) return { error: `to 要写成 YYYY-MM-DD:${to}` };
  if (from && to && from >= to) return { error: `from ${from} 要早于 to ${to}` };

  return { doc, interval, theme, ...(from && { from }), ...(to && { to }) };
}
