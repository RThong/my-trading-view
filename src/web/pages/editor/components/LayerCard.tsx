import { type DragEvent, useState } from 'react';
import { CircleAlert, GripVertical, Settings2, X } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { cn } from '../../../lib/utils';
import { NativeSelect, NativeSelectOption } from '../../../components/ui/native-select';
import { Popover, PopoverContent, PopoverTrigger } from '../../../components/ui/popover';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../../components/ui/tabs';
import {
  canAddIndicator,
  hasIndicator,
  fitScaleIds,
  isMarkLayer,
  onItsScale,
  isFitTarget,
  SCALE_MODES,
  scaleMode,
  scaleName,
  type CalcOp,
  type ChartDoc,
  type Fit,
  type Layer,
  type Pane,
  type ScaleChoice,
  type ScaleMode,
} from '../../../views/chartDoc/chartDoc';
import { canCandle, canVolume, drawnKind } from '../../../views/chartDoc/registry';
import { CandleSwatch } from '../../../views/chartDoc/CandleSwatch';
import { baseLabel, layerLabel } from '../../../views/chartDoc/layerLabel';
import { NumberField } from './NumberField';
import { INDICATOR_IDS, INDICATORS, type IndicatorId, periodsOf } from '../../../chart/indicatorDefs';
import { allSevenDay, plotsOf } from '../../../views/chartDoc/layerPoints';
import { stripsDrawable } from '../../../views/chartDoc/useAxisDecor';
import { SeriesSelect } from './SeriesSelect';
import { ColorPicker } from './ColorPicker';
import { usedColors } from '../usedColors';
import type { ChartDocActions } from '../hooks/useChartDoc';
import { ACTIVE, LOCKED_TITLE, NOT_POSITIVE_NOTE, ScaleControls } from './ScaleControls';

export type CardActions = Pick<
  ChartDocActions,
  | 'setScale'
  | 'setColor'
  | 'remove'
  | 'setShift'
  | 'setCalc'
  | 'setRender'
  | 'setInvert'
  | 'setMode'
  | 'setShow'
  | 'clearFit'
  | 'addIndicator'
  | 'removeIndicator'
  | 'setPeriods'
>;

// <select> 的 value 只能是字符串:挂轴选择编码成 right / left / new / ov:<轴 id>
function encodeScale(scaleId: string) {
  return scaleId === 'right' || scaleId === 'left' ? scaleId : `ov:${scaleId}`;
}
function decodeScale(v: string): ScaleChoice {
  return v === 'right' || v === 'left' ? v : v === 'new' ? 'newOverlay' : { overlay: v.slice(3) };
}

/** 这条线加不了这个指标的原因(能加、或已加上可以去掉 = undefined),按钮置灰时悬停显示 */
function indicatorBlocked(doc: ChartDoc, layer: Layer, id: IndicatorId): string | undefined {
  if (hasIndicator(doc, layer, id) || canAddIndicator(layer, id)) return undefined;
  if (layer.render?.kind === 'volume') return '成交量柱周 / 月线按期求和,指标按每期最后一天算会对不上,不能加';
  if (id === 'volume' && !canVolume(layer)) return '只有 Yahoo 任意代码(yh:)带成交量;内置 ETF 的数据在库里没存成交量';
  return '叠加对比里被对齐的线独占一根轴,叠加类指标挂不上去';
}

function stopPropagation(e: DragEvent) {
  e.stopPropagation();
}

type Props = {
  doc: ChartDoc;
  layer: Layer;
  pane: Pane;
  /** 这张卡片所挂的轴能否用对数 / 百分比 / 起点 100(轴上所有图层的值都 > 0),由列表按整根轴算好传进来 */
  positive: boolean;
  actions: CardActions;
  faded: boolean;
  /** 在这张卡片顶上画插入提示线 */
  insertMark: boolean;
  drop: { onDragOver: (e: DragEvent) => void; onDrop: (e: DragEvent) => void };
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
};

