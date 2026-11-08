// 图表编辑器的状态模型:整张图 = 一份带版本号的 JSON(图 → 格 → 纵轴 → 图层)。
// 这份结构是标准 —— 以后旧图表往它上面映射,不是它迁就旧代码。图层只存序列 id,不存数据。
// 本文件全是纯函数:编辑操作返回新文档,并经 normalize 保证不变式。
import { INDICATOR_IDS, INDICATORS, type IndicatorId } from '../../chart/indicatorDefs';
import { withAlpha } from '../../chart/palette';

export type ScaleSide = 'right' | 'left' | 'overlay';

export type Scale = {
  /** 'right' / 'left' 是保留 id(lw-charts 内置轴);独立轴用生成的 s1、s2… */
  id: string;
  side: ScaleSide;
  /** 倒轴(上下颠倒)。是轴的属性:挂在这根轴上的图层一起倒 */
  invert?: true;
  /** 对数坐标。轴上有 ≤0 的值时渲染层按普通坐标画(对数画不了) */
  log?: true;
  /**
   * 自动缩放的上限框 [lo, hi]:轴最多显示到这么宽,一个尖刺不至于把日常波动压扁。只夹轴不改数据;
   * 挂在轴上而不是图层上:同轴的线要一起夹,只夹一条的话别的线照样把轴撑开
   */
  clampVisibleTo?: [number, number];
  /** 自动缩放的下限框 [lo, hi]:轴至少显示这么宽,数据没走到参考线附近时线也在画面里。[0, 0] = 轴要包含 0 */
  expandVisibleTo?: [number, number];
};

/**
 * 叠到 target 上:基准段 [start, end](画面日期)里按日线求出的 target ≈ alpha + beta × 本图层,r = 按水平的相关。
 * 本图层挂自己的轴、按原值画,渲染层每帧按这个比例把它的轴范围对齐 target 的轴(见 useFitSync)。
 * 比例点按钮时算好存下来,不在渲染时重算:页头切到周 / 月线后聚合点变少,重算会让比例漂移甚至算不出来。
 */
export type Fit = { target: string; start: string; end: string; alpha: number; beta: number; r: number };

/**
 * 画法。缺省 = 普通折线。baseline:会穿零的序列画一条基线;step:低频序列画阶梯(两次发布之间值不变)。
 * signed:符号柱(正绿负红、0 基线),看正负和大小的量(净持仓、期限结构)。
 * events:事件竖线,序列里每个日期画一根满高细柱,值不画(发布日、决议日);挂自己的隐形轴,图层的 scale 不起作用。
 *   opacity(0~1,缺省不透明):竖线压在线上面,满色太抢眼;颜色仍只写 #rrggbb(取色器只认这个),透明度单列
 * background:背景色带,序列是 0 / 1 标记,值为 1 的日子整格高染图层颜色(淡色,压在线下面);同样挂自己的隐形轴。
 * candle:蜡烛(涨绿跌红,图层颜色不起作用),只有注册表标了 ohlc 的序列能用;图例 / 分位 / 参考线照旧按收盘
 */
export type LayerRender =
  | { kind: 'line'; baseline?: number; step?: true }
  | { kind: 'signed' }
  | { kind: 'events'; opacity?: number }
  | { kind: 'background' }
  | { kind: 'candle' };
/** 有绝对含义的阈值线(如「临界 4」),跟随图层所在的纵轴 */
export type RefLine = { price: number; title: string; color?: string };

/** 固定常态带的上下两条参考线(基本面锚,替代自指的 P5/P95;出带 = 告警,不是确诊)。同 TradingView 的两条 hline */
export function normalBand(lo: number, hi: number): RefLine[] {
  return [
    { price: lo, title: '常态下限' },
    { price: hi, title: '常态上限' },
  ];
}

/** 按图层自身历史算 P5 / P95 参考线;riskTail = 哪一端是风险(背景染红 / 绿);since = 只用这天起的数据算分位 */
export type PercentileBand = { riskTail?: 'low' | 'high'; since?: string };

/**
 * 计算图层:本图层画的不是 series 本身,而是「series 运算 calc.series」(A − B 价差、A ÷ B 比值)。
 * 两条按日期对齐后现算(同频取同一天、异频锚低频那条、fill 取并集,见 web/chart/analysis 的 combineSeries;
 * 取数入口是 views/chartDoc/useSeriesData 的 calcPoints),注册表里不必为每个组合另登一条。
 */
