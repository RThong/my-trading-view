import type { Database } from 'bun:sqlite';
import { cboeSymbol, createCboeOptionsClient, lastTradeDay } from '../fetchers/cboeOptions';
import type { OptionsChainClient } from '../fetchers/optionsChain';
import { readArchived, type ArchiveRun } from '../fetchers/snapshotArchive';
import { runOptionsSnapshot } from './optionsSnapshot';

const DAY_MS = 86_400_000;

/**
 * 只收「交易日收盘后、VIX 期权夜盘开盘前」抓的存档:交易日 21:30 UTC ~ 次日 00:15 UTC。
 * 下界 = 16:30 EST:收盘 16:15 再加端点的 15 分钟延迟(夏令时是 17:30 EDT,晚一小时,偏保守);上界 = 20:15 EDT(冬令时是 19:15 EST,早一小时)。
 * 挡掉三类:夜盘报价的 VIX;手动 / 推送触发、不在点上的那几轮;美国假日那天定时任务又抓到的上一交易日文件
 * (同一份收盘数据,但按晚了一天的时刻选「约 30 天」那档,可能换到另一个到期日)。Actions 的定时(market-snapshots 的 snapshot.yml)要落在窗口内。
 */
export function archiveUsable(tradingDate: string, fetchedAt: Date): boolean {
  const t = fetchedAt.getTime();
  const day = Date.parse(`${tradingDate}T00:00:00Z`);

  return t >= day + 21.5 * 3_600_000 && t < day + DAY_MS + 0.25 * 3_600_000;
}

/**
 * 把 Actions 存档(见 fetchers/snapshotArchive)里的 CBOE 期权链写进库,返回写好的 `落库键|交易日`。
 * 每轮把 14 天的存档整段重写(同一份收盘数据,覆盖无害),本机没开 / 没网的那几天就是这样补上的。
 * 交易日逐文件按最后一笔成交定;同一「标的 | 交易日」有多份能用的存档时只认最早那份。
 */
export async function ingestArchivedOptions(
  db: Database,
  runs: ArchiveRun[],
  underlyings: string[],
  storeKey: (u: string) => string,
): Promise<Set<string>> {
  const covered = new Set<string>();

  // 逐轮串行(runs 已按抓取时刻升序):一份大标的的链解开好几 MB,一起读进来没必要
  await runs.reduce(async (prev, run) => {
    await prev;
    // 一轮里有坏文件只跳过这一轮,不挡后面的轮次(坏文件会在存档里留 14 天)
    await ingestRun(run).catch((err: Error) => console.warn(`存档 ${run.dir} 写库失败,跳过:${err.message}`));
  }, Promise.resolve());

  return covered;

  async function ingestRun(run: ArchiveRun): Promise<void> {
    const dated = underlyings
      .filter((u) => run.names.has(cboeSymbol(u)))
      .flatMap((u) => {
        const date = lastTradeDay(JSON.parse(readArchived(run, cboeSymbol(u))).data);
        return date && archiveUsable(date, run.fetchedAt) && !covered.has(`${storeKey(u)}|${date}`)
          ? [{ u, date }]
          : [];
      });
    const client = createCboeOptionsClient({
      // 不联网:URL 末段就是存档文件名(SPY.json → SPY)
      fetch: async (url) => new Response(readArchived(run, url.slice(url.lastIndexOf('/') + 1, -'.json'.length))),
      now: () => run.fetchedAt,
    });

    // 同一轮里交易日一般相同;万一某个文件滞后,按交易日分批写,各写各的日期
    await [...Map.groupBy(dated, (d) => d.date)].reduce(async (p, [date, ds]) => {
      await p;
      const { rows, failures } = await runOptionsSnapshot({
        db,
        source: 'cboe',
        underlyings: ds.map((d) => d.u),
        client: { ...client, getTradingDate: async () => date },
        storeKey,
        strictTradingDate: true,
        fetchedAt: run.fetchedAt,
      });
      rows.forEach((r) => {
        covered.add(`${r.underlying}|${r.snapshotDate}`);
      });
      if (failures.length) console.warn(`存档 ${run.dir}:${failures.join('; ')}`);
    }, Promise.resolve());
  }
}

/**
 * 本机实抓 CBOE 时给 VIX 加的闸:只在「收盘后、夜盘前」那段(同 archiveUsable 的窗口)才抓,否则抛错 → 这个标的记失败、整组 partial,
 * 当天后续触发点再试,其余标的照抓。走到实抓说明存档没写上那天(已覆盖的标的 runOptionsSnapshot 根本不会请求);
 * 本机触发点全落在 VIX 期权夜盘,夜里文件里的 VIX 报价 / IV 跟着夜盘走,不能当收盘写库。
 * ponytail: 周五晚上到周日没有夜盘、文件仍是周五收盘,这里也一律拦(要靠存档);存档常漏周五再按交易所日历放开。
 */
export function guardVixNightSession(client: OptionsChainClient, now = () => new Date()): OptionsChainClient {
  return {
    ...client,
    async fetchChain(underlying, targetDte) {
      if (underlying === '.VIX') {
        const date = await client.getTradingDate?.();
        if (!date || !archiveUsable(date, now()))
          throw new Error(`存档里没有 ${date} 收盘后的 VIX,本机现在不在收盘后、夜盘前,不抓(夜盘报价不能当收盘)`);
      }
      return client.fetchChain(underlying, targetDte);
    },
  };
}