export function LayerCard({
  doc,
  layer,
  pane,
  positive,
  actions,
  faded,
  insertMark,
  drop,
  onDragStart,
  onDragEnd,
}: Props) {
  const overlays = pane.scales.filter((s) => s.side === 'overlay');
  const fitScales = fitScaleIds(pane);
  const scale = pane.scales.find((s) => s.id === layer.scale);
  // 叠加的两头(B、被叠的 A)都不拖、不换轴、不平移:B 的轴跟着 A 的轴走、两者得留在同一格,
  // 比例也是按点按钮时的相对位置算的,任何一头挪了就对不上
  const fixed = !!layer.fit || isFitTarget(doc, layer.id);
  // 标记图层(竖线、背景色带)挂自己的隐形轴、值不画:换轴、计算、平移、倒轴对数都没意义,卡片只留颜色和删除
  const events = isMarkLayer(layer);
  // 同格里和它挂同一根轴的其它线:同一根轴只有一套刻度,拖线 = 挪这根轴,会一起动。标记图层不挂在这根轴上,不算
  const sharers = onItsScale(layer)
    ? pane.layers.filter((l) => l.id !== layer.id && l.scale === layer.scale && onItsScale(l))
    : [];
  const onOverlay = layer.scale !== 'right' && layer.scale !== 'left';
  const axisName = scaleName(pane, layer.scale);
  // 独立轴的刻度真画出来了(勾了显示刻度、且这一格右轴有线可挂,见 useAxisDecor):这时同左右轴,在轴上右键改
  const drawn = !!scale?.show && stripsDrawable(doc, pane.id);
  const inverted = !!scale?.invert;
  const mode = scaleMode(scale);
  const modeIneffective = mode !== 'normal' && !positive;
  // 计算只选了运算、还没选第二条时先记在卡片上:CalcRow 在弹层里,弹层一关 / 切 tab 就卸载,记在那里会丢
  const [pendingCalc, setPendingCalc] = useState<PendingCalc>();

  return (
    <li
      draggable={!fixed}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      {...drop}
      className={
        (fixed ? 'relative ' : 'relative cursor-grab active:cursor-grabbing ') +
        'rounded border border-neutral-800 bg-neutral-950 px-1.5 py-1.5 ' +
        (faded ? 'opacity-40 ' : '') +
        (insertMark
          ? "before:absolute before:inset-x-0 before:-top-1 before:h-0.5 before:rounded before:bg-sky-500 before:content-['']"
          : '')
      }
    >
      <div className="flex items-center gap-1.5">
        <GripVertical size={14} className={`shrink-0 ${fixed ? 'invisible' : 'text-neutral-600'}`} />
        {/* 蜡烛按涨绿跌红画、指标各条线配色固定,图层颜色都不起作用:不给取色器(占同样宽度,名字不跳) */}
        {drawnKind(layer) === 'candle' ? (
          <CandleSwatch className="h-4 w-4 shrink-0" />
        ) : layer.indicator ? (
          <span
            className="h-4 w-4 shrink-0 rounded"
            style={{ background: plotsOf(layer, false)[0]?.color }}
            title="配色固定"
          />
        ) : (
          <ColorPicker value={layer.color} onChange={(c) => actions.setColor(layer.id, c)} used={usedColors(doc)} />
        )}
        <span
          className={`min-w-0 flex-1 truncate text-sm ${layer.hidden ? 'text-neutral-500' : 'text-neutral-200'}`}
          title={layerLabel(doc, layer)}
        >
          {layerLabel(doc, layer)}
        </span>
        {sharers.length > 0 && (
          <Tip
            text={`和 ${sharers.map((l) => baseLabel(doc, l.id)).join('、')} 共用${axisName},拖动会一起动;要单独拖,把纵轴改成别的轴`}
          />
        )}
        {/* 成交量指标挂自己的隐形轴(只占底部一条),换轴没有意义 */}
        {!fixed && !events && layer.indicator?.id !== 'volume' && (
          <NativeSelect
            size="xs"
            className="shrink-0"
            value={encodeScale(layer.scale)}
            onChange={(e) => actions.setScale(layer.id, decodeScale(e.target.value))}
            title="挂哪根纵轴"
          >
            {/* 被叠加的线占着的轴不列:挂上去会被强行按 A 的比例缩放(chartDoc 也会拒绝) */}
            {!fitScales.has('right') && <NativeSelectOption value="right">右轴</NativeSelectOption>}
            {!fitScales.has('left') && <NativeSelectOption value="left">左轴</NativeSelectOption>}
            {overlays.map((s, i) =>
              fitScales.has(s.id) ? null : (
                <NativeSelectOption key={s.id} value={`ov:${s.id}`}>
                  独立轴 {i + 1}
                </NativeSelectOption>
              ),
            )}
            <NativeSelectOption value="new">新独立轴</NativeSelectOption>
          </NativeSelect>
        )}
        {events && (
          <span className="shrink-0 text-[10px] text-neutral-500">
            {layer.render?.kind === 'background' ? '背景' : '竖线'}
          </span>
        )}
        {!events && (
          <Popover>
            <PopoverTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="text-neutral-600 hover:text-neutral-200"
                  title="设置"
                />
              }
            >
              <Settings2 />
            </PopoverTrigger>
            <PopoverContent
              align="end"
              className="w-80 gap-2 p-2 text-xs text-neutral-400"
              // 弹层经 Portal 画在 body 下,但 React 事件仍沿组件树冒泡到卡片 li:
              // 在输入框里拖选文字会被当成开始拖这张卡片;往输入框里放文字会被卡片的 drop 拦掉。拖放事件一律不出弹层
              onDragStart={stopPropagation}
              onDragOver={stopPropagation}
              onDrop={stopPropagation}
              onDragEnd={stopPropagation}
            >
              {/* key:撤销等把线在独立轴 / 左右轴之间换了时,「纵轴」页会出现 / 消失,重挂一次免得停在已不存在的页上 */}
              <Tabs key={onOverlay ? 'overlay' : 'side'} defaultValue="data">
                <TabsList variant="line">
                  <TabsTrigger value="data">数据</TabsTrigger>
                  {/* 左右轴在图上该轴刻度上右键改(同 TradingView);只有独立轴没有刻度可点,才在这里留一页 */}
                  {onOverlay && <TabsTrigger value="axis">纵轴</TabsTrigger>}
                  {/* 指标是对一条序列算的,指标自己不再套指标 */}
                  {!layer.indicator && !isMarkLayer(layer) && <TabsTrigger value="indicator">指标</TabsTrigger>}
                </TabsList>
                <TabsContent value="data" className="flex flex-col gap-2 text-xs">
                  {layer.indicator ? (
                    <PeriodsRow layer={layer} sevenDay={allSevenDay(doc)} actions={actions} />
                  ) : (
                    <>
                      <CalcRow
                        layer={layer}
                        locked={fixed}
                        actions={actions}
                        pending={pendingCalc}
                        onPending={setPendingCalc}
                      />
                      <ShiftRow layer={layer} locked={fixed} actions={actions} />
                      <RenderRow layer={layer} locked={fixed} actions={actions} />
                    </>
                  )}
                </TabsContent>
                {!layer.indicator && !isMarkLayer(layer) && (
                  <TabsContent value="indicator" className="flex flex-col gap-2 text-xs">
                    <p className="text-neutral-500">
                      对这条线算指标,加成新的一层(叠加类放在同一格,振荡类在下方新开一格);已加的高亮,再点一下去掉
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {INDICATOR_IDS.map((id) => (
                        <Button
                          key={id}
                          variant="outline"
                          size="2xs"
                          disabled={!!indicatorBlocked(doc, layer, id)}
                          title={
                            hasIndicator(doc, layer, id)
                              ? '已加上,再点一下去掉(改参数去那一层的「数据」页)'
                              : indicatorBlocked(doc, layer, id)
                          }
                          aria-pressed={hasIndicator(doc, layer, id)}
                          // 已加的高亮,同纵轴坐标按钮的选中样式;再点一下去掉
                          className={hasIndicator(doc, layer, id) ? ACTIVE : undefined}
                          onClick={() =>
                            hasIndicator(doc, layer, id)
                              ? actions.removeIndicator(layer.id, id)
                              : actions.addIndicator(layer.id, id)
                          }
                        >
                          {INDICATORS[id].label}
                        </Button>
                      ))}
                    </div>
                  </TabsContent>
                )}
                {onOverlay && (
                  <TabsContent value="axis" className="flex flex-col gap-2 text-xs">
                    <p className="text-neutral-500">{axisName}的属性:这根轴上的线一起变</p>
                    <div>
                      <Button
                        variant="outline"
                        size="2xs"
                        aria-pressed={!!scale?.show}
                        className={scale?.show ? ACTIVE : 'text-neutral-500'}
                        title="在右轴外侧画出这根轴的刻度(同研报图的第 3、4 根纵轴),能拖动缩放、右键改坐标"
                        onClick={() => actions.setShow(pane.id, layer.scale, !scale?.show)}
                      >
                        显示刻度
                      </Button>
                    </div>
                    {/* 多出来的轴挂在右轴的线上画:这一格右轴没有线就画不出(见 useAxisDecor) */}
                    {scale?.show && !drawn && (
                      <p className="text-amber-500">这一格右轴没有线,刻度画不出来:先把一条线挂到右轴</p>
                    )}
                    {/* 刻度画出来了就同左右轴:在轴上右键改;没画出来的隐形轴点不到,只能在这里改 */}
                    {drawn ? (
                      <p className="text-neutral-500">坐标(百分比 / 对数等)和倒轴:在图上这根轴的刻度上右键改</p>
                    ) : (
                      <ScaleControls
                        doc={doc}
                        pane={pane}
                        scaleId={layer.scale}
                        positive={positive}
                        actions={actions}
                      />
                    )}
                  </TabsContent>
                )}
              </Tabs>
            </PopoverContent>
          </Popover>
        )}
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => actions.remove(layer.id)}
          className="text-neutral-600 hover:text-neutral-200"
          title="删除"
        >
          <X />
        </Button>
      </div>
      <StateBadges
        hidden={!!layer.hidden}
        shift={layer.shift ?? 0}
        inverted={inverted}
        mode={mode}
        modeIneffective={modeIneffective}
      />
      {layer.fit && <FitRow fit={layer.fit} inverted={inverted} onClear={() => actions.clearFit(layer.id)} />}
    </li>
  );
}

