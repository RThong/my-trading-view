// 高切低 → 通杀 → 见底 状态机(纯函数,「特色指标 › 攻防」上格的阶段标注)。
// 规格见 docs/rotation-phase-handoff.md(§7 记着与原规格 / 回测脚本 docs/research 的全部偏离,以 §7 为准)。
// 主要偏离:② 从 EMA20 下穿 EMA50 之后找;磨底型的 A / B 要周线 RSI6 底背离(脚本是熊市型要求 RSI14 与 MACD 都背离);
// 底候选取 A 点里最低;分型的第一阶段从 ① 算起;另记下「当时出现过、后来挪走 / 撤销」的标注。
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
  wkRsiN: 6, // 周线背离用 RSI6(moomoo 6/12/24 口径里最快那条)
  wkOversold: 30, // RSI6 跌破 30 的拐点才看
  wkRsiGap: 2, // RSI6 至少高 2 点才算背离:取 1~3 结果都一样,0.7(2001-04)以下是噪音、4.0(2022-09)以上会误杀
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
  // lowsA 里还会挪的那个:进行中这轮、它那一簇 VIX ≥ 30 还没结束(离最后一天 ≤ 7 天),QQQ 再创新低 A 就挪过去
  lowsAOpen: string[];
  lowsB: string[];
  // 当时屏幕上出现过、事后挪走或撤销的(逐日推进时记下的,减去最终版):回看时还原「当时看到的样子」
  ghostA: string[]; // 挪走的 A 候选
  ghostB: string[]; // 随撤销的通杀一起消失的 B
  ghostBottoms: string[]; // 撤销的 ③(QQQ 跌破且 VIX ≥ 30,退回通杀)
  ghostKills: { from: string; to: string }[]; // 撤销的通杀段(XLP 再创新高退回高切低):[②, 撤销那天),撤销那天收盘已退回高切低,不含
};

type Seen = { a: Set<string>; b: Set<string>; bottoms: Set<string>; kills: { from: string; to: string }[] };

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

/** 日期所在那一周的周五(周线按周五收盘切) */
function friday(d: string): string {
  return addDays(d, (5 - new Date(`${d}T00:00:00Z`).getUTCDay() + 7) % 7);
}

type WeeklyDiv = { week: string; visible: string };

/**
 * 周线底背离(用户 2026-11-27 定,照他看周线的读法):周线 RSI6 跌破 30 后拐头 —— 这周 RSI6 比上周低、下周比这周高 ——
 * 这周算一个超卖拐点;和上一个超卖拐点(365 天内)比,周收盘更低,而 RSI6 至少高 2 点、或周线 MACD 线更高,任一满足即背离。
 * 要等下一周拐头才确认:visible = 下一周的周五。只比上一个超卖拐点,不跨过去比更早的(跨过去会把「RSI 已创新低」误判成背离)
 */
function weeklyDivergences(rows: Row[]): WeeklyDiv[] {
  const weeks = rows.reduce<{ week: string; q: number }[]>((acc, r) => {
    const w = friday(r.date);
    const last = acc.at(-1);
    if (last?.week === w) last.q = r.q;
    else acc.push({ week: w, q: r.q });
    return acc;
  }, []);
  const q = weeks.map((w) => w.q);
  const r6 = rsi(q, P.wkRsiN);
  const e12 = ewm(q, 2 / 13);
  const e26 = ewm(q, 2 / 27);
  const dif = e12.map((v, i) => v - e26[i]);
  const troughs = q
    .map((_, k) => k)
    .filter((k) => k >= 1 && k < q.length - 1 && r6[k] < P.wkOversold && r6[k] < r6[k - 1] && r6[k + 1] > r6[k]);

  return troughs.flatMap((k, n) => {
    const u = troughs[n - 1];
    const diverged =
      u !== undefined &&
      days(weeks[u].week, weeks[k].week) <= 365 &&
      q[k] < q[u] &&
      (r6[k] >= r6[u] + P.wkRsiGap || dif[k] > dif[u]);
    return diverged ? [{ week: weeks[k].week, visible: weeks[k + 1].week }] : [];
  });
}

type APoint = { r: Row; firstHi: string; lastHi: string };

/**
 * 磨底型的 A 要这一波恐慌(VIX ≥ 30 的那一簇,前后各放 1 周)里出现过周线底背离、且到 asOf 已确认;V 形不过滤。
 * 按簇不按 A 的日子:2022 年 09-30 那周背离,这一波的最低点两周后(10-14)才出来,也要认。
 * 用户 2026-11-26 定:磨底型里 A 单独出现只说明进了底部区域(2022 年 2 月起冒出约 20 个),等周线背离再认
 */