export type CalcOp = '-' | '/';
/** fill:两条日期取并集、各自沿用最近值(跨市场利差用,一边休市时那边确实没变);缺省按频率自动对齐 */
export type Calc = { op: CalcOp; series: string; fill?: true };

/**
 * 指标:本图层画的不是 series 本身,而是对它算的指标(EMA 一组、布林带、MACD、RSI;计算见 chart/indicatorDefs)。
 * 同 TradingView 布局里的指标实例:只存 id + 参数,不存代码、不存算出来的数。periods 只给 EMA / RSI(缺省用默认那组)
 */
export type Indicator = { id: IndicatorId; periods?: number[] };

export type Layer = {
  id: string;
  /** 引用同一格 scales 里的某个 id */
  scale: string;
  color: string;
  /** 注册表 id(计算图层里是被减数 / 被除数 A) */
  series: string;
  calc?: Calc;
  /** 平移的交易日数,> 0 往后(右)挪 —— 看它是不是领先别的线 */
  shift?: number;
  fit?: Fit;
  /** 图例名;缺省用注册表里的名称 */
  title?: string;
  /** 隐藏:不画线、不撑纵轴,图例里照给读数(同 TradingView 图例行的眼睛) */
  hidden?: true;
  render?: LayerRender;
  refLines?: RefLine[];
  percentile?: PercentileBand;
  indicator?: Indicator;
};