// 卡片上只留「这条线被动过什么」的提示,改动去 ⚙ 弹层里做。
// 单独占一行、没有就不占:侧栏只有 ~290px,和名字挤在一行会把名字截到只剩一两个字
// 显隐开关在图例行上(同 TradingView),卡片只显示状态,不另设一个按钮
function StateBadges({
  hidden,
  shift,
  inverted,
  mode,
  modeIneffective,
}: {
  hidden: boolean;
  shift: number;
  inverted: boolean;
  mode: ScaleMode;
  modeIneffective: boolean;
}) {
  const badge = 'shrink-0 rounded bg-neutral-800 px-1 text-[10px] leading-4 text-neutral-400';
  if (!hidden && shift === 0 && !inverted && mode === 'normal') return null;

  return (
    <div className="mt-1 flex gap-1 pl-5">
      {hidden && <span className={badge}>隐藏</span>}
      {shift !== 0 && <span className={badge}>{`平移 ${shift > 0 ? '+' : ''}${shift}`}</span>}
      {inverted && <span className={badge}>倒轴</span>}
      {mode !== 'normal' && (
        <span
          // cn 而不是字符串拼接:两个文字色类并存时 CSS 里灰色排在后面,会盖掉警告色
          className={cn(badge, modeIneffective && 'text-amber-500')}
          title={modeIneffective ? NOT_POSITIVE_NOTE : undefined}
        >
          {SCALE_MODES[mode].label}
        </span>
      )}
    </div>
  );
}

