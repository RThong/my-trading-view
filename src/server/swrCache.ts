import { readFileSync, mkdirSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * 服务端 stale-while-revalidate 缓存:给「现拉外部源、慢且偶尔卡」的路由用(regime、FRED 那几条曲线)。
 *
 * 为什么不是普通 TTL:普通 TTL 过期 / 进程刚起时,请求要**现场等最慢的那个源** —— EIA 偶发卡 40s,
 * 共用这条路由的二十多格就一起空白 40s。dev 下 `--watch` 每改一次后端就重启、内存缓存清空,撞上的频率很高。
 *
 * 行为:
 *  · 有值(内存里的,或进程刚起时读到的盘上快照)→ **立刻回**;过期了就顺手起一次后台刷新,`refreshing: true`。
 *    盘上快照读回即视为过期(见 readSnapshot)。
 *  · 真冷(内存、盘上都没有)→ 只能现场等一次 load。
 *  · load 结果不完整(某源失败)→ 照样入内存(调用方可用上一份把缺口补上),但只「新鲜」`retryMs`,
 *    之后再试 —— 不粘 TTL 那么久,也不至于每个请求都打一轮全套上游。**不写盘**:盘上只留完整的。
 *  · load 直接抛错 → 旧值照回、同样 `retryMs` 后再试(不让每个请求都撞一次失败的上游);真冷时只能把错抛给调用方。
 *  · 并发刷新合并成一次。
 *
 * `partial: true` = 当前值不完整:前端据此隔几分钟再取一次 —— 服务端不自己定时刷新,重试要靠有请求进来。
 */
export type SwrLoad<T> = (prev: T | null) => Promise<{ value: T; complete: boolean }>;

export function createSwrCache<T>(opts: {
  ttlMs: number;
  /** 不完整结果多久后重试。 */
  retryMs: number;
  load: SwrLoad<T>;
  /** 完整结果 gzip JSON 落盘的路径;省略 = 只在内存。 */
  snapshotPath?: string;
  now?: () => number;
}) {
  const now = opts.now ?? Date.now;
  type Entry = { at: number; value: T; complete: boolean };
  // undefined = 还没读过盘;null = 读过、没有。
  let entry: Entry | null | undefined;
  let inflight: Promise<Entry> | null = null;

  const readSnapshot = (): Entry | null => {
    if (!opts.snapshotPath) return null;
    try {
      const snap = JSON.parse(new TextDecoder().decode(Bun.gunzipSync(readFileSync(opts.snapshotPath))));
      // 一律当过期:照样立刻回,但马上后台重拉一次。快照是**上一版代码**算的 —— dev 改了构造逻辑
      // (新增序列 / 改算法)后重启,不能拿旧结果再顶 6 小时。盘上只写完整的,故 complete 恒真。
      return { value: snap.value, at: Number.NEGATIVE_INFINITY, complete: true };
    } catch {
      return null; // 没有 / 坏了 → 当真冷处理
    }
  };

  // 写盘失败只告警:快照是锦上添花,不能连带丢掉这次已经拉成功的结果。
  const writeSnapshot = (snap: { at: number; value: T }) => {
    const path = opts.snapshotPath;
    if (!path) return;
    const warn = (e: unknown) => console.warn(`[swrCache] 快照写盘失败 ${path}: ${(e as Error).message}`);
    try {
      mkdirSync(dirname(path), { recursive: true });
      // 先写临时文件再 rename(同目录 rename 是原子的):写到一半进程被 `--watch` 重启也不会留下截断的 gz。
      const tmp = `${path}.tmp`;
      Bun.write(tmp, Bun.gzipSync(JSON.stringify(snap)))
        .then(() => rename(tmp, path))
        .catch(warn);
    } catch (e) {
      warn(e);
    }
  };

  // 把「生成时刻」往前挪,让它在 retryMs 后就过期。
  const retryAt = () => now() - opts.ttlMs + opts.retryMs;

  const refresh = (): Promise<Entry> => {
    inflight ??= opts
      .load(entry?.value ?? null)
      .then(({ value, complete }) => {
        const next = { at: complete ? now() : retryAt(), value, complete };
        entry = next;
        if (complete) writeSnapshot({ at: next.at, value });
        return next;
      })
      .catch((e: unknown) => {
        if (!entry) throw e;
        // 标成不完整:前端据 partial 隔几分钟再取,把服务端的重试带起来(否则旧值会被当新鲜的一直挂着)。
        entry = { ...entry, at: retryAt(), complete: false };
        return entry;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };

  return {
    async get(): Promise<{ value: T; refreshing: boolean; partial: boolean }> {
      if (entry === undefined) entry = readSnapshot();
      if (!entry) {
        const { value, complete } = await refresh();
        return { value, refreshing: false, partial: !complete };
      }

      const refreshing = now() - entry.at >= opts.ttlMs;
      // 失败已在 refresh 里兜成「旧值 + retryMs 后再试」,这里只防真冷之外的意外。
      if (refreshing) refresh().catch((e: unknown) => console.warn(`[swrCache] 后台刷新失败: ${(e as Error).message}`));
      return { value: entry.value, refreshing, partial: !entry.complete };
    },
  };
}
