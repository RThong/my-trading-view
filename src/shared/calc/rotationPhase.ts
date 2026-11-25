// 高切低 → 通杀 → 见底 状态机(纯函数,「特色指标 › 攻防」上格的阶段标注)。
// 规格见 docs/rotation-phase-handoff.md;逐行照 semantic-garden 的回测脚本 rotv3.py 移植(验收表由它产出),
// 与脚本的差别:去掉了「熊市型才要求周线背离」那道底候选过滤(规格 §5:本版不用周线);底候选按规格取 A 点里最低;
// 分型的第一阶段按规格从 ① 算起(脚本从确认高切低那天起)。
// 定位是复盘 / 状态背景板:阈值按 1999 起 4 轮完整样本定,可能过拟合。

type Point = { date: string; value: number };

const P = {
  rotQ: -0.05, // 高切低:QQQ 距 250 日高点
  rotX: -0.02, // XLP 距 60 日高点
  rotXUp: 0.02, // XLP 60 日涨幅
  rotRel: 0.1, // XLP/QQQ 60 日变化
  killX: -0.05, // 通杀:XLP 从本轮高点回撤
  killV: 25,
  botV: 30,
  minP1: 20, // 第一阶段(QQQ 高点 → XLP 高点)最少交易日
  hyMax: 6, // hyOas ≥ 6% = 信用危机型,不算
  botVPeak: 0.9,
  endUp: 0.1, // 见底:QQQ 从底反弹
  endV: 25,
  resetQ: -0.03, // QQQ 回到距高点 −3% 内 = 本轮结束
  holdDays: 120,
  creditCoolDays: 180,
  shortCoolDays: 60,
};

export type Outcome =
  | '走完'
  | '未通杀'
  | '不算·信用危机型'
  | '不算·第一阶段太短'
  | `进行中·${'高切低' | '通杀' | '见底'}`;

export type RotationEpisode = {
  peakQ: string; // ① 本轮 QQQ 250 日高点
  confirm1: string; // 进入高切低那天
  peakX?: string; // ② 本轮 XLP 高点(进行中且还在高切低时 = 目前为止的高点,待定)
  confirm2?: string; // 进入通杀那天
  bottom?: string; // ③ 底
  confirm3?: string; // 进入见底那天
  kind: '磨底型' | 'V 形';
  outcome: Outcome;
  continuation: boolean; // 续段:高点低于上一轮、距上一轮底不到 2 年
  lowsA: string[];
  lowsB: string[];
};

type Row = { date: string; q: number; x: number; v: number; h: number };

const DAY = 86_400_000;
function days(a: string, b: string) {
  return (Date.parse(b) - Date.parse(a)) / DAY;
}
function addDays(d: string, n: number) {
  return new Date(Date.parse(d) + n * DAY).toISOString().slice(0, 10);
}

/** QQQ / XLP / VIX 三者内连接;hyOas 按日期前向填充(FRED 偶缺天) */
function joinRows(qqq: Point[], xlp: Point[], vix: Point[], hyOas: Point[]): Row[] {
  const x = new Map(xlp.map((p) => [p.date, p.value]));
  const v = new Map(vix.map((p) => [p.date, p.value]));
  const hy = new Map(hyOas.map((p) => [p.date, p.value]));
  let h = Number.NaN;

  return qqq.flatMap((p) => {
    h = hy.get(p.date) ?? h;
    const xv = x.get(p.date);
    const vv = v.get(p.date);
    return xv !== undefined && vv !== undefined ? [{ date: p.date, q: p.value, x: xv, v: vv, h }] : [];
  });
}

// 指数平滑,首值起算(同 pandas ewm(adjust=False))
function ewm(xs: number[], alpha: number): number[] {
  return xs.reduce<number[]>((out, x, i) => {
    out.push(i === 0 ? x : (1 - alpha) * out[i - 1] + alpha * x);
    return out;
  }, []);
}

function rsi(q: number[], n = 14): number[] {
  const d = q.slice(1).map((v, i) => v - q[i]);
  const up = ewm(
    d.map((x) => Math.max(x, 0)),
    1 / n,
  );
  const dn = ewm(
    d.map((x) => Math.max(-x, 0)),
    1 / n,
  );
  return [Number.NaN, ...up.map((u, i) => 100 - 100 / (1 + u / dn[i]))];
}