// 暂存的运算绑定到当时那个图层对象:图层一变(导入整张图换了文档、或这条线被改过)就作废,
// 否则导入一份同 id 的图会在没有计算的卡片上留下半截计算控件
type PendingCalc = { layer: Layer; op: CalcOp };

/**
 * 计算:这条线改画成「它 − / ÷ 另一条序列」。先选运算再选第二条;两样齐了才写进文档(文档里的计算必须完整),
 * 只选了运算的那一步先记在卡片上。叠加中的线锁住:算出来的值一变,按点按钮时定的比例就对不上了。
 */
function CalcRow({
  layer,
  locked,
  actions,
  pending,
  onPending,
}: {
  layer: Layer;
  locked: boolean;
  actions: CardActions;
  pending: PendingCalc | undefined;
  onPending: (p: PendingCalc | undefined) => void;
}) {
  const op = layer.calc?.op ?? (pending?.layer === layer ? pending.op : undefined);

  function onOp(v: string) {
    onPending(v ? { layer, op: v as CalcOp } : undefined);
    if (!v) actions.setCalc(layer.id, undefined);
    else if (layer.calc) actions.setCalc(layer.id, { ...layer.calc, op: v as CalcOp });
  }

  return (
    <div
      className="flex items-center gap-1.5"
      title={locked ? LOCKED_TITLE : '计算:把这条线换成它与另一条序列的差(−)或比值(÷),两条按日期对齐后现算'}
    >
      计算
      <NativeSelect size="xs" value={op ?? ''} disabled={locked} onChange={(e) => onOp(e.target.value)}>
        <NativeSelectOption value="">无</NativeSelectOption>
        <NativeSelectOption value="-">− 相减</NativeSelectOption>
        <NativeSelectOption value="/">÷ 相除</NativeSelectOption>
      </NativeSelect>
      {op && (
        <SeriesSelect
          value={layer.calc?.series}
          onChange={(id) => actions.setCalc(layer.id, { ...layer.calc, op, series: id })}
          placeholder={op === '-' ? '减去哪条序列' : '除以哪条序列'}
          disabled={locked}
        />
      )}
    </div>
  );
}