export type Pane = {
  id: string;
  /** 高度比例(lw-charts stretch factor) */
  stretch: number;
  scales: Scale[];
  layers: Layer[];
  /** 读法说明(悬停 ⓘ 显示) */
  desc?: string;
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
 * 叠加关系失效时去掉 fit:目标没了 / 目标自己也叠在别人上 / 两者不在同一格(底色、对齐都按同格算)/
 * B 的轴上还挂着别的线(含 A:同一根轴上「按 A 的范围反推 B 的范围」会自己追自己,纵轴每帧乱跳)。
 */
function pruneRefs(doc: ChartDoc): ChartDoc {
  const layers = new Map(doc.panes.flatMap((p) => p.layers.map((l) => [l.id, l] as const)));
  const paneOf = new Map(doc.panes.flatMap((p) => p.layers.map((l) => [l.id, p] as const)));
  const fitOk = (l: Layer) => {
    if (!l.fit) return true;
    const target = layers.get(l.fit.target);
    const pane = paneOf.get(l.id)!;
    return (
      !!target &&
      target.id !== l.id &&
      !target.fit &&
      paneOf.get(target.id) === pane &&
      pane.layers.every((o) => o.id === l.id || o.scale !== l.scale)
    );
  };

  return detachFit(doc, new Set([...layers.values()].filter((l) => !fitOk(l)).map((l) => l.id)));
}

/**
 * 去掉这些图层的 fit,并各自改挂本格一根新独立轴。取消叠加(或叠加目标没了)后它按原始数值画,
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
      const hit = p.layers.filter((l) => ids.has(l.id));
      if (hit.length === 0) return p;
      return {
        ...p,
        scales: [...p.scales, ...hit.map((l) => ({ id: scaleOf(l.id), side: 'overlay' as const }))],
        layers: p.layers.map((l) => {
          if (!ids.has(l.id)) return l;
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
  // 先把引用了不存在的独立轴的图层退回右轴,再查叠加关系:顺序反过来的话,退回右轴后和 A 共轴的叠加线
  // 会漏过 pruneRefs(手写 / 手改的 JSON 导入时会遇到;编辑操作不会留下引用缺失的轴)
  const fixedRefs: ChartDoc = {
    ...doc,
    panes: doc.panes.map((p) => {
      const known = new Set(p.scales.map((s) => s.id));
      return {
        ...p,
        layers: p.layers.map((l) =>
          known.has(l.scale) || l.scale === 'right' || l.scale === 'left' ? l : { ...l, scale: 'right' },
        ),
      };
    }),
  };
  const panes = pruneRefs(fixedRefs)
    .panes.filter((p) => p.layers.length > 0)
    .map((p) => {
      const known = new Map(p.scales.map((s) => [s.id, s]));
      const { layers } = p;
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

function mapLayer(doc: ChartDoc, layerId: string, fn: (l: Layer, p: Pane) => Partial<Layer>): ChartDoc {
  return {
    ...doc,
    panes: doc.panes.map((p) => ({
      ...p,
      layers: p.layers.map((l) => (l.id === layerId ? { ...l, ...fn(l, p) } : l)),
    })),
  };
}

/** 改图层的一个可选字段(undefined = 删掉)。经 canonicalLayer 重建:字段顺序固定,值为 undefined 的字段不留 */
function setLayerField<K extends keyof Layer>(doc: ChartDoc, layerId: string, key: K, value: Layer[K]): ChartDoc {
  return {
    ...doc,
    panes: doc.panes.map((p) => ({
      ...p,
      layers: p.layers.map((l) => (l.id === layerId ? canonicalLayer({ ...l, [key]: value }) : l)),
    })),
  };
}

export function findLayer(doc: ChartDoc, layerId: string): { pane: Pane; layer: Layer } | undefined {
  const pane = doc.panes.find((p) => p.layers.some((l) => l.id === layerId));
  const layer = pane?.layers.find((l) => l.id === layerId);

  return pane && layer ? { pane, layer } : undefined;
}

/**
 * 这一格里被叠加的线(B)占着的轴。别的线不能再挂上去:B 的轴范围跟着 A 走,挂上去的线会被强行按 A 的比例缩放,
 * 叠加关系也会被 pruneRefs 解除 —— 加线 / 挪线 / 换轴碰到它都改开独立轴或不让换。
 */
export function fitScaleIds(p: Pane): Set<string> {
  return new Set(p.layers.filter((l) => l.fit).map((l) => l.scale));
}

/** 加一条图层:默认第 0 格、右轴(右轴被叠加的线占着就开独立轴)。空图时新建主格。 */
/** render:新图层的画法(事件序列加进来直接画竖线);缺省折线 */
export function addLayer(doc: ChartDoc, series: string, color: string, render?: LayerRender): ChartDoc {
  const [first, ...rest] = doc.panes;
  const overlay =
    first && fitScaleIds(first).has('right') ? { id: nextId(doc, 's'), side: 'overlay' as const } : undefined;
  const layer: Layer = {
    id: nextId(doc, 'l'),
    series,
    scale: overlay?.id ?? 'right',
    color,
    ...(render && { render }),
  };
  const panes = first
    ? [
        { ...first, scales: overlay ? [...first.scales, overlay] : first.scales, layers: [...first.layers, layer] },
        ...rest,
      ]
    : [{ id: nextId(doc, 'p'), stretch: MAIN_STRETCH, scales: [BUILTIN.right], layers: [layer] }, ...doc.panes];

  return normalize({ ...doc, panes });
}

/**
 * 给某条线加一个指标(同 TradingView 的「添加指标」):对同一条序列(含它的计算)算。
 * 叠加类(EMA、布林带)放在源线同一格、同一根轴,紧跟在源线后面;振荡类(MACD、RSI)在源线那格下方新开一格。
 * 之后能像普通图层一样挪格、换轴
 */
export function addIndicator(doc: ChartDoc, layerId: string, id: IndicatorId): ChartDoc {
  const src = findLayer(doc, layerId);
  if (!src || !canAddIndicator(src.layer, id)) return doc;

  const layer: Layer = {
    id: nextId(doc, 'l'),
    series: src.layer.series,
    ...(src.layer.calc && { calc: src.layer.calc }),
    // 跟着源线平移(同 TradingView,指标跟源线走;之后两层各改各的)
    ...(src.layer.shift && { shift: src.layer.shift }),
    scale: INDICATORS[id].place === 'overlay' ? src.layer.scale : 'right',
    color: src.layer.color,
    indicator: { id },
  };
  const at = doc.panes.indexOf(src.pane);
  const panes =
    INDICATORS[id].place === 'overlay'
      ? doc.panes.map((p) => {
          if (p !== src.pane) return p;
          const i = p.layers.indexOf(src.layer);
          return { ...p, layers: [...p.layers.slice(0, i + 1), layer, ...p.layers.slice(i + 1)] };
        })
      : [
          ...doc.panes.slice(0, at + 1),
          { id: nextId(doc, 'p'), stretch: SUB_STRETCH, scales: [BUILTIN.right], layers: [layer] },
          ...doc.panes.slice(at + 1),
        ];

  return normalize({ ...doc, panes });
}

/**
 * 能不能给这条线加这个指标:指标不再套指标、标记图层不加;叠加对比里被对齐的 B 腿独占一根轴(每帧按 A 的范围换算),
 * 叠加类指标挂上去会让 normalize 判叠加失效、悄悄拆掉 —— 振荡类新开一格不受影响
 */
export function canAddIndicator(l: Layer, id: IndicatorId): boolean {
  // 标记图层(竖线、色带)的值只是 0 / 1 标志,算均线没有意义
  if (l.indicator || isMarkLayer(l)) return false;
  return !(l.fit && INDICATORS[id].place === 'overlay');
}

/** 改指标的周期(EMA / RSI);undefined = 回到默认那组;周期非法(重复等)不改 */
export function setIndicatorPeriods(doc: ChartDoc, layerId: string, periods: number[] | undefined): ChartDoc {
  const l = findLayer(doc, layerId)?.layer;
  const next = l?.indicator && { id: l.indicator.id, ...(periods && { periods }) };
  if (!next || !isIndicator(next)) return doc;

  return setLayerField(doc, layerId, 'indicator', next);
}

export function removeLayer(doc: ChartDoc, layerId: string): ChartDoc {
  return normalize({
    ...doc,
    panes: doc.panes.map((p) => ({ ...p, layers: p.layers.filter((l) => l.id !== layerId) })),
  });
}

/** 拿掉某条序列的全部图层(下拉框取消勾选)。叠在它们上的线由 normalize 改挂独立轴。 */
export function removeSeries(doc: ChartDoc, series: string): ChartDoc {
  return normalize({
    ...doc,
    panes: doc.panes.map((p) => ({
      ...p,
      // 计算图层不算「这条序列」:搜索框取消勾选 A 时不该连带删掉 A − B,它在卡片上单独删
      layers: p.layers.filter((l) => l.series !== series || !!l.calc),
    })),
  });
}

/** 设 / 去掉计算(undefined = 还原成序列本身)。 */
export function setLayerCalc(doc: ChartDoc, layerId: string, calc: Calc | undefined): ChartDoc {
  const cur = findLayer(doc, layerId)?.layer;
  if (!cur || (cur.calc?.op === calc?.op && cur.calc?.series === calc?.series && cur.calc?.fill === calc?.fill))
    return doc;

  // 计算图层是现算的一条值,没有 K 线:原来画成蜡烛的,改回折线(不留一个画不出来的画法在文档里)
  const next = setLayerField(doc, layerId, 'calc', calc);
  return calc && cur.render?.kind === 'candle' ? setLayerField(next, layerId, 'render', undefined) : next;
}

/** 竖线实际画出来的颜色:写了透明度就叠上(编辑器着色、编辑器判断要不要重灌、固定面板转换三处共用) */
export function markColor(l: Layer): string {
  const opacity = l.render?.kind === 'events' ? l.render.opacity : undefined;
  return opacity === undefined ? l.color : withAlpha(l.color, opacity);
}

/** 标记图层(事件竖线、背景色带):值不画、挂自己的隐形轴、不算「一条线」(编辑器与固定面板共用这个判断) */
export function isMarkLayer(l: Layer): boolean {
  return l.render?.kind === 'events' || l.render?.kind === 'background';
}

/**
 * 渲染器里真会建出来的轴:有非竖线图层挂着的。竖线挂自己的隐形轴(ev-<图层 id>),它在文档里占的那根独立轴
 * lw-charts 里没有 —— 对它调 priceScale(id) 会抛错。内置左右轴 lw-charts 每格都有,调用方自己补
 */
export function liveScaleIds(pane: Pane): string[] {
  return [...new Set(pane.layers.filter((l) => !isMarkLayer(l)).map((l) => l.scale))];
}

/** 画法。undefined = 折线(删掉字段) */
export function setLayerRender(doc: ChartDoc, layerId: string, render: LayerRender | undefined): ChartDoc {
  const cur = findLayer(doc, layerId)?.layer;
  if (!cur || JSON.stringify(cur.render) === JSON.stringify(render)) return doc;

  return setLayerField(doc, layerId, 'render', render);
}

/** 显隐。显示 = 删掉字段 */
export function setLayerHidden(doc: ChartDoc, layerId: string, hidden: boolean): ChartDoc {
  const cur = findLayer(doc, layerId)?.layer;
  if (!cur || !!cur.hidden === hidden) return doc;

  return setLayerField(doc, layerId, 'hidden', hidden ? true : undefined);
}

/** 平移(交易日)。0 = 不平移,字段删掉;超过上限按上限截。 */
export function setLayerShift(doc: ChartDoc, layerId: string, shift: number): ChartDoc {
  const n = Math.max(-MAX_SHIFT, Math.min(MAX_SHIFT, Math.round(shift) || 0));
  const cur = findLayer(doc, layerId)?.layer;
  if (!cur || (cur.shift ?? 0) === n) return doc;

  return setLayerField(doc, layerId, 'shift', n || undefined);
}

/** 按固定字段顺序重建一根轴(id、side、invert、log、clampVisibleTo、expandVisibleTo):先开哪个开关都一样,复制出去的 JSON 再导入文本原样不变。 */
function canonicalScale(sc: Scale): Scale {
  return {
    id: sc.id,
    side: sc.side,
    ...(sc.invert ? { invert: true as const } : {}),
    ...(sc.log ? { log: true as const } : {}),
    ...(sc.clampVisibleTo ? { clampVisibleTo: [sc.clampVisibleTo[0], sc.clampVisibleTo[1]] } : {}),
    ...(sc.expandVisibleTo ? { expandVisibleTo: [sc.expandVisibleTo[0], sc.expandVisibleTo[1]] } : {}),
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
              return canonicalScale(on ? { ...rest, [flag]: true as const } : rest);
            }),
          },
    ),
  };
}