/** 日线底背离:枢轴低点(前后各 5 日最低)比 120 天内前一个更高的枢轴低点,RSI(14) 或 MACD 线任一更高 */
function dailyDivergences(rows: Row[]): Set<string> {
  const q = rows.map((r) => r.q);
  const r14 = rsi(q);
  const e12 = ewm(q, 2 / 13);
  const e26 = ewm(q, 2 / 27);
  const dif = e12.map((v, i) => v - e26[i]);
  const pivots = rows
    .map((_, i) => i)
    .filter((i) => i >= 5 && i < rows.length - 5 && q[i] === Math.min(...q.slice(i - 5, i + 6)));

  return new Set(
    pivots.flatMap((t, k) => {
      const prev = pivots.slice(0, k).filter((u) => days(rows[u].date, rows[t].date) <= 120 && q[u] > q[t]);
      const p = prev.at(-1);
      return p !== undefined && (r14[t] > r14[p] || dif[t] > dif[p]) ? [rows[t].date] : [];
    }),
  );
}

/** 区间 [a, b] 内 key 最大的下标(并列取最早,同 pandas idxmax) */
function argMax(rows: Row[], a: number, b: number, key: (r: Row) => number) {
  let best = a;
  for (let i = a + 1; i <= b; i++) if (key(rows[i]) > key(rows[best])) best = i;
  return best;
}

/**
 * 阶段低点 A(seg 从 ② 起):VIX ≥ 30 的日子按簇分(相隔 > 7 天算新簇),簇内 VIX 峰 ≥ 通杀以来 VIX 最高的 90%
 * → 簇里 QQQ 最低那天。只用 seg 内的数据,截到哪天就是那天收盘可见的结果(状态机判底也用它)
 */
function lowPointsA(seg: Row[]): Row[] {
  const hi = seg.map((r, i) => ({ r, i })).filter(({ r }) => r.v >= P.botV);
  const clusters = hi.reduce<(typeof hi)[]>((acc, h, k) => {
    if (k > 0 && days(hi[k - 1].r.date, h.r.date) > 7) acc.push([h]);
    else if (acc.length) acc[acc.length - 1].push(h);
    else acc.push([h]);
    return acc;
  }, []);

  return clusters
    .filter((g) => {
      const runMax = Math.max(...seg.slice(0, g[g.length - 1].i + 1).map((r) => r.v));
      return Math.max(...g.map(({ r }) => r.v)) >= P.botVPeak * runMax;
    })
    .map((g) => g.reduce((lo, h) => (h.r.q < lo.r.q ? h : lo)).r);
}

/** 阶段低点 A / B,区间 = ② 到 ③ 后 5 天(进行中到最后一天) */
function marks(rows: Row[], idx: Map<string, number>, div: Set<string>, ep: RotationEpisode) {
  const a = idx.get(ep.peakX as string) as number;
  const endDate = addDays(ep.bottom ?? rows[rows.length - 1].date, 5);
  const seg = rows.slice(a).filter((r) => r.date <= endDate);

  const lowsA = lowPointsA(seg).map((r) => r.date);

  // B:日线底背离,且当周(往前 4 天内)VIX 最高 ≥ 30
  const lowsB = seg
    .filter((r) => div.has(r.date))
    .filter((r) => {
      const from = addDays(r.date, -4);
      return rows.some((w) => w.date >= from && w.date <= r.date && w.v >= 30);
    })
    .map((r) => r.date);

  return { lowsA, lowsB };
}