// 指标的周期(EMA / RSI):逗号分隔,失焦或回车生效;清空 = 回到默认那组。布林带 / MACD 参数固定,只给说明
function PeriodsRow({ layer, sevenDay, actions }: { layer: Layer; sevenDay: boolean; actions: CardActions }) {
  const { id, periods } = layer.indicator!;
  const shown = periodsOf(id, periods, sevenDay).join(', ');
  const [draft, setDraft] = useState<string | null>(null);
  if (!INDICATORS[id].periods) return <p className="text-neutral-500">{INDICATORS[id].label}:参数固定</p>;

  const commit = () => {
    if (draft === null) return;
    const ns = draft
      .split(/[,，\s]+/)
      .filter(Boolean)
      .map(Number);
    const ok = ns.length > 0 && ns.length <= 10 && ns.every((n) => Number.isInteger(n) && n >= 1 && n <= 1000);
    if (draft.trim() === '') actions.setPeriods(layer.id, undefined);
    else if (ok) actions.setPeriods(layer.id, ns);
    setDraft(null);
  };

  return (
    <label className="flex items-center gap-1.5">
      周期
      <input
        className="h-6 flex-1 rounded border border-neutral-700 bg-neutral-900 px-1.5 text-neutral-200"
        value={draft ?? shown}
        placeholder={(INDICATORS[id].periods ?? []).join(', ')}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
        title="逗号分隔,如 5, 20, 60;清空 = 默认那组"
      />
    </label>
  );
}