export function setScaleInvert(doc: ChartDoc, paneId: string, scaleId: string, on: boolean) {
  return setScaleFlag(doc, paneId, scaleId, 'invert', on);
}

export function setScaleLog(doc: ChartDoc, paneId: string, scaleId: string, on: boolean) {
  return setScaleFlag(doc, paneId, scaleId, 'log', on);
}

/** 是否有别的图层按它换算(它是某条线的 fit.target)。 */
export function isFitTarget(doc: ChartDoc, layerId: string): boolean {
  return doc.panes.some((p) => p.layers.some((l) => l.fit?.target === layerId));
}

/**
 * 叠到 target 上:挪进 target 所在格,挂一根自己的轴 —— 优先 target 对面的内置轴(有刻度可读),
 * 两侧都被别的线占了才开独立轴(没刻度);反向时这根轴设成倒轴(invert 由调用方按比例符号算好)。
 */
export function applyLayerFit(doc: ChartDoc, layerId: string, fit: Fit, invert: boolean): ChartDoc {
  const self = findLayer(doc, layerId);
  const target = findLayer(doc, fit.target);
  if (!self || !target || layerId === fit.target) return doc;
  // 本图层已是别人的换算目标:再给它加 fit 会让 pruneRefs 静默去掉那条线的换算(「目标自己也在换算」不允许)
  if (isFitTarget(doc, layerId)) return doc;

  // 已在 A 的格(同一对换视口重新叠加)就不挪:同格 moveLayer 会把 B 排到末尾,冲掉用户调好的顺序
  const moved = self.pane.id === target.pane.id ? doc : moveLayer(doc, layerId, target.pane.id);
  const pane = moved.panes.find((p) => p.id === target.pane.id)!;
  const taken = new Set(pane.layers.filter((l) => l.id !== layerId).map((l) => l.scale));
  const sides = target.layer.scale === 'left' ? (['right', 'left'] as const) : (['left', 'right'] as const);
  const side = sides.find((id) => !taken.has(id));
  const overlay = side ? undefined : { id: nextId(moved, 's'), side: 'overlay' as const };
  const scaleId = side ?? overlay!.id;

  const withFit = normalize({
    ...moved,
    panes: moved.panes.map((p) =>
      p.id !== pane.id
        ? p
        : {
            ...p,
            scales: overlay ? [...p.scales, overlay] : p.scales,
            layers: p.layers.map((l) => (l.id === layerId ? canonicalLayer({ ...l, fit, scale: scaleId }) : l)),
          },
    ),
  });

  // B 的轴只能是线性:B 轴范围按线性比例从 A 推出来(B 原来那根轴若开着对数,这里关掉)
  return setScaleLog(setScaleInvert(withFit, pane.id, scaleId, invert), pane.id, scaleId, false);
}

