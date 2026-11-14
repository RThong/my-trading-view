import type { Database } from 'bun:sqlite';
import { gunzipSync } from 'node:zlib';
import YahooFinance from 'yahoo-finance2';
import { openDb, migrate } from '../storage/db';
import { getMarketSeries } from '../storage/repository';
import { americanIvDelta } from '../analytics/optionPricing';
import { select25Delta, type OptionContract } from './optionsSnapshot';

/**
 * 一次性:切到 CBOE 主源前清理 moomoo 的 25Δ 历史(见 docs/data-sources-candidates.md §1.4)。原始链表不动,随时可重算。
 *  · TLT:moomoo 不计分红 → call IV 偏低约 1pp、put 偏高约 1.3pp。按「快照日 → 到期日之间实际除息」折成期限内
 *    等效分红率,用存下的中间价按美式二叉树重算 IV / delta、重选 25Δ(2026-11-13 与 CBOE 同日对比:skew 0.30 对 0.38)。
 *  · VIX:moomoo 以 VIX 现货(而非同到期远期)为标的算 IV,且约八成快照抓在夜盘、报价空或极宽,只有 15/101 天
 *    能修(2026-11 经 Codex 独立复核同此结论)→ 整段删掉 moomoo 的 VIX 25Δ,改从 CBOE 重新积累。
 * ⚠️ 切到 CBOE 主源之前,daily 的 moomoo 组每天还会写没计分红的 TLT(source='moomoo'),图上与修过的历史差约 2pp;
 *    切换那天跑 `--write --drop-vix` 会把这些天一并重算(本脚本读 moomoo / moomoo-recalc 两种)。
 * 只碰 moomoo 写的行(source = moomoo / moomoo-recalc):切到 CBOE 主源后误跑也不会改掉 CBOE 的数据。
 * 默认只打印前后对比;加 --write 才写库(只改 TLT);VIX 整段删另加 --drop-vix(切到 CBOE 主源那天再用,免得图上空一周)。
 *   bun run src/server/jobs/repairMoomooOptions.ts [--write [--drop-vix]]
 */

const DAY_MS = 86_400_000;
const YEAR_MS = 365 * DAY_MS;

/** 美东某日某时刻 → UTC 毫秒(按当天的夏令 / 冬令偏移,写死 UTC 时刻会有一端差 1 小时)。 */
export function etInstant(date: string, hhmm: string): number {
  const naive = Date.parse(`${date}T${hhmm}:00Z`);
  const off = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' })
    .formatToParts(naive)
    .find((x) => x.type === 'timeZoneName')!.value; // 'GMT-5' / 'GMT-4'
  return naive - Number(off.replace('GMT', '')) * 3_600_000;
}
// 有效报价 = 买卖价都 > 0 且价差不超过中间价的这个比例。moomoo 有些天抓到的是收盘后的占位报价
// (买 0 / 卖 1.8 之类,或价差比价格还大),拿它反解出的 IV 是乱数
const MAX_REL_SPREAD = 0.5;
// 一份链里有效报价不足这个比例 = 报价不可用的快照,删掉当天的值(正常的天 ≥ 80%)
const MIN_QUOTED_SHARE = 0.5;
// 只重算 25Δ 附近的合约:二叉树逐个反解较慢,远翼与深度价内用不到
const DELTA_BAND = [0.08, 0.5] as const;

type Raw = {
  snapshotDate: string;
  expiry: string;
  spot: number | null;
  calls: OptionContract[];
  puts: OptionContract[];
};

function firstTierChains(db: Database, underlying: string): Raw[] {
  // 第一档 = 当天两份链里到期日较近的那份(第二档是 ≥60 天的月度,只归档不进 25Δ)
  const rows = db
    .query(
      `SELECT snapshot_date, expiry, underlying_price, chain_json_gz FROM option_chain_raw
       WHERE underlying = $u AND source = 'moomoo'
         AND expiry = (SELECT MIN(expiry) FROM option_chain_raw r2
                       WHERE r2.underlying = $u AND r2.snapshot_date = option_chain_raw.snapshot_date AND r2.source = 'moomoo')
       ORDER BY snapshot_date`,
    )
    .all({ $u: underlying }) as {
    snapshot_date: string;
    expiry: string;
    underlying_price: number | null;
    chain_json_gz: Uint8Array;
  }[];

  return rows.map((r) => {
    const j = JSON.parse(gunzipSync(r.chain_json_gz).toString()) as { calls: OptionContract[]; puts: OptionContract[] };
    return { snapshotDate: r.snapshot_date, expiry: r.expiry, spot: r.underlying_price, ...j };
  });
}