/** 跑完整段历史,返回每一轮(含被排除的)。序列需升序 */
export function rotationEpisodes(qqq: Point[], xlp: Point[], vix: Point[], hyOas: Point[]): RotationEpisode[] {
  const rows = joinRows(qqq, xlp, vix, hyOas);
  const idx = new Map(rows.map((r, i) => [r.date, i]));
  const eps: RotationEpisode[] = [];
  const at = (i: number) => rows[i].date;

  type Cur = Omit<RotationEpisode, 'kind' | 'outcome' | 'continuation' | 'lowsA' | 'lowsB'>;
  let state: '正常' | '冷却' | '高切低' | '通杀' | '见底' = '正常';
  let cur: Cur | null = null;
  let coolUntil = '';
  let lastEnd = 0; // 上一轮底(或作废那天)的下标:本轮 XLP 高点从它之后找
  const close = (c: Cur, outcome: Outcome) =>
    eps.push({ ...c, outcome, kind: 'V 形', continuation: false, lowsA: [], lowsB: [] });

  // 状态机逐日推进,每步依赖上一步状态,命令式更直白
  for (let i = 60; i < rows.length; i++) {
    const r = rows[i];
    const qHi = Math.max(...rows.slice(Math.max(0, i - 249), i + 1).map((w) => w.q));
    const qdd = r.q / qHi - 1;

    if (state === '正常') {
      const xHi60 = Math.max(...rows.slice(i - 59, i + 1).map((w) => w.x));
      const p60 = rows[i - 60];
      const rotating =
        qdd <= P.rotQ &&
        r.x / xHi60 - 1 >= P.rotX &&
        r.x / p60.x - 1 >= P.rotXUp &&
        r.x / r.q / (p60.x / p60.q) - 1 >= P.rotRel;
      // hyOas 缺历史的日子判不了是不是信用危机型,宁可不判(不然 2008 这类会被当成正常轮画出来)
      if (!rotating || Number.isNaN(r.h)) continue;
      const c: Cur = {
        peakQ: at(argMax(rows, Math.max(0, i - 250), i, (w) => w.q)),
        confirm1: r.date,
      };
      if (r.h >= P.hyMax) {
        close(c, '不算·信用危机型');
        state = '冷却';
        coolUntil = addDays(r.date, P.creditCoolDays);
      } else {
        state = '高切低';
        cur = c;
      }
    } else if (state === '冷却') {
      if (r.date >= coolUntil) state = '正常';
    } else if (state === '高切低' && cur) {
      const l1 = idx.get(cur.peakQ) as number;
      const xpk = argMax(rows, Math.max(l1, lastEnd), i, (w) => w.x);
      if (r.x / rows[xpk].x - 1 <= P.killX && r.v >= P.killV) {
        if (xpk - l1 < P.minP1) {
          close(cur, '不算·第一阶段太短');
          lastEnd = i;
          state = '冷却';
          cur = null;
          coolUntil = addDays(r.date, P.shortCoolDays);
        } else {
          state = '通杀';
          cur.peakX = at(xpk);
          cur.confirm2 = r.date;
        }
      } else if (qdd > P.resetQ) {
        close(cur, '未通杀');
        state = '正常';
        cur = null;
      }
    } else if (state === '通杀' && cur) {
      const l2 = idx.get(cur.peakX as string) as number;
      if (r.x > rows[l2].x) {
        state = '高切低';
        cur.peakX = undefined;
        cur.confirm2 = undefined;
        continue;
      }
      // 底候选 = 截至当天的 A 点里 QQQ 最低的一天(规格 §2;参考脚本取的是「VIX ≥ 30 且 ≥ 当时最高 90% 的日子」,
      // VIX 冲顶回落后 QQQ 才创新低时两者会分开,用户 2026-11-26 定按规格,③ 总落在某个 A 上)
      const lo = lowPointsA(rows.slice(l2, i + 1)).reduce<Row | null>(
        (m, w) => (m === null || w.q < m.q ? w : m),
        null,
      );
      if (lo && r.q / lo.q - 1 >= P.endUp && r.v < P.endV) {
        state = '见底';
        cur.bottom = lo.date;
        cur.confirm3 = r.date;
      }
    } else if (state === '见底' && cur) {
      const l3 = idx.get(cur.bottom as string) as number;
      if (r.q < rows[l3].q && r.v >= P.botV) {
        state = '通杀';
        cur.bottom = undefined;
        cur.confirm3 = undefined;
      } else if (qdd > P.resetQ || days(cur.confirm3 as string, r.date) > P.holdDays) {
        close(cur, '走完');
        lastEnd = l3;
        state = '正常';
        cur = null;
      }
    }
  }

  // 进行中:还在高切低时 ② 取目前为止的 XLP 高点(待定)
  if (cur && (state === '高切低' || state === '通杀' || state === '见底')) {
    const l1 = idx.get(cur.peakQ) as number;
    const peakX = cur.peakX ?? at(argMax(rows, Math.max(l1, lastEnd), rows.length - 1, (w) => w.x));
    close({ ...cur, peakX }, `进行中·${state}`);
  }

  const div = dailyDivergences(rows);
  let prevPeak: { q: number; end: string } | null = null;

  return eps.map((e) => {
    // 分型看第一阶段(① 到进入通杀那天;进行中还没通杀的到最后一天;被排除 / 作废的到确认高切低那天)VIX 有没有 ≥ 30
    const p1End = e.confirm2 ?? (e.outcome.startsWith('进行中') ? rows[rows.length - 1].date : e.confirm1);
    const grind = rows.slice(idx.get(e.peakQ)).some((r) => r.date <= p1End && r.v >= P.botV);
    const kind: RotationEpisode['kind'] = grind ? '磨底型' : 'V 形';
    // 标注只给走完 / 进行中的轮;进行中还在高切低时没有通杀,不找阶段低点
    const shown = e.outcome === '走完' || e.outcome.startsWith('进行中');
    const m = shown && e.confirm2 ? marks(rows, idx, div, e) : { lowsA: [], lowsB: [] };
    if (!shown) return { ...e, kind, ...m };

    const q1 = rows[idx.get(e.peakQ) as number].q;
    const end = e.bottom ?? e.peakQ;
    const continuation = prevPeak !== null && q1 < prevPeak.q && days(prevPeak.end, e.peakQ) < 730;
    prevPeak = continuation && prevPeak ? { q: prevPeak.q, end } : { q: q1, end };
    return { ...e, kind, continuation, ...m };
  });
}

