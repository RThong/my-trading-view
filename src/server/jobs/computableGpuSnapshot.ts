import type { Database } from 'bun:sqlite';
import { openDb, migrate } from '../storage/db';
import { insertMarketSeries } from '../storage/repository';
import { CGI_SKUS, fetchGpuIndexDaily, type CgiSku, type CgiDailyPoint } from '../fetchers/computableGpu';

/** B300 面板 provider 数最薄(见对话记录),不列为核心 —— 缺它不该拖垮这个 job 的 success 判定。 */
const CORE_SKUS: readonly CgiSku[] = ['H100', 'H200', 'B200'];

/**
 * 抓 Computable GPU Index(CGI)4 个 SKU 的观测点 → 按日(UTC)聚合成 period rate → market_series 的 CGI_{sku}。
 * (粒度由源决定且变过:6h → 1h → 15min,别在注释里写死,见 fetchers/computableGpu.ts 的说明。)
 * 单 SKU 各自独立容错(一个源挂了不连累其它三个)。
 * missing 判定看「今天(UTC)有没有新点」,不看整段历史行数 —— 源如果当天停更(仍在返回旧日均值),
 * rows.length 不为 0 但没有今天这条,这才是真正该报的「今天没抓到」,否则 job 会被错误记成功。
 * H100/H200/B200 今天缺任一算 missing,B300 允许缺(experimental)。幂等,同日重跑覆盖。
 * 直接运行:bun run src/server/jobs/computableGpuSnapshot.ts
 */
export async function updateComputableGpu(
  db: Database,
  fetchDaily: (sku: CgiSku) => Promise<CgiDailyPoint[]> = fetchGpuIndexDaily,
  todayUtc: string = new Date().toISOString().slice(0, 10),
): Promise<{ total: number; missing: string[]; errors: string[] }> {
  let total = 0;
  const missing: string[] = [];
  const errors: string[] = [];
  for (const sku of CGI_SKUS) {
    // 收下原因再降级,别只 `.catch(() => [])`:那样 job_run.error_message 只剩「核心 SKU 缺失
    // (数据源可能变动)」这句固定文案,而实际原因常常是断网 —— 2026-09-08 的 run 1760/1764 就是
    // getaddrinfo ENOTFOUND(同窗口别的 job 都如实记了),却被这条文案引向"去查 SKU/schema 变更"。
    const rows = await fetchDaily(sku).catch((e) => {
      errors.push(`${sku}: ${e?.message ?? e}`);
      return [] as CgiDailyPoint[];
    });
    if (rows.length) {
      insertMarketSeries(
        db,
        rows.map((r) => ({ seriesId: `CGI_${sku}`, obsDate: r.date, value: r.value })),
      );
      total += rows.length;
    }
    // 用 some 找「今天」而非取末位:不依赖 fetchDaily 返回值按日期排序这个隐式契约。
    if (CORE_SKUS.includes(sku) && !rows.some((r) => r.date === todayUtc)) missing.push(sku);
  }
  return { total, missing, errors };
}

if (import.meta.main) {
  const db = openDb();
  migrate(db);
  const { total, missing, errors } = await updateComputableGpu(db);
  db.close();
  console.log(
    `Computable GPU Index snapshot stored: ${total} rows.` +
      `${missing.length ? ` 缺:${missing.join(', ')}` : ''}${errors.length ? ` 抓取报错:${errors.join('; ')}` : ''}`,
  );
}