/** 取消叠加:去掉 fit 并改挂一根新独立轴(见 detachFit)。 */
export function clearLayerFit(doc: ChartDoc, layerId: string): ChartDoc {
  const l = findLayer(doc, layerId)?.layer;
  return l?.fit ? normalize(detachFit(doc, new Set([layerId]))) : doc;
}

export function setLayerColor(doc: ChartDoc, layerId: string, color: string): ChartDoc {
  return mapLayer(doc, layerId, () => ({ color }));
}

/** 换轴。新开独立轴 = 在本格加一根 overlay;旧轴没人用了由 normalize 回收。 */
export function setLayerScale(doc: ChartDoc, layerId: string, choice: ScaleChoice): ChartDoc {
  const hit = findLayer(doc, layerId);
  if (!hit) return doc;

  const { scaleId, added } = resolveScale(doc, choice);
  if (fitScaleIds(hit.pane).has(scaleId)) return doc;
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
  const targetPane = doc.panes.find((p) => p.id === target);
  // 独立轴是源格私有的,得新开;带过去的内置轴若在目标格被叠加的线占着,也改开独立轴
  const needOverlay = srcScale?.side === 'overlay' || (!!targetPane && fitScaleIds(targetPane).has(hit.layer.scale));
  const overlay = needOverlay ? { id: nextId(doc, 's'), side: 'overlay' as const } : undefined;
  const layer: Layer = { ...hit.layer, scale: overlay?.id ?? hit.layer.scale };
  const builtin = layer.scale === 'right' || layer.scale === 'left' ? BUILTIN[layer.scale] : undefined;
  const carried = [overlay ?? builtin].filter((s) => s !== undefined);

  // 源格只剩这一条线时,源格会被 normalize 删掉:拖到新格 = 整格换了位置,说明跟着走;
  // 拖进已有格 = 两格并成一格,只留目标格自己的(源格那段说明讲的是另一件事,带过去反而误导)
  const { desc } = hit.pane.layers.length === 1 ? hit.pane : {};
  const paneMeta = desc !== undefined ? { desc } : {};

  const withoutLayer = doc.panes.map((p) => ({ ...p, layers: p.layers.filter((l) => l.id !== layerId) }));
  const panes =
    target === 'new'
      ? [...withoutLayer, { id: nextId(doc, 'p'), stretch: SUB_STRETCH, scales: carried, layers: [layer], ...paneMeta }]
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

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}
function isStr(x: unknown): x is string {
  return typeof x === 'string' && x.length > 0;
}

