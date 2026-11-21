import type { Database } from 'bun:sqlite';
import { openDb, migrate } from '../storage/db';
import { closedBars } from '../live/market';
import { OPTIONS_UNDERLYINGS } from '../config';
import { archiveUsable } from './cboeArchive';

/**
 * 切换 CBOE 主源前的验收(见 docs/options-cboe-switch.md)。只读。
 *   bun run src/server/jobs/compareOptionsSources.ts
 * 只看最近 WINDOW 个并行日,逐标的。并行日 = 并行开始(首个 `@cboe` 日)以来 SPY 日线有收盘的交易日 ——
 * 交易日要取自独立的源:只认 CBOE 有数据的日子,它整轮失败那天会从「并行日」里消失;认 moomoo 的,OpenD 挂了(常态)
 * 又会和 CBOE 同时缺而查不出。SPY 日线现拉 Yahoo(见 live/market),不依赖任何一边。
 *  · 每天都要有 CBOE 的行(缺一天 = ❌,抓取有问题)
 *  · ETF / TLT:skew 与 moomoo 差的**中位数**在线内(个别日子超线不卡 —— 翼上流动性薄的标的单日会跳);
 *    moomoo 个别天没数只标注;窗口里一天都对照不上 = 无法验收,判失败
 *  · VIX:moomoo 的值本身不可用,不比差;只看库里那天的 VIX 是不是收盘后、夜盘前抓的(fetched_at 落在 archiveUsable 窗口,
 *    即 Actions 存档写的)。原先看「最后成交 ≤ 16:15:59 + 价差」:夜里文件的报价 / IV 跟着夜盘走、成交时间却停在收盘前,拦不住(2026-11-17 实测)
 */

const WINDOW = 5;
// skew 差中位数的验收线(pp):不分红 ETF 两边口径一致;TLT 为 moomoo 按分红重算后的残差
// (所以验收前要先跑一次 repairMoomooOptions --write,把并行期间 moomoo 新写的 TLT 也重算掉,见清单)。
// USO / IBIT 两边有固定方向的口径差(11-13~19 每天:USO −0.3~−0.7、CBOE put IV 低;IBIT +0.2~+0.6、CBOE call IV 低),
// 不是噪声;2026-11-21 用户定接受切换那天约 0.5pp 的台阶,线放到 0.8 只挡「抓坏了」
const LIMIT: Record<string, number> = { TLT: 0.5, USO: 0.8, IBIT: 0.8 };
const DEFAULT_LIMIT = 0.3;
type Row = { underlying: string; snapshot_date: string; skew: number };

function median(v: number[]): number | undefined {
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function vixCheck(db: Database, date: string): { ok: boolean; line: string } {
  const r = db
    .query(`SELECT fetched_at f FROM option_snapshot_25delta WHERE underlying = '.VIX@cboe' AND snapshot_date = ?`)
    .get(date) as { f: string } | null;
  if (!r) return { ok: false, line: `  .VIX  ${date} 没有 CBOE 25Δ ❌` };

  const ok = archiveUsable(date, new Date(r.f));
  return { ok, line: `  .VIX  ${date} 抓于 ${r.f}${ok ? ' ✅' : '(不在收盘后、夜盘前)❌'}` };
}

/** spyDays:SPY 已收盘的交易日(升序),由调用方现拉传入,本函数只读库。 */
export function compareOptionsSources(db: Database, spyDays: string[]): { lines: string[]; pass: boolean } {
  const all = db
    .query(`SELECT underlying, snapshot_date, skew FROM option_snapshot_25delta WHERE snapshot_date >= '2026-11-13'`)
    .all() as Row[];
  const skew = new Map(all.map((r) => [`${r.underlying}|${r.snapshot_date}`, r.skew]));
  const start =
    all
      .filter((r) => r.underlying.endsWith('@cboe'))
      .map((r) => r.snapshot_date)
      .sort()[0] ?? '9999';
  const days = spyDays.filter((d) => d >= start).slice(-WINDOW);

  const perUnderlying = OPTIONS_UNDERLYINGS.map((u) => {
    const missing = days.filter((d) => !skew.has(`${u}@cboe|${d}`));
    if (u === '.VIX') {
      const checks = days.map((d) => vixCheck(db, d));
      const ok = !missing.length && checks.every((c) => c.ok);
      return {
        ok,
        lines: [
          `.VIX  只看抓取时刻(缺 CBOE 25Δ ${missing.length} 天)${ok ? ' ✅' : ' ❌'}`,
          ...checks.map((c) => c.line),
        ],
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
  const r = compareOptionsSources(
    db,
    (await closedBars('SPY')).value.map((b) => b.date),
  );
  db.close();
  r.lines.forEach((l) => {
    console.log(l);
  });
  console.log(r.pass ? '✅ 验收通过,可以按 docs/options-cboe-switch.md 切换' : '❌ 还不能切换(见上面标 ❌ 的行)');
}