function rateAt(db: Database, date: string): number {
  const p = getMarketSeries(db, 'ERIS_OIS_1M').findLast((x) => x.date <= date);
  if (!p) throw new Error(`${date} 之前没有 ERIS_OIS_1M`);
  return p.value / 100;
}

function mid(c: OptionContract) {
  return ((c.bid ?? 0) + (c.ask ?? 0)) / 2;
}
export function quoted(c: OptionContract) {
  const bid = c.bid ?? 0;
  const ask = c.ask ?? 0;
  return bid > 0 && ask > 0 && (ask - bid) / ((ask + bid) / 2) <= MAX_REL_SPREAD;
}
function inBand(c: OptionContract) {
  return Math.abs(c.delta ?? 0) >= DELTA_BAND[0] && Math.abs(c.delta ?? 0) <= DELTA_BAND[1];
}

// TLT 每月第一个工作日前后除息;源里还没有的(快照之后的)按最后一次金额、逐月第一个工作日补
// ponytail: 只跳周末、不认交易所假日(如元旦);只在除息日恰好落在窗口边界时差一天,要精确再接假日历
export function projectDividends(known: { date: string; amount: number }[], until: string) {
  const last = known.at(-1);
  if (!last) return known;
  const months = Array.from({ length: 4 }, (_, i) => {
    const first = new Date(`${last.date.slice(0, 7)}-01T00:00:00Z`);
    first.setUTCMonth(first.getUTCMonth() + i + 1);
    // 当月第一个工作日:月初往后最多 2 天就到周一
    const day = [0, 1, 2]
      .map((k) => new Date(first.getTime() + k * DAY_MS))
      .find((d) => ![0, 6].includes(d.getUTCDay()))!;
    return day.toISOString().slice(0, 10);
  });
  return [...known, ...months.filter((m) => m <= until).map((date) => ({ date, amount: last.amount }))];
}

/**
 * 期限内实际除息折成等效连续分红率(按全年平摊会低估:30 天里正好有一次除息)。
 * 窗口 = (快照日, 到期日]:快照日当天除息的已反映在当天收盘价里,到期日当天除息的持有人在到期前拿得到。
 */
export function windowDividendYield(
  divs: { date: string; amount: number }[],
  snapshotDate: string,
  expiry: string,
  S: number,
  T: number,
): number {
  return divs.filter((d) => d.date > snapshotDate && d.date <= expiry).reduce((s, d) => s + d.amount, 0) / S / T;
}

function repairTlt(db: Database, chain: Raw, divs: { date: string; amount: number }[]) {
  const all = [...chain.calls, ...chain.puts];
  if (all.filter(quoted).length / all.length < MIN_QUOTED_SHARE) return 'empty' as const;
  const S = chain.spot;
  if (!S) return null;
  // 快照日收盘 → 到期日收盘(都是美东 16:00)
  const T = (etInstant(chain.expiry, '16:00') - etInstant(chain.snapshotDate, '16:00')) / YEAR_MS;
  const r = rateAt(db, chain.snapshotDate);
  const q = windowDividendYield(divs, chain.snapshotDate, chain.expiry, S, T);
  const re = (arr: OptionContract[], call: boolean) =>
    arr
      .filter((c) => quoted(c) && inBand(c))
      .flatMap((c) => {
        const got = americanIvDelta(mid(c), { S, K: c.strike, T, r, q, call });
        return got ? [{ ...c, impliedVolatility: got.iv, delta: got.delta }] : [];
      });

  return { calls: re(chain.calls, true), puts: re(chain.puts, false), note: `q=${(q * 100).toFixed(2)}%` };
}