function gateA(points: APoint[], grind: boolean, divs: WeeklyDiv[], asOf: string): APoint[] {
  if (!grind) return points;
  return points.filter((a) =>
    divs.some(
      (d) => d.visible <= asOf && d.week >= addDays(friday(a.firstHi), -7) && d.week <= addDays(friday(a.lastHi), 7),
    ),
  );
}
/** 磨底型的 B(日线背离)要和周线背离同周或相邻周 */
function gateB(dates: string[], grind: boolean, divs: WeeklyDiv[], asOf: string): string[] {
  if (!grind) return dates;
  return dates.filter((date) => divs.some((d) => d.visible <= asOf && Math.abs(days(friday(date), d.week)) <= 7));
}

/** 区间 [a, b] 内 key 最大的下标(并列取最早,同 pandas idxmax) */
function argMax(rows: Row[], a: number, b: number, key: (r: Row) => number) {
  let best = a;
  for (let i = a + 1; i <= b; i++) if (key(rows[i]) > key(rows[best])) best = i;
  return best;
}

/**
 * 阶段低点 A(seg 从 ② 起):VIX ≥ 30 的日子按簇分(相隔 > 7 天算新簇),簇内 VIX 峰 ≥ 通杀以来 VIX 最高的 90%
 * → 簇里 QQQ 最低那天。只用 seg 内的数据,截到哪天就是那天收盘可见的结果(状态机判底也用它)。
 * lastHi = 这一簇最后一个 VIX ≥ 30 的日子:离数据末日 ≤ 7 天的簇还没结束,A 还会挪
 */
function lowPointsA(seg: Row[]): APoint[] {
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
    .map((g) => ({
      r: g.reduce((lo, h) => (h.r.q < lo.r.q ? h : lo)).r,
      firstHi: g[0].r.date,
      lastHi: g[g.length - 1].r.date,
    }));
}

/** B:seg 里的日线底背离低点,且当周(往前 4 天内)VIX 最高 ≥ 30 */
function lowsBIn(rows: Row[], seg: Row[], div: Set<string>): string[] {
  return seg
    .filter((r) => div.has(r.date))
    .filter((r) => {
      const from = addDays(r.date, -4);
      return rows.some((w) => w.date >= from && w.date <= r.date && w.v >= P.botV);
    })
    .map((r) => r.date);
}

const NO_GHOST = { ghostA: [], ghostB: [], ghostBottoms: [], ghostKills: [] };

/** 从 from 这天(一个 VIX ≥ 30 的日子)往后,相隔 ≤ 7 天连着的 VIX ≥ 30 日子里最后一个 = 这一簇在全部数据里的终点 */
function clusterEnd(rows: Row[], from: string): string {
  return rows
    .filter((r) => r.date > from && r.v >= P.botV)
    .reduce((end, r) => (days(end, r.date) <= 7 ? r.date : end), from);
}

/** 阶段低点 A / B,区间 = ② 到 ③ 后 5 天(进行中到最后一天) */
function marks(rows: Row[], idx: Map<string, number>, div: Set<string>, divsW: WeeklyDiv[], ep: RotationEpisode) {
  const a = idx.get(ep.peakX as string) as number;
  const endDate = addDays(ep.bottom ?? rows[rows.length - 1].date, 5);
  const seg = rows.slice(a).filter((r) => r.date <= endDate);

  const lastDate = rows[rows.length - 1].date;
  const points = gateA(lowPointsA(seg), ep.kind === '磨底型', divsW, lastDate);
  const lowsA = points.map((a) => a.r.date);
  // 簇结束没有要看到数据最后一天:seg 截在 ③ + 5 天,进行中·见底时截断后面还可能接着有 VIX ≥ 30 的日子
  const lowsAOpen = ep.outcome.startsWith('进行中')
    ? points.filter((a) => days(clusterEnd(rows, a.lastHi), lastDate) <= 7).map((a) => a.r.date)
    : [];

  const lowsB = gateB(lowsBIn(rows, seg, div), ep.kind === '磨底型', divsW, lastDate);

  return { lowsA, lowsAOpen, lowsB };
}

