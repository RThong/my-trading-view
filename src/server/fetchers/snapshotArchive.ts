import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT } from '../config';

// GitHub Actions 定时抓的快照存档(私有仓库 market-snapshots,见其 fetch.sh)。
// 为什么要它:期权链、ICE CDS 只有当天快照、漏一天补不回来,而本机常整天关机 / 没网;
// 且 daily 的触发点全落在 VIX 期权夜盘,本机抓到的 VIX 是夜盘报价 —— Actions 在美东收盘后、夜盘前抓。
// data 分支每轮被压成一个无历史的提交强推,只留最近 14 天:data/<YYYY-MM-DDTHHMMZ>/<名字>.json.gz。
export const ARCHIVE_DIR = join(PROJECT_ROOT, 'data', 'market-snapshots');
const REMOTE = 'git@github.com:RThong/market-snapshots.git';
// 数据在单独的 data 分支(main 只放脚本:机器人强推 main 会让定时任务不触发)
const BRANCH = 'data';
const RUN_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2})(\d{2})Z$/;

export type ArchiveRun = { fetchedAt: Date; dir: string; names: Set<string> };

// 网络卡死 / 要输密码时别一直挂着:超时就当同步失败,本机照旧自己抓
const GIT_TIMEOUT_MS = 90_000;
const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=20',
};

function git(args: string[], cwd?: string): string {
  const r = Bun.spawnSync(['git', ...args], {
    cwd,
    env: GIT_ENV,
    timeout: GIT_TIMEOUT_MS,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  if (r.exitCode !== 0)
    throw new Error(`git ${args[0]} 失败:${r.stderr.toString().trim() || `超时 / 被终止(${r.signalCode ?? '?'})`}`);
  return r.stdout.toString().trim();
}

/** 拉最新存档(只要 data 分支、浅克隆最新一个提交);失败返回原因 —— 调用方照旧自己抓,不因存档挡住整组。
 *  这个目录只放 data 分支(没有脚本),reset --hard 不会丢东西;改 fetch.sh 另外克隆 main。 */
export function syncArchive(dir = ARCHIVE_DIR): string | null {
  try {
    if (!existsSync(join(dir, '.git')))
      git(['clone', '-q', '--depth', '1', '--single-branch', '--branch', BRANCH, REMOTE, dir]);
    else {
      git(['fetch', '-q', '--depth', '1', 'origin', BRANCH], dir);
      git(['reset', '-q', '--hard', 'FETCH_HEAD'], dir);
      // 每次都是无历史的新提交,旧提交的文件成了悬空对象,不清会越积越多
      git(['gc', '-q', '--prune=now'], dir);
    }
    return null;
  } catch (err) {
    return `快照存档同步失败(本轮照旧自己抓):${(err as Error).message}`;
  }
}

/** 存档里每一轮(按抓取时刻升序)及其包含的文件名(不带 .json.gz)。 */
export function archiveRuns(dir = ARCHIVE_DIR): ArchiveRun[] {
  const root = join(dir, 'data');
  if (!existsSync(root)) return [];

  return readdirSync(root)
    .flatMap((d) => {
      const m = RUN_RE.exec(d);
      if (!m) return [];
      const names = readdirSync(join(root, d))
        .filter((f) => f.endsWith('.json.gz'))
        .map((f) => f.slice(0, -'.json.gz'.length));
      return [{ fetchedAt: new Date(`${m[1]}T${m[2]}:${m[3]}:00Z`), dir: join(root, d), names: new Set(names) }];
    })
    .sort((a, b) => a.fetchedAt.getTime() - b.fetchedAt.getTime());
}

/** 存档文件的原文(JSON 文本)。 */
export function readArchived(run: ArchiveRun, name: string): string {
  return new TextDecoder().decode(Bun.gunzipSync(readFileSync(join(run.dir, `${name}.json.gz`))));
}

let synced: ArchiveRun[] | null = null;
/** 一个进程只同步一次(daily 的期权、ICE、MOVE 几组共用);同步失败就用本地已有的那份,并把原因打进日志。
 *  只给 daily 用:cryptoDaily 同一时刻触发,两个进程并发同步会弄坏仓库,它只读(archiveRuns)。 */
export function syncedArchiveRuns(): ArchiveRun[] {
  if (!synced) {
    const err = syncArchive();
    if (err) console.warn(err);
    synced = archiveRuns();
  }
  return synced;
}