// 保留 id 与 side 必须一一对应:'right' / 'left' 只能是内置轴,其它 id 只能是独立轴。
// 否则 {id:'left', side:'overlay'} 这种会让图层挂着左轴、整图左轴却不开。
function isScale(x: unknown): x is Scale {
  return (
    isObj(x) &&
    isStr(x.id) &&
    (x.id === 'right' || x.id === 'left' ? x.side === x.id : x.side === 'overlay') &&
    (x.invert === undefined || x.invert === true) &&
    (x.log === undefined || x.log === true) &&
    (x.clampVisibleTo === undefined || isRange(x.clampVisibleTo, false)) &&
    (x.expandVisibleTo === undefined || isRange(x.expandVisibleTo, true))
  );
}

// 下限框允许 lo = hi:[0, 0] = 「轴要包含 0」;上限框 lo = hi 夹成一条线,没意义
function isRange(x: unknown, allowPoint: boolean): x is [number, number] {
  return Array.isArray(x) && x.length === 2 && isNum(x[0]) && isNum(x[1]) && (allowPoint ? x[0] <= x[1] : x[0] < x[1]);
}

// 颜色限定 #rrggbb:lw-charts 解析不了的颜色会直接抛错(整页白屏),<input type=color> 也只认这种
function isColor(x: unknown): x is string {
  return typeof x === 'string' && /^#[0-9a-f]{6}$/i.test(x);
}

