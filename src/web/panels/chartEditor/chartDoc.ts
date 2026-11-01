// 图表编辑器的状态模型:整张图 = 一份带版本号的 JSON(图 → 格 → 纵轴 → 图层)。
// 这份结构是标准 —— 以后旧图表往它上面映射,不是它迁就旧代码。图层只存序列 id,不存数据。
// 本文件全是纯函数:编辑操作返回新文档,并经 normalize 保证不变式。

export type ScaleSide = 'right' | 'left' | 'overlay';

export type Scale = {
  /** 'right' / 'left' 是保留 id(lw-charts 内置轴);独立轴用生成的 s1、s2… */
  id: string;
  side: ScaleSide;
};

export type Layer = {
  id: string;
  /** 注册表 id */
  series: string;
  /** 引用同一格 scales 里的某个 id */
  scale: string;
  color: string;
};

export type Pane = {
  id: string;
  /** 高度比例(lw-charts stretch factor) */
  stretch: number;
  scales: Scale[];
  layers: Layer[];
};

export type ChartDoc = { v: 1; panes: Pane[] };

/** 图层挂轴的选择:内置左右轴、新开一根独立轴,或挂到本格已有的某根独立轴。 */
export type ScaleChoice = 'right' | 'left' | 'newOverlay' | { overlay: string };

/** 图层移到哪一格:已有格的 id,或新开一格(追加到最下面)。 */
export type PaneTarget = string | 'new';

export const EMPTY_DOC: ChartDoc = { v: 1, panes: [] };

const MAIN_STRETCH = 2;
const SUB_STRETCH = 1;

const BUILTIN: Record<'right' | 'left', Scale> = {
  right: { id: 'right', side: 'right' },
  left: { id: 'left', side: 'left' },
};

/** 某前缀下的下一个 id:取全文档同前缀的现存最大序号 + 1。纯函数、确定性;代价是删掉的恰好是最大号时该号会被复用。 */
export function nextId(doc: ChartDoc, prefix: 'p' | 'l' | 's'): string {
  const ids = doc.panes.flatMap((p) => [p.id, ...p.scales.map((s) => s.id), ...p.layers.map((l) => l.id)]);
  const max = ids
    .filter((id) => id.startsWith(prefix))
    .map((id) => Number(id.slice(prefix.length)))
    .filter(Number.isInteger)
    .reduce((m, n) => Math.max(m, n), 0);

  return `${prefix}${max + 1}`;
}

/**
 * 不变式:没有图层的格删掉;没人引用的轴删掉;图层引用的轴一定在本格存在(缺了按内置轴补,
 * 引用了不存在的独立轴则退回右轴)。每个编辑操作的出口都过一遍,调用方不必自己维护。
 */
export function normalize(doc: ChartDoc): ChartDoc {
  const panes = doc.panes
    .filter((p) => p.layers.length > 0)
    .map((p) => {
      const known = new Map(p.scales.map((s) => [s.id, s]));
      const layers = p.layers.map((l) =>
        known.has(l.scale) || l.scale === 'right' || l.scale === 'left' ? l : { ...l, scale: 'right' },
      );
      const used = new Set(layers.map((l) => l.scale));
      // 保留原顺序,再补上引用了但没声明的内置轴
      // 按 id 去重(moveLayer 带过来的内置轴可能与已有的重复),保留先出现的
      const declared = p.scales.filter((s, i) => used.has(s.id) && p.scales.findIndex((x) => x.id === s.id) === i);
      const missing = (['right', 'left'] as const)
        .filter((id) => used.has(id) && !known.has(id))
        .map((id) => BUILTIN[id]);

      return { ...p, layers, scales: [...declared, ...missing] };
    });

  return { v: 1, panes };
}

const mapLayer = (doc: ChartDoc, layerId: string, fn: (l: Layer, p: Pane) => Partial<Layer>): ChartDoc => ({
  ...doc,
  panes: doc.panes.map((p) => ({ ...p, layers: p.layers.map((l) => (l.id === layerId ? { ...l, ...fn(l, p) } : l)) })),
});

export function findLayer(doc: ChartDoc, layerId: string): { pane: Pane; layer: Layer } | undefined {
  const pane = doc.panes.find((p) => p.layers.some((l) => l.id === layerId));
  const layer = pane?.layers.find((l) => l.id === layerId);

  return pane && layer ? { pane, layer } : undefined;
}

