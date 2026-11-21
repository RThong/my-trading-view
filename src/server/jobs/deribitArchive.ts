import type { Database } from 'bun:sqlite';
import { defaultDeribitOptionsClient } from '../fetchers/deribitOptions';
import { readArchived, type ArchiveRun } from '../fetchers/snapshotArchive';
import { runOptionsSnapshot } from './optionsSnapshot';

/**
 * 存档里一份 Deribit 链:fetch.sh 照 client 的请求原样存的三类响应(带 `{ result }` 外壳),
 * 加上开抓那一刻 fetchedAt(毫秒)—— 选到期日、算 delta、打戳都按它,不按目录名(那是整轮结束时刻,跨 UTC 零点会错一天)。
 * 2026-11-21 前的存档是逐合约 ticker 格式(`tickers`,没有 `summary`):那些天早已写进库,重放时跳过。
 */
type ArchivedChain = {
  fetchedAt: number;
  instruments: unknown;
  index: unknown;
  summary?: unknown;
};

/**
 * 只收 UTC 21:30 之后抓的(= 定时那两轮,美东收盘后):手动 / 推送触发的白天那轮不收,
 * 否则它会因为「同一天最早」抢掉定时那份,快照时刻又飘起来。不带 fetchedAt 的旧格式(Invalid Date)也不收。
 */
export function deribitArchiveUsable(fetchedAt: Date): boolean {
  return fetchedAt.getUTCHours() * 60 + fetchedAt.getUTCMinutes() >= 21 * 60 + 30;
}

/**
 * 把 Actions 存档(见 fetchers/snapshotArchive)里的 Deribit 期权链写进库,返回写好的 `标的|日期`。
 * 用同一个 client 重放存档(不联网、按抓取时刻选到期日、按抓取时刻的 UTC 日打戳),算法与本机实抓完全一致。
 * 同一 UTC 日只认最早那份;每轮把 14 天存档整段重写 —— 本机同一天抓的那份(UTC 02~13 点)会被盖成存档这份,
 * 快照时刻于是统一在美东收盘后,与 IBIT 同标签日对齐。fetched_at 记存档的抓取时刻。
 */
export async function ingestArchivedDeribit(
  db: Database,
  runs: ArchiveRun[],
  underlyings: string[],
): Promise<Set<string>> {
  const covered = new Set<string>();
  const jobs = runs.flatMap((run) => underlyings.filter((u) => run.names.has(`deribit-${u}`)).map((u) => ({ run, u })));

  // 逐份串行(runs 已按抓取时刻升序):同一天先写进 covered 的就是最早那份
  await jobs.reduce(async (prev, { run, u }) => {
    await prev;
    // 一份坏文件只跳过它,不挡后面的(坏文件会在存档里留 14 天)
    await ingestOne(run, u).catch((err: Error) =>
      console.warn(`Deribit 存档 ${run.dir} ${u} 写库失败,跳过:${err.message}`),
    );
  }, Promise.resolve());

  return covered;

  async function ingestOne(run: ArchiveRun, u: string): Promise<void> {
    const chain = JSON.parse(readArchived(run, `deribit-${u}`)) as ArchivedChain;
    const at = new Date(chain.fetchedAt);
    if (!chain.summary || !deribitArchiveUsable(at) || covered.has(`${u}|${at.toISOString().slice(0, 10)}`)) return;

    const bodies: Record<string, unknown> = {
      get_instruments: chain.instruments,
      get_book_summary_by_currency: chain.summary,
      get_index_price: chain.index,
    };
    const client = defaultDeribitOptionsClient({
      fetch: async (url) => {
        const body = bodies[new URL(url).pathname.split('/').pop() ?? ''];
        return body ? Response.json(body) : new Response('not archived', { status: 404 });
      },
      now: () => at,
    });

    const { rows, failures } = await runOptionsSnapshot({
      db,
      source: 'deribit',
      underlyings: [u],
      client,
      fetchedAt: at,
    });
    rows.forEach((r) => {
      covered.add(`${r.underlying}|${r.snapshotDate}`);
    });
    if (failures.length) console.warn(`Deribit 存档 ${run.dir}:${failures.join('; ')}`);
  }
}
