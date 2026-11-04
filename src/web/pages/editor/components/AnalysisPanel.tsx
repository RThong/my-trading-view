import { type ReactNode, useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '../../../components/ui/popover';
import { ChevronDown, ChevronRight, CircleHelp } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { NativeSelect, NativeSelectOption } from '../../../components/ui/native-select';
import type { LinePoint } from '../../../chart/core';
import {
  bestOverlay,
  OVERLAY_RULES,
  shiftBusinessDays,
  type OverlayResult,
  type Segment,
} from '../../../chart/analysis';
import { isFitTarget, type ChartDoc, type Layer } from '../../../views/chartDoc/chartDoc';
import { baseLabel } from '../layerLabel';
import type { ChartDocActions } from '../hooks/useChartDoc';
import { requestKey } from '../hooks/useEditorSeriesData';
import type { DateRange } from '../hooks/useVisibleRange';

type Props = {
  doc: ChartDoc;
  /** 取数结果(按请求键)。找偏移要用 A / B 未平移的原序列,页面会替选中的两条额外请求一份 */
  points: Record<string, LinePoint[]>;
  visibleRange: DateRange | null;
  /** 选中的 A / B 图层 id(页面持有,因为它要据此多请求未平移的数据) */
  pair: { a?: string; b?: string };
  onPair: (pair: { a?: string; b?: string }) => void;
  actions: Pick<ChartDocActions, 'overlay'>;
};

const PAIR_LOCKED = '已叠加,先取消叠加才能换线';

/** 点「叠加对比」的结果,记着是哪一对、按 A 多少平移算的(换了 A / B 就不显示;日期是 A 未平移的) */
type ShownResult = { a: string; b: string; key: string; aShift: number; invert: boolean; res: OverlayResult };

/** 选中的两条序列图层:选的不在图上了就退回默认(第一 / 第二条)。 */
export function resolvePair(doc: ChartDoc, pair: { a?: string; b?: string }): { a?: Layer; b?: Layer } {
  const series = doc.panes.flatMap((p) => p.layers);
  // 叠加期间 A / B 锁定为叠加的那一对(同时只有一组叠加):换线要先取消叠加
  const fitted = series.find((l) => l.fit);
  if (fitted) return { a: series.find((l) => l.id === fitted.fit?.target), b: fitted };

  const a = series.find((l) => l.id === pair.a) ?? series[0];
  const b = series.find((l) => l.id === pair.b && l.id !== a?.id) ?? series.find((l) => l.id !== a?.id);

  return { a, b };
}

/** A / B 未平移、未聚合的日线原序列请求(找偏移要逐交易日平移;页面据此多取一份数据)。 */
function rawRequest(l: Layer) {
  return { series: l.series, ...(l.calc && { calc: l.calc }), shift: 0, daily: true as const };
}
export function pairRequests(pair: { a?: Layer; b?: Layer }) {
  return [pair.a, pair.b].filter((l) => l !== undefined).map(rawRequest);
}

// 右侧「分析」区:选两条线 A / B,叠加对比(B 按 A 的刻度叠上去)。
export function AnalysisPanel({ doc, points, visibleRange, pair, onPair, actions }: Props) {
  const [open, setOpen] = useState(true);
  const [result, setResult] = useState<ShownResult | null>(null);

  const series = doc.panes.flatMap((p) => p.layers);
  const { a, b } = resolvePair(doc, pair);
  const pairLocked = series.some((l) => l.fit);
  const aPts = a && points[requestKey(rawRequest(a))];
  const bPts = b && points[requestKey(rawRequest(b))];
  // B 已是别的线的叠加目标时不能再叠它(会把那条线的换算静默冲掉);A 自己在叠加中也不能当基准
  const bIsTarget = !!b && isFitTarget(doc, b.id);
  // A 的轴是对数时对不上:B 轴只能按线性比例跟着 A 的范围走
  const aScale = a && doc.panes.find((p) => p.layers.includes(a))?.scales.find((sc) => sc.id === a.scale);
  const canOverlay =
    !!a && !!b && !!aPts?.length && !!bPts?.length && !!visibleRange && !a.fit && !bIsTarget && !aScale?.log;

  if (series.length < 2) {
    return (
      <Section open={open} onToggle={() => setOpen((v) => !v)}>
        <p className="text-xs text-neutral-500">图上至少要有两条序列,才能叠加对比</p>
      </Section>
    );
  }

  const name = (l?: Layer) => (l ? baseLabel(doc, l.id) : '?');

  const overlay = () => {
    if (!canOverlay) return;
    // 可视区间是画面上的日期(A 平移后的);找偏移用的是 A 未平移的原序列,按 A 的平移反推回去才对得上
    const aShift = a.shift ?? 0;
    const res = bestOverlay(aPts, bPts, {
      from: shiftBusinessDays(visibleRange.from, -aShift),
      to: shiftBusinessDays(visibleRange.to, -aShift),
    });
    // A 的轴若本来就倒着,B 要倒的方向跟着反一次
    const invert = res.kind === 'ok' && res.overlay.fit.beta < 0 !== !!aScale?.invert;
    setResult({ a: a.id, b: b.id, key: pairKey(a, b), aShift, invert, res });
    if (res.kind !== 'ok') return;

    const { seg, lag, fit } = res.overlay;
    // 基准段存画面上的日期(A 平移后的)
    const start = shiftBusinessDays(seg.from, aShift);
    const end = shiftBusinessDays(seg.to, aShift);
    actions.overlay(
      b.id,
      lag + aShift,
      { target: a.id, start, end, alpha: fit.alpha, beta: fit.beta, r: fit.r },
      invert,
    );
  };
  // 除了图层 id 还要核对是哪两条序列:清空 / 删线后 id 会被新线复用,不核对会把上一对的结果挂到新的一对上
  const shown =
    result && a && b && result.a === a.id && result.b === b.id && result.key === pairKey(a, b) ? result : null;

  return (
    <Section open={open} onToggle={() => setOpen((v) => !v)}>
      <div className="flex items-center gap-1.5 text-xs text-neutral-400">
        A
        <NativeSelect
          size="xs"
          className="min-w-0 flex-1"
          value={a?.id}
          disabled={pairLocked}
          title={pairLocked ? PAIR_LOCKED : undefined}
          onChange={(e) => onPair({ ...pair, a: e.target.value })}
        >
          {series.map((l) => (
            <NativeSelectOption key={l.id} value={l.id}>
              {name(l)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        B
        <NativeSelect
          size="xs"
          className="min-w-0 flex-1"
          value={b?.id}
          disabled={pairLocked}
          title={pairLocked ? PAIR_LOCKED : undefined}
          onChange={(e) => onPair({ ...pair, b: e.target.value })}
        >
          {series
            .filter((l) => l.id !== a?.id)
            .map((l) => (
              <NativeSelectOption key={l.id} value={l.id}>
                {name(l)}
              </NativeSelectOption>
            ))}
        </NativeSelect>
      </div>

      <div className="flex flex-col gap-1.5 rounded border border-neutral-800 p-1.5">
        <h3 className="flex items-center text-xs text-neutral-400">
          叠加对比
          <span className="text-neutral-600"> · 看两线从哪里分开</span>
          <Help text={OVERLAY_HELP} />
        </h3>
        <Button variant="outline" size="xs" className="self-start" disabled={!canOverlay} onClick={overlay}>
          叠加 {name(b)} 到 {name(a)}
        </Button>
        {shown && <OverlayNote shown={shown} a={name(a)} b={name(b)} />}
        {/* 按钮点不了的原因留在面板上(不收进说明浮层):不说就不知道为什么是灰的 */}
        {(a?.fit || aScale?.log || bIsTarget) && (
          <p className="text-[11px] leading-snug text-amber-500">
            {a?.fit && 'A 自己已叠加在别的线上,不能当基准。'}
            {aScale?.log && 'A 的轴是对数坐标,对不上线性比例,先关掉对数。'}
            {bIsTarget &&
              `${name(b)} 是 ${series
                .filter((l) => l.fit?.target === b?.id)
                .map((l) => name(l))
                .join('、')} 的叠加目标,先取消那条线的叠加。`}
          </p>
        )}
      </div>
    </Section>
  );
}

const FAIL_TEXT: Record<Segment['fails'][number], (sg: Segment) => string> = {
  weak: (sg) => `涨跌相关 ${sg.rc.toFixed(2)}(要求 ≥ ${sg.need.toFixed(2)})`,
  unstable: (sg) => `一直成立:4 份只过 ${sg.parts} 份(要求 ≥ ${OVERLAY_RULES.partsMin})`,
  level: (sg) => `整体走势 ${sg.rl.toFixed(2)}(要求同向且 ≥ ${OVERLAY_RULES.levelMin})`,
};

function yearsText(months: number) {
  return months >= 12 ? `${(months / 12).toFixed(1)} 年` : `${Math.round(months)} 个月`;
}

// 结果分行:一行一项,标签一列、数值一列,扫一眼就能找到要看的那项
function Rows({ rows }: { rows: [keyof typeof ROW_HELP, string][] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-0.5 text-xs text-neutral-300">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="flex items-center text-neutral-500">
            {k}
            <Help text={ROW_HELP[k]} />
          </dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

// 每一项的「这是什么、怎么看」
const ROW_HELP = {
  基准段: '比例按这段定(黄底)\n段内该贴着,段外分开 = 劈叉\n不合理就缩放到别的年份再点',
  涨跌相关: '约一个月涨跌幅的相关,−1 ~ 1\n越接近 ±1 越同步,负数 = 反向\n段越短,要求越高',
  一直成立: '基准段切 4 份,各算一次涨跌相关\n4 份全过 = 整段同步\n只过 3 份 = 中间走弱过',
  整体走势: '两条线数值本身的相关\n越接近 ±1 叠得越紧\n0.5 左右只能大致对上',
  偏移: 'B 平移几天后最像 A\n领先 N 天 = B 先动,约 N 个交易日后 A 跟上\n不平移 = 同时动',
  方向: '反向时 B 的轴倒过来画(上小下大)\n两线同涨同跌 = 关系照旧',
} as const;

/** 方向的说法按 B 轴实际倒没倒:A 轴本来就倒着时,反向的 B 反而不用倒。 */
export function directionText(beta: number, bInverted: boolean, b: string) {
  return beta >= 0 ? '同向' : bInverted ? `反向,${b} 的轴已倒过来` : `反向(A 的轴已倒,${b} 不用倒)`;
}

// 「是哪两条线」按取数请求认(含计算):A 改成 A − C 后就是另一条线,旧结果不该再显示
function pairKey(a: Layer, b: Layer) {
  return `${requestKey(rawRequest(a))}~${requestKey(rawRequest(b))}`;
}

function OverlayNote({ shown: { res, aShift, invert }, a, b }: { shown: ShownResult; a: string; b: string }) {
  const date = (d: string) => shiftBusinessDays(d, aShift);
  if (res.kind === 'none') {
    const { whole } = res;
    if (!whole) return <p className="text-xs text-amber-500">可视区间里能配对的数据太少,放大一点再试。</p>;
    return (
      <div className="flex flex-col gap-1">
        <p className="text-xs text-amber-500">没找到两者同步的一段,没叠。没过的是:</p>
        <ul className="list-disc pl-4 text-xs text-amber-500">
          {whole.fails.map((f) => (
            <li key={f}>{FAIL_TEXT[f](whole)}</li>
          ))}
        </ul>
        <p className="text-[11px] text-neutral-500">缩放到别的年份再点,或换一对线</p>
      </div>
    );
  }

  const { seg, lag, fit } = res.overlay;
  const lagText =
    lag === 0
      ? '同时动,不平移'
      : lag > 0
        ? `${b} 领先 ${a} ${lag} 个交易日,已右移`
        : `${b} 落后 ${a} ${-lag} 个交易日,已左移`;

  return (
    <Rows
      rows={[
        ['基准段', `${date(seg.from)} ~ ${date(seg.to)}(${yearsText(seg.months)})`],
        ['涨跌相关', `${seg.rc.toFixed(2)}(要求 ≥ ${seg.need.toFixed(2)})`],
        ['一直成立', `4 份过 ${seg.parts} 份(要求 ≥ ${OVERLAY_RULES.partsMin})`],
        ['整体走势', `${seg.rl.toFixed(2)}(要求同向且 ≥ ${OVERLAY_RULES.levelMin})`],
        ['偏移', lagText],
        ['方向', directionText(fit.beta, invert, b)],
      ]}
    />
  );
}

const OVERLAY_HELP = `自动选两者同步的一段(黄底),按它的比例叠上 B
段外分开的地方就是劈叉
只看某几年:先缩放到那几年再点`;

function Section({ open, onToggle, children }: { open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 border-t border-neutral-800 pt-2">
      <Button
        variant="ghost"
        size="xs"
        onClick={onToggle}
        className="self-start text-neutral-400 hover:text-neutral-200"
      >
        {open ? <ChevronDown /> : <ChevronRight />}
        分析
      </Button>
      {open && <div className="flex flex-col gap-2 px-1">{children}</div>}
    </section>
  );
}

// 说明收进问号浮层。走 Portal 挂到 body 上:侧栏是滚动容器,浮层画在里面会被裁掉
function Help({ text }: { text: string }) {
  return (
    <Popover>
      <PopoverTrigger aria-label="说明" className="ml-1 text-neutral-500 hover:text-neutral-200">
        <CircleHelp size={13} />
      </PopoverTrigger>
      <PopoverContent
        side="left"
        align="start"
        sideOffset={6}
        collisionPadding={8}
        className="block w-max max-w-80 whitespace-pre-wrap p-3 text-xs leading-relaxed text-neutral-300"
      >
        {text}
      </PopoverContent>
    </Popover>
  );
}