/** 跑完整段历史,返回每一轮(含被排除的)。序列需升序 */
export function rotationEpisodes(qqq: Point[], xlp: Point[], vix: Point[], hyOas: Point[]): RotationEpisode[] {
  const rows = joinRows(qqq, xlp, vix, hyOas);
  // ② 只在 ① 之后第一次 EMA20 下穿 EMA50(死叉)之后找、不含死叉当天(死叉收盘才出现,分界线在它右边):进攻腿趋势还没转弱时 XLP 先见顶,只是防守在涨,
  // 算不上高切低的终点(用户 2026-11-26 定;2022-01-04 那个 ② QQQ 离 ① 才 −1.9%)。EMA 与 TradingView 默认均线同口径
  const e20 = ewm(
    rows.map((w) => w.q),
    2 / 21,
  );
  const e50 = ewm(
    rows.map((w) => w.q),
    2 / 51,
  );
  const deathCross = (from: number, upto: number) => {
    for (let j = from + 1; j <= upto; j++) if (e20[j] < e50[j] && e20[j - 1] >= e50[j - 1]) return j;
    return -1;
  };
  // 本轮 ② 的候选:死叉之后(严格在死叉日右边,也在上一轮底之后)XLP 最高那天;还没死叉 → 没有
  const xlpPeak = (l1: number, upto: number) => {
    const dc = deathCross(l1, upto);
    return dc < 0 || dc + 1 > upto ? -1 : argMax(rows, Math.max(l1, lastEnd, dc + 1), upto, (w) => w.x);
  };
  const idx = new Map(rows.map((r, i) => [r.date, i]));
  const at = (i: number) => rows[i].date;

  type Cur = Omit<
    RotationEpisode,
    'kind' | 'outcome' | 'continuation' | 'lowsA' | 'lowsAOpen' | 'lowsB' | `ghost${string}`
  > & { seen: Seen; grind: boolean }; // grind:进入通杀那天第一阶段 VIX 是否到过 30(磨底型)
  let state: '正常' | '冷却' | '高切低' | '通杀' | '见底' = '正常';
  let cur: Cur | null = null;
  let coolUntil = '';
  let lastEnd = 0; // 上一轮底(或作废那天)的下标:本轮 XLP 高点从它之后找
  const closed: { c: Cur; outcome: Outcome }[] = [];
  const close = (c: Cur, outcome: Outcome) => closed.push({ c, outcome });
  const div = dailyDivergences(rows);
  const divsW = weeklyDivergences(rows);

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
        seen: { a: new Set(), b: new Set(), bottoms: new Set(), kills: [] },
        grind: false,
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
      const xpk = xlpPeak(l1, i);
      if (xpk >= 0 && r.x / rows[xpk].x - 1 <= P.killX && r.v >= P.killV) {
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
          cur.grind = rows.slice(l1, i + 1).some((w) => w.v >= P.botV);
        }
      } else if (qdd > P.resetQ) {
        close(cur, '未通杀');
        state = '正常';
        cur = null;
      }
    } else if (state === '通杀' && cur) {
      const l2 = idx.get(cur.peakX as string) as number;
      if (r.x > rows[l2].x) {
        cur.seen.kills.push({ from: cur.peakX as string, to: r.date });
        state = '高切低';
        cur.peakX = undefined;
        cur.confirm2 = undefined;
        continue;
      }
      // 底候选 = 截至当天的 A 点里 QQQ 最低的一天(规格 §2;参考脚本取的是「VIX ≥ 30 且 ≥ 当时最高 90% 的日子」,
      // VIX 冲顶回落后 QQQ 才创新低时两者会分开,用户 2026-11-26 定按规格,③ 总落在某个 A 上)
      const lo = gateA(lowPointsA(rows.slice(l2, i + 1)), cur.grind, divsW, r.date)
        .map((a) => a.r)
        .reduce<Row | null>((m, w) => (m === null || w.q < m.q ? w : m), null);
      if (lo && r.q / lo.q - 1 >= P.endUp && r.v < P.endV) {
        state = '见底';
        cur.bottom = lo.date;
        cur.confirm3 = r.date;
        cur.seen.bottoms.add(lo.date);
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

    if (cur?.peakX && (state === '通杀' || state === '见底')) {
      const { seen } = cur;
      const end = cur.bottom ? addDays(cur.bottom, 5) : r.date;
      const seg = rows.slice(idx.get(cur.peakX), i + 1).filter((w) => w.date <= end);
      gateA(lowPointsA(seg), cur.grind, divsW, r.date).forEach((p) => {
        seen.a.add(p.r.date);
      });
      // B 要等低点后 5 个交易日才确认:当天能看到的只到 i − 5
      const visible = rows[i - 5]?.date ?? '';
      gateB(lowsBIn(rows, seg, div), cur.grind, divsW, r.date)
        .filter((d) => d <= visible)
        .forEach((d) => {
          seen.b.add(d);
        });
    }
  }

  // 进行中:还在高切低时 ② 取目前为止的 XLP 高点(待定;还没死叉就没有)
  if (cur && (state === '高切低' || state === '通杀' || state === '见底')) {
    const xpk = cur.peakX ? -1 : xlpPeak(idx.get(cur.peakQ) as number, rows.length - 1);
    close({ ...cur, peakX: cur.peakX ?? (xpk >= 0 ? at(xpk) : undefined) }, `进行中·${state}`);
  }

  let prevPeak: { q: number; end: string } | null = null;

  return closed.map(({ c: { seen, grind: _grind, ...c }, outcome }) => {
    const e: RotationEpisode = {
      ...c,
      outcome,
      kind: 'V 形',
      continuation: false,
      lowsA: [],
      lowsAOpen: [],
      lowsB: [],
      ...NO_GHOST,
    };
    // 分型看第一阶段(① 到进入通杀那天;进行中还没通杀的到最后一天;被排除 / 作废的到确认高切低那天)VIX 有没有 ≥ 30
    const p1End = e.confirm2 ?? (e.outcome.startsWith('进行中') ? rows[rows.length - 1].date : e.confirm1);
    const grind = rows.slice(idx.get(e.peakQ)).some((r) => r.date <= p1End && r.v >= P.botV);
    const kind: RotationEpisode['kind'] = grind ? '磨底型' : 'V 形';
    // 标注只给走完 / 进行中的轮;进行中还在高切低时没有通杀,不找阶段低点
    const shown = e.outcome === '走完' || e.outcome.startsWith('进行中');
    const m =
      shown && e.confirm2 ? marks(rows, idx, div, divsW, { ...e, kind }) : { lowsA: [], lowsAOpen: [], lowsB: [] };
    if (!shown) return { ...e, kind, ...m };

    const not = (final: (string | undefined)[]) => (d: string) => !final.includes(d);
    const ghosts = {
      ghostA: [...seen.a].filter(not(m.lowsA)),
      ghostB: [...seen.b].filter(not(m.lowsB)),
      ghostBottoms: [...seen.bottoms].filter(not([e.bottom])),
      ghostKills: seen.kills,
    };

    const q1 = rows[idx.get(e.peakQ) as number].q;
    const end = e.bottom ?? e.peakQ;
    const continuation = prevPeak !== null && q1 < prevPeak.q && days(prevPeak.end, e.peakQ) < 730;
    prevPeak = continuation && prevPeak ? { q: prevPeak.q, end } : { q: q1, end };
    return { ...e, kind, continuation, ...m, ...ghosts };
  });
}