// 只看外形会放过 2026-99-01 这种不存在的日期:按 UTC 解析再格式化回来,一致才算真日期
function isDate(x: unknown): x is string {
  return (
    typeof x === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(x) &&
    !Number.isNaN(Date.parse(`${x}T00:00:00Z`)) &&
    new Date(`${x}T00:00:00Z`).toISOString().slice(0, 10) === x
  );
}
function isInt(x: unknown, lo: number, hi: number): x is number {
  return Number.isInteger(x) && (x as number) >= lo && (x as number) <= hi;
}

function isNum(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}
function isFit(x: unknown): x is Fit {
  return (
    isObj(x) &&
    isStr(x.target) &&
    isDate(x.start) &&
    isDate(x.end) &&
    x.start < x.end &&
    isNum(x.alpha) &&
    isNum(x.beta) &&
    x.beta !== 0 &&
    isNum(x.r)
  );
}

function isRender(x: unknown): x is LayerRender {
  if (!isObj(x)) return false;
  if (x.kind === 'signed' || x.kind === 'background' || x.kind === 'candle') return true;
  if (x.kind === 'events') return x.opacity === undefined || (isNum(x.opacity) && x.opacity > 0 && x.opacity <= 1);

  return (
    x.kind === 'line' && (x.baseline === undefined || isNum(x.baseline)) && (x.step === undefined || x.step === true)
  );
}
function isRefLine(x: unknown): x is RefLine {
  return isObj(x) && isNum(x.price) && isStr(x.title) && (x.color === undefined || isColor(x.color));
}
function isPercentile(x: unknown): x is PercentileBand {
  return (
    isObj(x) &&
    (x.riskTail === undefined || x.riskTail === 'low' || x.riskTail === 'high') &&
    (x.since === undefined || isDate(x.since))
  );
}

