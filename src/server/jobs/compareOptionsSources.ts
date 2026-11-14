import type { Database } from 'bun:sqlite';
import { gunzipSync } from 'node:zlib';
import { openDb, migrate } from '../storage/db';
import { getPriceBars } from '../storage/repository';
import { OPTIONS_UNDERLYINGS } from '../config';
import type { OptionContract } from './optionsSnapshot';

/**
 * 切换 CBOE 主源前的验收(见 docs/options-cboe-switch.md)。只读。
 *   bun run src/server/jobs/compareOptionsSources.ts
 * 只看最近 WINDOW 个并行日,逐标的。并行日 = 并行开始(首个 `@cboe` 日)以来 SPY 日线(price_eod)有收盘的交易日 ——
 * 交易日要取自独立的源:只认 CBOE 有数据的日子,它整轮失败那天会从「并行日」里消失;认 moomoo 的,OpenD 挂了(常态)
 * 又会和 CBOE 同时缺而查不出。SPY 日线由 vrp_inputs 走 Yahoo 写,不依赖任何一边。
 *  · 每天都要有 CBOE 的行(缺一天 = ❌,抓取有问题)
 *  · ETF / TLT:skew 与 moomoo 差的**中位数**在线内(个别日子超线不卡 —— 翼上流动性薄的标的单日会跳);
 *    moomoo 个别天没数只标注;窗口里一天都对照不上 = 无法验收,判失败
 *  · VIX:moomoo 的值本身不可用,不比差;只看 CBOE 的 VIX 原始链是不是常规时段收盘报价
 */

const WINDOW = 5;
// skew 差中位数的验收线(pp):不分红 ETF 两边口径一致;TLT 为 moomoo 按分红重算后的残差
// (所以验收前要先跑一次 repairMoomooOptions --write,把并行期间 moomoo 新写的 TLT 也重算掉,见清单)
const LIMIT: Record<string, number> = { TLT: 0.5 };
const DEFAULT_LIMIT = 0.3;
// VIX 期权常规时段 16:15 收盘;晚于此的成交属于夜盘(20:15 起)
const VIX_CLOSE = '16:15:59';
// 平值附近 = |delta| 在这个区间(随 VIX 点位移动,不写死行权价);收盘时价差中位数约 5%,夜盘常比价格还宽
const NEAR_DELTA = [0.2, 0.5] as const;
const MAX_REL_SPREAD = 0.3;

type Row = { underlying: string; snapshot_date: string; skew: number };

function median(v: number[]): number | undefined {
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function vixCheck(db: Database, date: string): { ok: boolean; line: string } {
  const r = db
    .query(
      `SELECT chain_json_gz g FROM option_chain_raw WHERE underlying = '.VIX@cboe' AND snapshot_date = ?
       ORDER BY expiry LIMIT 1`,
    )
    .get(date) as { g: Uint8Array } | null;
  if (!r) return { ok: false, line: `  .VIX  ${date} 没有 CBOE 原始链 ❌` };

  const j = JSON.parse(gunzipSync(r.g).toString()) as { calls: OptionContract[]; puts: OptionContract[] };
  const all = [...j.calls, ...j.puts];
  const near = all.filter((c) => Math.abs(c.delta ?? 0) >= NEAR_DELTA[0] && Math.abs(c.delta ?? 0) <= NEAR_DELTA[1]);
  const spread = median(
    near.filter((c) => (c.bid ?? 0) > 0 && (c.ask ?? 0) > 0).map((c) => (c.ask! - c.bid!) / ((c.ask! + c.bid!) / 2)),
  );
  const last =
    all
      .map((c) => c.lastTradeDate ?? '')
      .sort()
      .at(-1) ?? '';
  // 最后成交必须是快照日当天、且不晚于 16:15:59(美东,文件里不带时区)—— 晚了说明混进了夜盘
  const ok = last.startsWith(date) && last.slice(11) <= VIX_CLOSE && spread !== undefined && spread <= MAX_REL_SPREAD;

  return {
    ok,
    line: `  .VIX  ${date} 最后成交 ${last || '无'} | 平值附近 ${near.length} 个、价差中位 ${spread?.toFixed(3) ?? '—'} ${ok ? '✅' : '❌'}`,
  };
}

export function compareOptionsSources(db: Database): { lines: string[]; pass: boolean } {
  const all = db
    .query(`SELECT underlying, snapshot_date, skew FROM option_snapshot_25delta WHERE snapshot_date >= '2026-11-13'`)
    .all() as Row[];
  const skew = new Map(all.map((r) => [`${r.underlying}|${r.snapshot_date}`, r.skew]));
  const start =
    all
      .filter((r) => r.underlying.endsWith('@cboe'))
      .map((r) => r.snapshot_date)
      .sort()[0] ?? '9999';
  const days = getPriceBars(db, 'SPY', { closedOnly: true })
    .map((b) => b.date)
    .filter((d) => d >= start)
    .slice(-WINDOW);

  const perUnderlying = OPTIONS_UNDERLYINGS.map((u) => {
    const missing = days.filter((d) => !skew.has(`${u}@cboe|${d}`));
    if (u === '.VIX') {
      const checks = days.map((d) => vixCheck(db, d));
      const ok = !missing.length && checks.every((c) => c.ok);
      return {
        ok,
        lines: [`.VIX  只看报价(缺 CBOE 25Δ ${missing.length} 天)${ok ? ' ✅' : ' ❌'}`, ...checks.map((c) => c.line)],
      };
    }

    const diffs = days.flatMap((d) => {
      const c = skew.get(`${u}@cboe|${d}`);
      const m = skew.get(`${u}|${d}`);
      return c === undefined || m === undefined ? [] : [c - m];
    });
    const limit = LIMIT[u] ?? DEFAULT_LIMIT;
    const med = median(diffs.map(Math.abs));
    const mmMissing = days.filter((d) => !skew.has(`${u}|${d}`)).length;
    const ok = !missing.length && med !== undefined && med <= limit;
    const note = med === undefined ? '(moomoo 全缺,无法对照)' : '';
    return {
      ok,
      lines: [
        `${u.padEnd(5)} 差中位 ${med?.toFixed(2) ?? '—'}${note}(线 ${limit})| 逐日 ${diffs.map((x) => x.toFixed(2)).join(' ')}` +
          ` | moomoo 缺 ${mmMissing} 天 | CBOE 缺 ${missing.length} 天 ${ok ? '✅' : '❌'}`,
      ],
    };
  });

  return {
    lines: [`并行日(最近 ${WINDOW} 个):${days.join(' ')}`, ...perUnderlying.flatMap((x) => x.lines)],
    pass: days.length >= WINDOW && perUnderlying.every((x) => x.ok),
  };
}

if (import.meta.main) {
  const db = openDb();
  migrate(db);
  const r = compareOptionsSources(db);
  db.close();
  r.lines.forEach((l) => {
    console.log(l);
  });
  console.log(r.pass ? '✅ 验收通过,可以按 docs/options-cboe-switch.md 切换' : '❌ 还不能切换(见上面标 ❌ 的行)');
}
