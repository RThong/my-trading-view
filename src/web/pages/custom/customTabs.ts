// 自建的竖 tab(视角)/ 横 tab:用户在界面上增删改,存 localStorage。
// 与 pages/<视角>/ 里代码定义的内置 tab 完全分开(只是长得一样),以后整份挪到文件 / 别处存时只动这一块。
import { type ChartDoc, parseChartDoc } from '../../views/chartDoc/chartDoc';

/** tab 里的一块内容。现在只有图;以后加文字块就在这里加一种 kind */
export type Block = { id: string; kind: 'chart'; doc: ChartDoc };
export type CustomTab = { id: string; label: string; blocks: Block[] };
export type CustomPersp = { id: string; label: string; tabs: CustomTab[] };
export type CustomStore = { v: 1; perspectives: CustomPersp[] };

export const EMPTY_STORE: CustomStore = { v: 1, perspectives: [] };

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function hasIdLabel(x: unknown): x is { id: string; label: string } & Record<string, unknown> {
  return isObj(x) && typeof x.id === 'string' && typeof x.label === 'string';
}

function parseBlock(x: unknown): Block | null {
  if (!isObj(x) || typeof x.id !== 'string' || x.kind !== 'chart') return null;

  const doc = parseChartDoc(x.doc);

  // 空图只会是「新建后没点完成就刷新」留下的,列表里只占一块空白,读档时丢掉
  return doc && doc.panes.length > 0 ? { id: x.id, kind: 'chart', doc } : null;
}

function parseTab(x: unknown): CustomTab | null {
  if (!hasIdLabel(x) || !Array.isArray(x.blocks)) return null;

  return { id: x.id, label: x.label, blocks: x.blocks.map(parseBlock).filter((b) => b !== null) };
}

function parsePersp(x: unknown): CustomPersp | null {
  if (!hasIdLabel(x) || !Array.isArray(x.tabs)) return null;

  return { id: x.id, label: x.label, tabs: x.tabs.map(parseTab).filter((t) => t !== null) };
}

/**
 * 存档 → 数据(localStorage 内容不可信)。坏的那一项单独丢掉、其余照留:
 * 一张图的格式过期了,不该连累整份自建 tab 一起没
 */
export function parseStore(x: unknown): CustomStore {
  if (!isObj(x) || x.v !== 1 || !Array.isArray(x.perspectives)) return EMPTY_STORE;

  return { v: 1, perspectives: x.perspectives.map(parsePersp).filter((p) => p !== null) };
}

/** 改一个视角(找不到就原样返回) */
export function editPersp(s: CustomStore, perspId: string, fn: (p: CustomPersp) => CustomPersp): CustomStore {
  return { ...s, perspectives: s.perspectives.map((p) => (p.id === perspId ? fn(p) : p)) };
}

/** 改一个横 tab(找不到就原样返回) */
export function editTab(s: CustomStore, perspId: string, tabId: string, fn: (t: CustomTab) => CustomTab): CustomStore {
  return editPersp(s, perspId, (p) => ({ ...p, tabs: p.tabs.map((t) => (t.id === tabId ? fn(t) : t)) }));
}
