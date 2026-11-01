// 图表编辑器的状态模型:整张图 = 一份带版本号的 JSON(图 → 格 → 纵轴 → 图层)。
// 这份结构是标准 —— 以后旧图表往它上面映射,不是它迁就旧代码。图层只存序列 id,不存数据。
// 本文件全是纯函数:编辑操作返回新文档,并经 normalize 保证不变式。

export type ScaleSide = 'right' | 'left' | 'overlay';

export type Scale = {
  /** 'right' / 'left' 是保留 id(lw-charts 内置轴);独立轴用生成的 s1、s2… */
  id: string;
  side: ScaleSide;
  /** 倒轴(上下颠倒)。是轴的属性:挂在这根轴上的图层一起倒 */
  invert?: true;
  /** 对数坐标。轴上有 ≤0 的值时渲染层按普通坐标画(对数画不了) */
  log?: true;
};

/** 参照期换算:在 [start, end] 里求本图层 → target 图层单位的线性比例,换算后画在 target 的刻度上。 */
export type Fit = { target: string; start: string; end: string };

/** 派生图层:数据由别的图层算出来,不对应注册表序列。 */
export type Study =
  /** 两条图层的滚动相关性(按平移后的位置算) */
  | { kind: 'corr'; a: string; b: string; window: number; mode: 'level' | 'change'; horizon: number }
  /** 劈叉幅度:of 图层(须带 fit)的换算目标 − 换算后的 of */
  | { kind: 'gap'; of: string };

type LayerBase = {
  id: string;
  /** 引用同一格 scales 里的某个 id */
  scale: string;
  color: string;
};

export type SeriesLayer = LayerBase & {
  /** 注册表 id */
  series: string;
  /** 平移的交易日数,> 0 往后(右)挪 —— 看它是不是领先别的线 */
  shift?: number;
  fit?: Fit;
};

export type StudyLayer = LayerBase & { study: Study };

export type Layer = SeriesLayer | StudyLayer;

export const isSeriesLayer = (l: Layer): l is SeriesLayer => 'series' in l;

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

/** 平移上限(交易日),约 14 年 */
export const MAX_SHIFT = 3650;

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
 * 图层之间的引用失效时怎么收拾:换算目标没了(或目标自己也在换算)→ 去掉 fit;
 * 相关性引用的图层不在 / 不是序列图层 → 删掉该派生层;劈叉引用的图层没有 fit → 删掉。
 * 先修 fit 再查派生层,因为劈叉依赖 fit。
 */
function pruneRefs(doc: ChartDoc): ChartDoc {
  const series = new Map(doc.panes.flatMap((p) => p.layers.filter(isSeriesLayer).map((l) => [l.id, l] as const)));
  const fitOk = (l: SeriesLayer) =>
    !l.fit || (l.fit.target !== l.id && series.has(l.fit.target) && !series.get(l.fit.target)!.fit);
  const dropped = new Set([...series.values()].filter((l) => !fitOk(l)).map((l) => l.id));
  const d = detachFit(doc, dropped);

  const fixed = new Map(d.panes.flatMap((p) => p.layers.filter(isSeriesLayer).map((l) => [l.id, l] as const)));
  const studyOk = ({ study }: StudyLayer) =>
    study.kind === 'corr' ? fixed.has(study.a) && fixed.has(study.b) : !!fixed.get(study.of)?.fit;

  return {
    ...d,
    panes: d.panes.map((p) => ({
      ...p,
      layers: p.layers.filter((l) => isSeriesLayer(l) || studyOk(l)),
    })),
  };
}

/**
 * 去掉这些图层的 fit,并各自改挂本格一根新独立轴。取消对齐(或换算目标没了)后它按原始数值画,
 * 和 target 单位不同,还挂在 target 的轴上会把那根轴撑歪;独立轴自己缩放,位置也不跳格。
 */