// 画法:折线 / 柱状(符号柱,正绿负红、0 基线 —— 净持仓、期限结构这类看正负的量)/ 成交量柱(单色,周 / 月线求和)
// 叠加中的线(两头)锁住:叠加只认折线(见 AnalysisPanel)
// 蜡烛:要源里有开高低收(注册表标了 ohlc);计算图层是现算的一条值,没有 K 线
function RenderRow({ layer, locked, actions }: { layer: Layer; locked: boolean; actions: CardActions }) {
  const r = layer.render?.kind;
  const kind = r === 'signed' || r === 'candle' || r === 'volume' ? r : 'line';
  const candleOk = canCandle(layer);

  return (
    <div className="flex items-center gap-1.5" title={locked ? LOCKED_TITLE : undefined}>
      画法
      <NativeSelect
        size="xs"
        disabled={locked}
        value={kind}
        onChange={(e) =>
          actions.setRender(
            layer.id,
            e.target.value === 'line' ? undefined : { kind: e.target.value as 'signed' | 'candle' | 'volume' },
          )
        }
      >
        <NativeSelectOption value="line">折线</NativeSelectOption>
        <NativeSelectOption value="signed">柱状(正绿负红)</NativeSelectOption>
        <NativeSelectOption value="volume">成交量柱(周 / 月线求和)</NativeSelectOption>
        {/* 画不了时把原因写在选项文字里:原生下拉的选项悬停提示多数浏览器不显示,挂在整行又会对所有图层都弹 */}
        <NativeSelectOption value="candle" disabled={!candleOk}>
          {candleOk ? '蜡烛' : layer.calc ? '蜡烛(计算图层画不了)' : '蜡烛(只有收盘,画不了)'}
        </NativeSelectOption>
      </NativeSelect>
    </div>
  );
}

function ShiftRow({ layer, locked, actions }: { layer: Layer; locked: boolean; actions: CardActions }) {
  const shift = layer.shift ?? 0;

  return (
    <div
      className="flex items-center gap-0.5"
      title={locked ? LOCKED_TITLE : '平移(交易日):正数往右挪,看它是不是领先别的线'}
    >
      平移
      <Button
        variant="ghost"
        size="icon-2xs"
        className="text-neutral-500"
        disabled={locked}
        onClick={() => actions.setShift(layer.id, shift - 1)}
      >
        −
      </Button>
      <NumberField value={shift} disabled={locked} onCommit={(n) => actions.setShift(layer.id, n)} />
      <Button
        variant="ghost"
        size="icon-2xs"
        className="text-neutral-500"
        disabled={locked}
        onClick={() => actions.setShift(layer.id, shift + 1)}
      >
        +
      </Button>
      天
    </div>
  );
}

// 叠加是正在生效的状态、且有「取消」这个动作,留在卡片上不收进弹层
function FitRow({ fit, inverted, onClear }: { fit: Fit; inverted: boolean; onClear: () => void }) {
  return (
    <div className="mt-1 flex items-center gap-1.5 pl-5 text-xs text-neutral-400">
      <span>
        基准段 {fit.start} ~ {fit.end}
        {` · 相关 ${fit.r.toFixed(2)}`}
        {fit.beta < 0 && (inverted ? ' · 反向,轴已倒过来' : ' · 反向(A 的轴已倒,不用倒)')}
      </span>
      <Button variant="ghost" size="2xs" className="text-neutral-500" onClick={onClear}>
        取消叠加
      </Button>
    </div>
  );
}

// 黄色感叹号,悬停显示说明(纯 CSS group-hover,不用状态)。
// 浮层不以图标为基准(图标位置随名字长短变,靠边就被侧栏裁掉),而是对齐整张卡片(li 是 relative),铺在名字那行下面
function Tip({ text }: { text: string }) {
  return (
    <span className="group shrink-0">
      <CircleAlert size={13} className="text-amber-400" />
      <span className="pointer-events-none absolute inset-x-1 top-8 z-20 hidden rounded border border-amber-500/40 bg-neutral-900 px-2 py-1.5 text-[11px] leading-snug text-amber-200 shadow-lg group-hover:block">
        {text}
      </span>
    </span>
  );
}