/** 加一条图层:默认第 0 格、右轴。空图时新建主格。 */
export function addLayer(doc: ChartDoc, series: string, color: string): ChartDoc {
  const layer: Layer = { id: nextId(doc, 'l'), series, scale: 'right', color };
  const [first, ...rest] = doc.panes;
  const head: Pane = first
    ? { ...first, layers: [...first.layers, layer] }
    : { id: nextId(doc, 'p'), stretch: MAIN_STRETCH, scales: [BUILTIN.right], layers: [layer] };

  return normalize({ ...doc, panes: [head, ...rest] });
}

export function removeLayer(doc: ChartDoc, layerId: string): ChartDoc {
  return normalize({
    ...doc,
    panes: doc.panes.map((p) => ({ ...p, layers: p.layers.filter((l) => l.id !== layerId) })),
  });
}

/** 拿掉某条序列的全部图层(下拉框取消勾选)。 */
export function removeSeries(doc: ChartDoc, series: string): ChartDoc {
  return normalize({
    ...doc,
    panes: doc.panes.map((p) => ({ ...p, layers: p.layers.filter((l) => l.series !== series) })),
  });
}

export function setLayerColor(doc: ChartDoc, layerId: string, color: string): ChartDoc {
  return mapLayer(doc, layerId, () => ({ color }));
}

/** 换轴。新开独立轴 = 在本格加一根 overlay;旧轴没人用了由 normalize 回收。 */
export function setLayerScale(doc: ChartDoc, layerId: string, choice: ScaleChoice): ChartDoc {
  const hit = findLayer(doc, layerId);
  if (!hit) return doc;

  const { scaleId, added } = resolveScale(doc, choice);
  const panes = doc.panes.map((p) =>
    p.id !== hit.pane.id
      ? p
      : {
          ...p,
          scales: added ? [...p.scales, added] : p.scales,
          layers: p.layers.map((l) => (l.id === layerId ? { ...l, scale: scaleId } : l)),
        },
  );

  return normalize({ ...doc, panes });
}

function resolveScale(doc: ChartDoc, choice: ScaleChoice): { scaleId: string; added?: Scale } {
  if (choice === 'right' || choice === 'left') return { scaleId: choice };
  if (choice === 'newOverlay') {
    const id = nextId(doc, 's');
    return { scaleId: id, added: { id, side: 'overlay' } };
  }
  return { scaleId: choice.overlay };
}

/**
 * 把图层移到某一格(before 给了就插到那条图层前面,否则追加到末尾;目标是本格 = 调顺序)。左右轴原样带过去;独立轴是源格私有的,在目标格新开一根
 * (同一根独立轴上的其它图层留在原格,不跟着走)。
 */
export function moveLayer(doc: ChartDoc, layerId: string, target: PaneTarget, before?: string): ChartDoc {
  const hit = findLayer(doc, layerId);
  if (!hit || before === layerId) return doc;
  if (hit.pane.id === target) return reorderInPane(doc, hit.pane, layerId, before);
  // 目标格不存在:原样返回,别把图层从源格摘掉却放不进任何格
  if (target !== 'new' && !doc.panes.some((p) => p.id === target)) return doc;

  const srcScale = hit.pane.scales.find((s) => s.id === hit.layer.scale);
  const overlay = srcScale?.side === 'overlay' ? { id: nextId(doc, 's'), side: 'overlay' as const } : undefined;
  const layer: Layer = { ...hit.layer, scale: overlay?.id ?? hit.layer.scale };
  const builtin = layer.scale === 'right' || layer.scale === 'left' ? BUILTIN[layer.scale] : undefined;
  const carried = [overlay ?? builtin].filter((s) => s !== undefined);

  const withoutLayer = doc.panes.map((p) => ({ ...p, layers: p.layers.filter((l) => l.id !== layerId) }));
  const panes =
    target === 'new'
      ? [...withoutLayer, { id: nextId(doc, 'p'), stretch: SUB_STRETCH, scales: carried, layers: [layer] }]
      : withoutLayer.map((p) =>
          p.id === target
            ? { ...p, scales: [...p.scales, ...carried], layers: insertBefore(p.layers, layer, before) }
            : p,
        );

  return normalize({ ...doc, panes });
}

/** 插到 before 那条图层前面;before 缺省或不在这一格 = 追加到末尾。 */
function insertBefore(layers: Layer[], layer: Layer, before?: string): Layer[] {
  const at = before === undefined ? -1 : layers.findIndex((l) => l.id === before);

  return at < 0 ? [...layers, layer] : [...layers.slice(0, at), layer, ...layers.slice(at)];
}