// 序列 id 里不能有取数请求键的分隔符(| @ #,见 useSeriesData 的 requestKey):
// 否则 "ust2y@5" 这种导入后会被拆成「ust2y、平移 5 天」,图上画的和 JSON 写的不是一回事
function isSeriesId(x: unknown): x is string {
  return isStr(x) && !/[|@#]/.test(x);
}

function isCalc(x: unknown): x is Calc {
  return (
    isObj(x) && (x.op === '-' || x.op === '/') && isSeriesId(x.series) && (x.fill === undefined || x.fill === true)
  );
}

// 周期:1~1000 的整数,1~10 个、不重复(重复会展开出同 id 的两条子线);布林带 / MACD 参数固定,不收 periods
function isIndicator(x: unknown): x is Indicator {
  if (!isObj(x) || !INDICATOR_IDS.includes(x.id as IndicatorId)) return false;
  if (x.periods === undefined) return true;

  return (
    !!INDICATORS[x.id as IndicatorId].periods &&
    Array.isArray(x.periods) &&
    x.periods.length > 0 &&
    x.periods.length <= 10 &&
    x.periods.every((n) => isInt(n, 1, 1000)) &&
    new Set(x.periods).size === x.periods.length
  );
}

function isLayer(x: unknown): x is Layer {
  return (
    isObj(x) &&
    isStr(x.id) &&
    isStr(x.scale) &&
    isColor(x.color) &&
    isSeriesId(x.series) &&
    (x.calc === undefined || isCalc(x.calc)) &&
    (x.shift === undefined || isInt(x.shift, -MAX_SHIFT, MAX_SHIFT)) &&
    (x.fit === undefined || isFit(x.fit)) &&
    (x.title === undefined || isStr(x.title)) &&
    (x.hidden === undefined || x.hidden === true) &&
    (x.render === undefined || isRender(x.render)) &&
    (x.refLines === undefined || (Array.isArray(x.refLines) && x.refLines.every(isRefLine))) &&
    (x.percentile === undefined || isPercentile(x.percentile)) &&
    // 标记图层(竖线、色带)的值只是 0 / 1 标志,不能同时是指标(编辑器里加不出,手写 JSON 也拒收)
    (x.indicator === undefined ||
      (isIndicator(x.indicator) &&
        !(isObj(x.render) && (x.render.kind === 'events' || x.render.kind === 'background'))))
  );
}

function canonicalRender(r: LayerRender): LayerRender {
  if (r.kind === 'events') return { kind: r.kind, ...(r.opacity !== undefined ? { opacity: r.opacity } : {}) };
  if (r.kind !== 'line') return { kind: r.kind };

  return {
    kind: r.kind,
    ...(r.baseline !== undefined ? { baseline: r.baseline } : {}),
    ...(r.step ? { step: true as const } : {}),
  };
}
function canonicalRefLine(r: RefLine): RefLine {
  return {
    price: r.price,
    title: r.title,
    ...(r.color !== undefined ? { color: r.color } : {}),
  };
}
function canonicalPercentile(p: PercentileBand): PercentileBand {
  return {
    ...(p.riskTail ? { riskTail: p.riskTail } : {}),
    ...(p.since ? { since: p.since } : {}),
  };
}

/**
 * 按字段白名单、固定顺序重建图层(id、series、calc、scale、color、shift、fit、title、hidden、render、refLines、percentile、indicator):载入的 JSON 里多出来的字段(比如数据)一律丢掉,
 * 守住「图层不存数据」;编辑操作改 shift / fit 后也走这里,先改哪个字段都一样,复制出去的 JSON 再导入文本原样不变。
 */
function canonicalLayer(l: Layer): Layer {
  return {
    id: l.id,
    series: l.series,
    ...(l.calc ? { calc: { op: l.calc.op, series: l.calc.series, ...(l.calc.fill && { fill: true as const }) } } : {}),
    scale: l.scale,
    color: l.color,
    ...(l.shift ? { shift: l.shift } : {}),
    ...(l.fit
      ? {
          fit: {
            target: l.fit.target,
            start: l.fit.start,
            end: l.fit.end,
            alpha: l.fit.alpha,
            beta: l.fit.beta,
            r: l.fit.r,
          },
        }
      : {}),
    ...(l.title !== undefined ? { title: l.title } : {}),
    ...(l.hidden ? { hidden: true as const } : {}),
    ...(l.render ? { render: canonicalRender(l.render) } : {}),
    ...(l.refLines ? { refLines: l.refLines.map(canonicalRefLine) } : {}),
    ...(l.percentile ? { percentile: canonicalPercentile(l.percentile) } : {}),
    ...(l.indicator
      ? { indicator: { id: l.indicator.id, ...(l.indicator.periods && { periods: [...l.indicator.periods] }) } }
      : {}),
  };
}

// 'new' 是 PaneTarget 里「新开一格」的保留字,格不能叫这个
function isPane(x: unknown): x is Pane {
  return (
    isObj(x) &&
    isStr(x.id) &&
    x.id !== 'new' &&
    typeof x.stretch === 'number' &&
    Number.isFinite(x.stretch) &&
    x.stretch > 0 &&
    Array.isArray(x.scales) &&
    x.scales.every(isScale) &&
    Array.isArray(x.layers) &&
    x.layers.every(isLayer) &&
    (x.desc === undefined || isStr(x.desc))
  );
}

function allUnique(ids: string[]) {
  return new Set(ids).size === ids.length;
}

/**
 * id 唯一性:格 / 图层 / 独立轴的 id 全文档唯一(渲染层按图层 id 建 Map,重复会让多条图层坍缩成一条);
 * 内置轴 'right' / 'left' 每格各有一根,只要求格内不重复。
 */
function idsUnique(panes: Pane[]): boolean {
  return (
    allUnique(
      panes.flatMap((p) => [
        p.id,
        ...p.layers.map((l) => l.id),
        ...p.scales.filter((s) => s.side === 'overlay').map((s) => s.id),
      ]),
    ) && panes.every((p) => allUnique(p.scales.map((s) => s.id)))
  );
}

/** 结构不对 / id 冲突返回 null;通过则过一遍 normalize(修补引用不一致这类可自愈的问题)。 */
export function parseChartDoc(x: unknown): ChartDoc | null {
  if (!isObj(x) || x.v !== 1 || !Array.isArray(x.panes) || !x.panes.every(isPane)) return null;
  if (!idsUnique(x.panes)) return null;

  // 按字段白名单重建:载入的 JSON 里多出来的字段一律丢掉
  const panes = x.panes.map((p) => ({
    id: p.id,
    stretch: p.stretch,
    scales: p.scales.map(canonicalScale),
    layers: p.layers.map(canonicalLayer),
    ...(p.desc !== undefined ? { desc: p.desc } : {}),
  }));

  return normalize({ v: 1, panes });
}