function detachFit(doc: ChartDoc, ids: ReadonlySet<string>): ChartDoc {
  if (ids.size === 0) return doc;

  const base = Number(nextId(doc, 's').slice(1));
  const order = [...ids];
  const scaleOf = (id: string) => `s${base + order.indexOf(id)}`;

  return {
    ...doc,
    panes: doc.panes.map((p) => {
      const hit = p.layers.filter((l) => isSeriesLayer(l) && ids.has(l.id));
      if (hit.length === 0) return p;
      return {
        ...p,
        scales: [...p.scales, ...hit.map((l) => ({ id: scaleOf(l.id), side: 'overlay' as const }))],
        layers: p.layers.map((l) => {
          if (!isSeriesLayer(l) || !ids.has(l.id)) return l;
          const { fit: _drop, ...rest } = l;
          return { ...rest, scale: scaleOf(l.id) };
        }),
      };
    }),
  };
}

/**
 * 不变式:没有图层的格删掉;没人引用的轴删掉;图层引用的轴一定在本格存在(缺了按内置轴补,
 * 引用了不存在的独立轴则退回右轴);图层间引用失效的收拾掉(见 pruneRefs)。每个编辑操作的出口都过一遍。
 */
export function normalize(doc: ChartDoc): ChartDoc {
  const panes = pruneRefs(doc)
    .panes.filter((p) => p.layers.length > 0)
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

/** 是否滚动相关性层。它的轴固定 −1~1(autoscale provider),和别的线共轴或被拖成手动就不固定了 —— 只能独占一格、不挪不换轴。 */
export const isCorrLayer = (l: Layer): boolean => !isSeriesLayer(l) && l.study.kind === 'corr';
const hasCorrLayer = (p: Pane) => p.layers.some(isCorrLayer);

/** 加一条图层:默认第 0 格、右轴。空图(或第 0 格是相关性格)时在最上面新建主格。 */
export function addLayer(doc: ChartDoc, series: string, color: string): ChartDoc {
  const layer: Layer = { id: nextId(doc, 'l'), series, scale: 'right', color };
  const [first, ...rest] = doc.panes;
  const panes =
    first && !hasCorrLayer(first)
      ? [{ ...first, layers: [...first.layers, layer] }, ...rest]
      : [{ id: nextId(doc, 'p'), stretch: MAIN_STRETCH, scales: [BUILTIN.right], layers: [layer] }, ...doc.panes];

  return normalize({ ...doc, panes });
}

export function removeLayer(doc: ChartDoc, layerId: string): ChartDoc {
  return normalize({
    ...doc,
    panes: doc.panes.map((p) => ({ ...p, layers: p.layers.filter((l) => l.id !== layerId) })),
  });
}

/** 拿掉某条序列的全部图层(下拉框取消勾选)。依赖它们的派生层由 normalize 一并收拾。 */
export function removeSeries(doc: ChartDoc, series: string): ChartDoc {
  return normalize({
    ...doc,
    panes: doc.panes.map((p) => ({
      ...p,
      layers: p.layers.filter((l) => !isSeriesLayer(l) || l.series !== series),
    })),
  });
}

/** 平移(交易日)。0 = 不平移,字段删掉;超过上限按上限截。 */
export function setLayerShift(doc: ChartDoc, layerId: string, shift: number): ChartDoc {
  const n = Math.max(-MAX_SHIFT, Math.min(MAX_SHIFT, Math.round(shift) || 0));
  const cur = findLayer(doc, layerId)?.layer;
  if (!cur || !isSeriesLayer(cur) || (cur.shift ?? 0) === n) return doc;

  return {
    ...doc,
    panes: doc.panes.map((p) => ({
      ...p,
      layers: p.layers.map((l) => {
        if (l.id !== layerId || !isSeriesLayer(l)) return l;
        const { shift: _old, ...rest } = l;
        return n === 0 ? rest : { ...rest, shift: n };
      }),
    })),
  };
}

/** 轴的开关型属性(倒轴 / 对数),作用于整根轴;关掉时删字段。 */
function setScaleFlag(doc: ChartDoc, paneId: string, scaleId: string, flag: 'invert' | 'log', on: boolean): ChartDoc {
  return {
    ...doc,
    panes: doc.panes.map((p) =>
      p.id !== paneId
        ? p
        : {
            ...p,
            scales: p.scales.map((sc) => {
              if (sc.id !== scaleId) return sc;
              const { [flag]: _old, ...rest } = sc;
              return on ? { ...rest, [flag]: true as const } : rest;
            }),
          },
    ),
  };
}

export const setScaleInvert = (doc: ChartDoc, paneId: string, scaleId: string, on: boolean) =>
  setScaleFlag(doc, paneId, scaleId, 'invert', on);

export const setScaleLog = (doc: ChartDoc, paneId: string, scaleId: string, on: boolean) =>
  setScaleFlag(doc, paneId, scaleId, 'log', on);

/** 加一个派生图层(相关性 / 劈叉),单独新开一格放在最下面。 */
/** 这两条图层(不分先后)是否已有一格相关性。同一对只留一格,参数在那张卡片上改。 */
export const hasCorr = (doc: ChartDoc, a: string, b: string): boolean =>
  doc.panes.some((p) =>
    p.layers.some(
      (l) =>
        !isSeriesLayer(l) &&
        l.study.kind === 'corr' &&
        ((l.study.a === a && l.study.b === b) || (l.study.a === b && l.study.b === a)),
    ),
  );

export function addStudy(doc: ChartDoc, study: Study, color: string): ChartDoc {
  if (study.kind === 'corr' && hasCorr(doc, study.a, study.b)) return doc;
  const layer: StudyLayer = { id: nextId(doc, 'l'), study, scale: 'right', color };
  const pane: Pane = { id: nextId(doc, 'p'), stretch: SUB_STRETCH, scales: [BUILTIN.right], layers: [layer] };

  return normalize({ ...doc, panes: [...doc.panes, pane] });
}

/** 改相关性层的参数(窗口 / 口径 / 变化期)。 */
export function setCorrParams(
  doc: ChartDoc,
  layerId: string,
  patch: Partial<Pick<Extract<Study, { kind: 'corr' }>, 'window' | 'mode' | 'horizon'>>,
): ChartDoc {
  return {
    ...doc,
    panes: doc.panes.map((p) => ({
      ...p,
      layers: p.layers.map((l) =>
        l.id === layerId && !isSeriesLayer(l) && l.study.kind === 'corr'
          ? { ...l, study: { ...l.study, ...patch } }
          : l,
      ),
    })),
  };
}

/** 是否有别的图层按它换算(它是某条线的 fit.target)。 */
export const isFitTarget = (doc: ChartDoc, layerId: string): boolean =>
  doc.panes.some((p) => p.layers.some((l) => isSeriesLayer(l) && l.fit?.target === layerId));

/**
 * 参照期对齐:把图层 layerId 换算到 fit.target 的单位,并挪进 target 所在格、挂到 target 的轴上
 * (换算后两者同单位,同一根轴才叠得上);再在最下面加一格劈叉幅度(已有就不重复加)。
 */
export function applyLayerFit(doc: ChartDoc, layerId: string, fit: Fit, gapColor: string): ChartDoc {
  const self = findLayer(doc, layerId);
  const target = findLayer(doc, fit.target);
  if (!self || !target || !isSeriesLayer(self.layer) || !isSeriesLayer(target.layer) || layerId === fit.target) {
    return doc;
  }
  // 本图层已是别人的换算目标:再给它加 fit 会让 pruneRefs 静默去掉那条线的换算(「目标自己也在换算」不允许)
  if (isFitTarget(doc, layerId)) return doc;

  const moved = moveLayer(doc, layerId, target.pane.id);
  const withFit: ChartDoc = {
    ...moved,
    panes: moved.panes.map((p) => ({
      ...p,
      layers: p.layers.map((l) =>
        l.id === layerId && isSeriesLayer(l) ? { ...l, fit, scale: target.layer.scale } : l,
      ),
    })),
  };
  const hasGap = withFit.panes.some((p) =>
    p.layers.some((l) => !isSeriesLayer(l) && l.study.kind === 'gap' && l.study.of === layerId),
  );

  return hasGap ? normalize(withFit) : addStudy(normalize(withFit), { kind: 'gap', of: layerId }, gapColor);
}

/** 取消参照期对齐:去掉 fit 并改挂一根新独立轴(见 detachFit);对应的劈叉格由 normalize 收拾。 */
export function clearLayerFit(doc: ChartDoc, layerId: string): ChartDoc {
  const l = findLayer(doc, layerId)?.layer;
  return l && isSeriesLayer(l) && l.fit ? normalize(detachFit(doc, new Set([layerId]))) : doc;
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
  // 相关性层不挪,也不许别的线挪进相关性格(见 isCorrLayer)
  if (isCorrLayer(hit.layer) || doc.panes.some((p) => p.id === target && hasCorrLayer(p))) return doc;

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
  isObj(x) &&
  isStr(x.id) &&
  (x.id === 'right' || x.id === 'left' ? x.side === x.id : x.side === 'overlay') &&
  (x.invert === undefined || x.invert === true) &&
  (x.log === undefined || x.log === true);

// 颜色限定 #rrggbb:lw-charts 解析不了的颜色会直接抛错(整页白屏),<input type=color> 也只认这种
const isColor = (x: unknown): x is string => typeof x === 'string' && /^#[0-9a-f]{6}$/i.test(x);

// 只看外形会放过 2026-99-01 这种不存在的日期:按 UTC 解析再格式化回来,一致才算真日期
const isDate = (x: unknown): x is string =>
  typeof x === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(x) &&
  !Number.isNaN(Date.parse(`${x}T00:00:00Z`)) &&
  new Date(`${x}T00:00:00Z`).toISOString().slice(0, 10) === x;
const isInt = (x: unknown, lo: number, hi: number): x is number =>
  Number.isInteger(x) && (x as number) >= lo && (x as number) <= hi;

const isFit = (x: unknown): x is Fit =>
  isObj(x) && isStr(x.target) && isDate(x.start) && isDate(x.end) && x.start < x.end;

const isStudy = (x: unknown): x is Study =>
  isObj(x) &&
  (x.kind === 'corr'
    ? isStr(x.a) &&
      isStr(x.b) &&
      isInt(x.window, 5, 2000) &&
      (x.mode === 'level' || x.mode === 'change') &&
      isInt(x.horizon, 1, 500)
    : x.kind === 'gap' && isStr(x.of));

const isLayer = (x: unknown): x is Layer =>
  isObj(x) &&
  isStr(x.id) &&
  isStr(x.scale) &&
  isColor(x.color) &&
  ('series' in x
    ? isStr(x.series) &&
      (x.shift === undefined || isInt(x.shift, -MAX_SHIFT, MAX_SHIFT)) &&
      (x.fit === undefined || isFit(x.fit))
    : isStudy(x.study));

/** 按字段白名单重建图层:载入的 JSON 里多出来的字段(比如数据)一律丢掉,守住「图层不存数据」。 */
function cleanLayer(l: Layer): Layer {
  const base = { id: l.id, scale: l.scale, color: l.color };
  if (!isSeriesLayer(l)) {
    const st = l.study;
    const study: Study =
      st.kind === 'corr'
        ? { kind: 'corr', a: st.a, b: st.b, window: st.window, mode: st.mode, horizon: st.horizon }
        : { kind: 'gap', of: st.of };
    return { ...base, study };
  }

  return {
    ...base,
    series: l.series,
    ...(l.shift ? { shift: l.shift } : {}),
    ...(l.fit ? { fit: { target: l.fit.target, start: l.fit.start, end: l.fit.end } } : {}),
  };
}

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
  // 同一对线(不分先后)只能有一格相关性 —— 与 addStudy 的守卫一致,载入的 JSON 也不能绕过
  const pairs = x.panes
    .flatMap((p) => p.layers)
    .flatMap((l) => (!isSeriesLayer(l) && l.study.kind === 'corr' ? [[l.study.a, l.study.b].sort().join('|')] : []));
  if (!allUnique(pairs)) return null;
  // 相关性层独占一格(它的 −1~1 轴不能与别的线共用),与 addLayer / moveLayer 的守卫一致
  if (x.panes.some((p) => p.layers.length > 1 && p.layers.some(isCorrLayer))) return null;

  // 按字段白名单重建:载入的 JSON 里多出来的字段一律丢掉
  const panes = x.panes.map((p) => ({
    id: p.id,
    stretch: p.stretch,
    scales: p.scales.map((sc) => ({
      id: sc.id,
      side: sc.side,
      ...(sc.invert ? { invert: true as const } : {}),
      ...(sc.log ? { log: true as const } : {}),
    })),
    layers: p.layers.map(cleanLayer),
  }));

  return normalize({ v: 1, panes });
}