// 同格内调顺序:只影响谁画在上层、图例谁在前,不动轴。
function reorderInPane(doc: ChartDoc, pane: Pane, layerId: string, before?: string): ChartDoc {
  const layer = pane.layers.find((l) => l.id === layerId)!;
  const layers = insertBefore(
    pane.layers.filter((l) => l.id !== layerId),
    layer,
    before,
  );
  if (layers.every((l, i) => l === pane.layers[i])) return doc;

  return { ...doc, panes: doc.panes.map((p) => (p.id === pane.id ? { ...p, layers } : p)) };
}

/** 写回各格高度比例(分隔条拖完后从图表读回)。长度不符就不动,防止结构刚变时的过期读数。 */
export function setStretches(doc: ChartDoc, stretches: number[]): ChartDoc {
  if (stretches.length !== doc.panes.length) return doc;
  if (doc.panes.every((p, i) => p.stretch === stretches[i])) return doc;

  return { ...doc, panes: doc.panes.map((p, i) => ({ ...p, stretch: stretches[i] })) };
}

/** 文档里还没用到的第一个调色板颜色;全用过了就按图层数轮转。 */
export function nextColor(doc: ChartDoc, palette: readonly string[]): string {
  const used = new Set(doc.panes.flatMap((p) => p.layers.map((l) => l.color)));
  const count = doc.panes.reduce((n, p) => n + p.layers.length, 0);

  return palette.find((c) => !used.has(c)) ?? palette[count % palette.length];
}

// ── 校验:以后从 localStorage / URL 载入时走这里(项目没有 zod,手写守卫)──

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isStr = (x: unknown): x is string => typeof x === 'string' && x.length > 0;

// 保留 id 与 side 必须一一对应:'right' / 'left' 只能是内置轴,其它 id 只能是独立轴。
// 否则 {id:'left', side:'overlay'} 这种会让图层挂着左轴、整图左轴却不开。
const isScale = (x: unknown): x is Scale =>
  isObj(x) && isStr(x.id) && (x.id === 'right' || x.id === 'left' ? x.side === x.id : x.side === 'overlay');

// 颜色限定 #rrggbb:lw-charts 解析不了的颜色会直接抛错(整页白屏),<input type=color> 也只认这种
const isColor = (x: unknown): x is string => typeof x === 'string' && /^#[0-9a-f]{6}$/i.test(x);

const isLayer = (x: unknown): x is Layer =>
  isObj(x) && isStr(x.id) && isStr(x.series) && isStr(x.scale) && isColor(x.color);

// 'new' 是 PaneTarget 里「新开一格」的保留字,格不能叫这个
const isPane = (x: unknown): x is Pane =>
  isObj(x) &&
  isStr(x.id) &&
  x.id !== 'new' &&
  typeof x.stretch === 'number' &&
  Number.isFinite(x.stretch) &&
  x.stretch > 0 &&
  Array.isArray(x.scales) &&
  x.scales.every(isScale) &&
  Array.isArray(x.layers) &&
  x.layers.every(isLayer);

const allUnique = (ids: string[]) => new Set(ids).size === ids.length;

/**
 * id 唯一性:格 / 图层 / 独立轴的 id 全文档唯一(渲染层按图层 id 建 Map,重复会让多条图层坍缩成一条);
 * 内置轴 'right' / 'left' 每格各有一根,只要求格内不重复。
 */
const idsUnique = (panes: Pane[]): boolean =>
  allUnique(
    panes.flatMap((p) => [
      p.id,
      ...p.layers.map((l) => l.id),
      ...p.scales.filter((s) => s.side === 'overlay').map((s) => s.id),
    ]),
  ) && panes.every((p) => allUnique(p.scales.map((s) => s.id)));

/** 结构不对 / id 冲突返回 null;通过则过一遍 normalize(修补引用不一致这类可自愈的问题)。 */
export function parseChartDoc(x: unknown): ChartDoc | null {
  if (!isObj(x) || x.v !== 1 || !Array.isArray(x.panes) || !x.panes.every(isPane)) return null;
  if (!idsUnique(x.panes)) return null;

  // 按字段白名单重建:载入的 JSON 里多出来的字段(比如数据)一律丢掉,守住「图层不存数据」
  const panes = x.panes.map((p) => ({
    id: p.id,
    stretch: p.stretch,
    scales: p.scales.map((sc) => ({ id: sc.id, side: sc.side })),
    layers: p.layers.map((l) => ({ id: l.id, series: l.series, scale: l.scale, color: l.color })),
  }));

  return normalize({ v: 1, panes });
}