/** 标签图层的取值 → 文字(ChartDoc 的 markers 画法按值查这张表;分型标在 ① 上,待定标在未确认的 ② 上) */
export const ROTATION_LABELS: Record<string, string> = {
  '1': '磨底型(A 需周线背离)',
  '2': 'V 形',
  '3': '磨底型·续段(A 需周线背离)',
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
    rpLowA: dots(shown.flatMap((e) => e.lowsA.filter((d) => !e.lowsAOpen.includes(d)))),
    rpLowACandidate: dots(shown.flatMap((e) => e.lowsAOpen)),
    rpLowB: dots(shown.flatMap((e) => e.lowsB)),
    // 当时出现过、事后挪走 / 撤销的:淡色叠在最终版上,回看时还原当时看到的样子
    rpLowAGhost: dots(shown.flatMap((e) => e.ghostA)),
    rpLowBGhost: dots(shown.flatMap((e) => e.ghostB)),
    rpBottomGhost: dots(shown.flatMap((e) => e.ghostBottoms)),
    rpKillGhost: flag(dates, (d) => shown.some((e) => e.ghostKills.some((k) => d >= k.from && d < k.to))),
    rpLabel: [
      ...shown.map((e) => ({ date: e.peakQ, value: label(e) })),
      ...shown.filter((e) => pending(e) && e.peakX).map((e) => ({ date: e.peakX as string, value: 5 })),
    ].sort((a, b) => a.date.localeCompare(b.date)),
  };
}