/** 标签图层的取值 → 文字(ChartDoc 的 markers 画法按值查这张表;分型标在 ① 上,待定标在未确认的 ② 上) */
export const ROTATION_LABELS: Record<string, string> = {
  '1': '磨底型',
  '2': 'V 形',
  '3': '磨底型·续段',
  '4': 'V 形·续段',
  '5': '待定',
};

function flag(dates: string[], on: (d: string) => boolean) {
  return dates.map((date) => ({ date, value: on(date) ? 1 : 0 }));
}
function dots(ds: (string | undefined)[]) {
  return [...new Set(ds.filter((d): d is string => !!d))].sort().map((date) => ({ date, value: 1 }));
}

/**
 * 对外序列(只画走完 / 进行中的轮):底色两条按 QQQ 日期逐日 0 / 1;竖线、三角只列标注日。
 * 底色:① → ② 黄(不含 ②),② → ③ 红;进行中的轮画到最后一天(还在高切低时整段黄)
 */
export function rotationSeries(qqq: Point[], xlp: Point[], vix: Point[], hyOas: Point[]) {
  const shown = rotationEpisodes(qqq, xlp, vix, hyOas).filter(
    (e) => e.outcome === '走完' || e.outcome.startsWith('进行中'),
  );
  const dates = qqq.map((p) => p.date);
  const last = dates[dates.length - 1];
  // 还在高切低的进行中轮:② 只是目前为止的高点,单列成「待定」
  const pending = (e: RotationEpisode) => e.outcome === '进行中·高切低';
  const yellowEnd = (e: RotationEpisode) => (pending(e) ? addDays(last, 1) : (e.peakX as string));
  const label = (e: RotationEpisode) => (e.kind === '磨底型' ? 1 : 2) + (e.continuation ? 2 : 0);

  return {
    rpRotate: flag(dates, (d) => shown.some((e) => d >= e.peakQ && d < yellowEnd(e))),
    rpKill: flag(dates, (d) => shown.some((e) => !pending(e) && d >= (e.peakX as string) && d <= (e.bottom ?? last))),
    rpPeakQ: dots(shown.map((e) => e.peakQ)),
    rpPeakX: dots(shown.filter((e) => !pending(e)).map((e) => e.peakX)),
    rpPeakXPending: dots(shown.filter(pending).map((e) => e.peakX)),
    rpBottom: dots(shown.map((e) => e.bottom)),
    rpConfirm: dots(shown.flatMap((e) => [e.confirm1, e.confirm2, e.confirm3])),
    rpLowA: dots(shown.flatMap((e) => e.lowsA)),
    rpLowB: dots(shown.flatMap((e) => e.lowsB)),
    rpLabel: [
      ...shown.map((e) => ({ date: e.peakQ, value: label(e) })),
      ...shown.filter(pending).map((e) => ({ date: e.peakX as string, value: 5 })),
    ].sort((a, b) => a.date.localeCompare(b.date)),
  };
}