async function tltDividends() {
  const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
  const res = await yf.chart('TLT', { period1: '2026-01-01', interval: '1d', events: 'div' });
  return (res.events?.dividends ?? [])
    .map((d) => ({ date: new Date(d.date).toISOString().slice(0, 10), amount: d.amount }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

type Old = { snapshot_date: string; call_iv: number; put_iv: number; skew: number };

export async function repairMoomooOptions(db: Database, write: boolean, dropVix = false) {
  const divs = await tltDividends();
  type Outcome =
    | { kind: 'update'; u: string; date: string; c: number; p: number; s: number; line: string }
    | { kind: 'delete'; u: string; date: string; line: string }
    | { kind: 'keep'; line: string };

  const outcomes = ['TLT'].flatMap((u) => {
    const old = new Map(
      (
        db
          .query(
            `SELECT snapshot_date, call_iv, put_iv, skew FROM option_snapshot_25delta
             WHERE underlying = ? AND source IN ('moomoo', 'moomoo-recalc')`,
          )
          .all(u) as Old[]
      ).map((r) => [r.snapshot_date, r]),
    );

    return firstTierChains(db, u).flatMap((chain): Outcome[] => {
      const o = old.get(chain.snapshotDate);
      if (!o) return [];
      const fixed = repairTlt(db, chain, projectDividends(divs, chain.expiry));
      if (fixed === 'empty')
        return [
          {
            kind: 'delete',
            u,
            date: chain.snapshotDate,
            line: `${u} ${chain.snapshotDate} 报价不可用 → 删(原 skew ${o.skew.toFixed(2)})`,
          },
        ];
      if (!fixed?.calls.length || !fixed.puts.length)
        return [{ kind: 'keep', line: `${u} ${chain.snapshotDate} 重算不出,保留原值` }];

      const sel = select25Delta({
        underlyingSymbol: u,
        underlyingPrice: chain.spot,
        expirationDate: chain.expiry,
        ...fixed,
      });
      const n = { c: sel.callIv * 100, p: sel.putIv * 100, s: sel.skew * 100 };
      return [
        {
          kind: 'update',
          u,
          date: chain.snapshotDate,
          ...n,
          line: `${u} ${chain.snapshotDate} ${fixed.note.padEnd(9)} C ${o.call_iv.toFixed(2)}→${n.c.toFixed(2)}  P ${o.put_iv.toFixed(2)}→${n.p.toFixed(2)}  skew ${o.skew.toFixed(2)}→${n.s.toFixed(2)}`,
        },
      ];
    });
  });
  const updates = outcomes.filter((x) => x.kind === 'update');
  const deletes = outcomes.filter((x) => x.kind === 'delete');
  const vixRows = (
    db
      .query(`SELECT COUNT(*) n FROM option_snapshot_25delta WHERE underlying = '.VIX' AND source = 'moomoo'`)
      .get() as {
      n: number;
    }
  ).n;

  if (write) {
    db.transaction(() => {
      const up = db.query(
        `UPDATE option_snapshot_25delta SET call_iv = $c, put_iv = $p, skew = $s, source = 'moomoo-recalc'
         WHERE underlying = $u AND snapshot_date = $d AND source IN ('moomoo', 'moomoo-recalc')`,
      );
      updates.forEach((x) => {
        up.run({ $c: x.c, $p: x.p, $s: x.s, $u: x.u, $d: x.date });
      });
      const del = db.query(
        `DELETE FROM option_snapshot_25delta WHERE underlying = $u AND snapshot_date = $d AND source IN ('moomoo', 'moomoo-recalc')`,
      );
      deletes.forEach((x) => {
        del.run({ $u: x.u, $d: x.date });
      });
      // VIX 整段删(只删 moomoo 写的;并行试跑的 `.VIX@cboe` 不动)
      if (dropVix) db.run(`DELETE FROM option_snapshot_25delta WHERE underlying = '.VIX' AND source = 'moomoo'`);
    })();
  }

  return {
    lines: [
      ...outcomes.map((x) => x.line),
      `.VIX moomoo 25Δ 历史 ${vixRows} 天 → ${dropVix ? '整段删' : '暂不动(加 --drop-vix 才删)'}`,
    ],
    updated: updates.length,
    deleted: deletes.length + (dropVix ? vixRows : 0),
  };
}

if (import.meta.main) {
  const write = process.argv.includes('--write');
  const db = openDb();
  migrate(db);
  const r = await repairMoomooOptions(db, write, process.argv.includes('--drop-vix'));
  db.close();
  r.lines.forEach((l) => {
    console.log(l);
  });
  console.log(`${write ? '已写库' : '预览(未写库)'}:改 ${r.updated} 天,删 ${r.deleted} 天`);
}
