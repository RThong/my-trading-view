import type { Point } from '../analytics/regime';
import type { SeriesKey } from '../../shared/regimeSeries';
import { FUND_KEY_PREFIX, type FundTrim, type SecFiled, type SecLag } from '../../shared/aiChain';
import { type OhlcBar, OIS_HIKE_HORIZONS, DB_BACKED_KEYS } from './regimeKeys';

// /api/regime 的缓存策略:什么情况下这一份结果算「完整」可以缓存、缺的序列拿上一份顶上、库读与现拉怎么合并。
// 与取数无关的纯判断,从路由文件拆出来,方便单测(见 regime.test.ts)。

export type RegimeBody = {
  series: Record<string, Point[]>;
  unavailable: string[];
  ohlc?: Record<string, OhlcBar[]>;
  secLag?: SecLag[];
  secTrim?: FundTrim[];
  secFiled?: Record<string, SecFiled>;
  /** 本次现拉失败、沿用上一份成功数据顶上的序列(见 fillFromPrev)。 */
  fallback?: string[];
  /** 服务端缓存已过期、正在后台刷新:前端据此过几秒再取一次。 */
  refreshing?: boolean;
  /** 当前缓存值不完整(有源没拉到):服务端要等有请求进来才重试,前端据此隔几分钟再取一次。 */
  partial?: boolean;
};

/**
 * `moveLive` 单独存:MOVE 是「现拉的 Yahoo 腿 + 库里的补丁」合并出来的,
 * 而库那半边由 daily job(别的进程)写 —— 只缓存合并结果的话,job 补上的那天最长要等满 TTL 才出现。
 * 存住 live 腿,缓存命中时就能拿它重新和库里的 merge 一次,和 readDbBacked 的动机同一个。
 */
export type RegimeCached = {
  body: RegimeBody;
  moveLive: Point[];
  sofrLive: Point[];
  /** HY OAS 现拉腿,同 moveLive(库里是 daily job 镜像的长历史,见 jobs/creditSpreadSnapshot)。加这个字段前落盘的旧快照里没有 */
  hyOasLive?: Point[];
};

/**
 * 缓存里的外部源部分 + 本次读库结果。缓存(尤其是重启后读回的盘上快照)里那份库读序列是旧的:
 * 先整批剔掉,再塞本次读的 —— 只覆盖不剔的话,库里这次没有的 key 会拿缓存旧值冒充。
 * 按 key 集合剔除而不是按前缀:前缀耦合的话,以后往 JOB_WRITTEN_SERIES 里加一条
 * 不叫 gpu* 的(如 vix)就会漏剔,unavailable 里出现重复项。
 */
export function mergeDbRead(
  cached: RegimeBody,
  reads: { series: Record<string, Point[]>; ohlc?: Record<string, OhlcBar[]>; unavailable: string[] }[],
): Pick<RegimeBody, 'series' | 'ohlc' | 'unavailable'> {
  const isDbRead = (k: string) => k.startsWith(FUND_KEY_PREFIX) || DB_BACKED_KEYS.has(k);
  const liveOnly = <V>(rec: Record<string, V> = {}) =>
    Object.fromEntries(Object.entries(rec).filter(([k]) => !isDbRead(k)));

  return {
    series: Object.assign(liveOnly(cached.series), ...reads.map((r) => r.series)),
    ohlc: Object.assign(liveOnly(cached.ohlc), ...reads.map((r) => r.ohlc ?? {})),
    unavailable: [...cached.unavailable.filter((n) => !isDbRead(n)), ...reads.flatMap((r) => r.unavailable)],
  };
}

/**
 * SOFR live 腿(OIS 加息次数的基准)。现拉失败时拿上一份顶上,并把四条加息次数一起标 `fallback`:
 * 否则 `sofr` 线标「沿用上次」、以它为基准的加息次数却成「暂不可用」—— 同一个原因两种提示。
 */
export function resolveSofr(
  raw: Point[] | undefined,
  prev: Point[] | undefined,
): { sofrLive: Point[]; fallback: string[] } {
  if (raw?.length || !prev?.length) return { sofrLive: raw ?? [], fallback: [] };
  return { sofrLive: prev, fallback: OIS_HIKE_HORIZONS.map(([out]) => out) };
}

/**
 * 本次现拉失败的**外部源**序列,用上一份结果顶上,记入 `fallback`(面板标「沿用上次」)。
 * 库读的(`fund:*` / DB_BACKED_KEYS)不补:它们每次请求都重读库,缺了就是真缺。
 */
export function fillFromPrev(body: RegimeBody, prev: RegimeBody | undefined): RegimeBody {
  const fillable = body.unavailable.filter(
    (n) => !n.startsWith(FUND_KEY_PREFIX) && !DB_BACKED_KEYS.has(n) && prev?.series[n]?.length,
  );
  if (!prev || !fillable.length) return body;

  const pick = <V>(rec: Record<string, V> | undefined) =>
    Object.fromEntries(Object.entries(rec ?? {}).filter(([k]) => fillable.includes(k)));

  return {
    ...body,
    series: { ...body.series, ...pick(prev.series) },
    ohlc: { ...pick(prev.ohlc), ...body.ohlc },
    unavailable: body.unavailable.filter((n) => !fillable.includes(n)),
    fallback: fillable,
  };
}

/** 只有 gpu 这几条允许"缺着也缓存"(库没跑过 job 时必然缺、B300 长期允许缺)。 */
export const GPU_KEY_PREFIX = 'gpu';
/**
 * 这次结果算不算完整。**完整才长缓存(6h)+ 落盘**;降级结果只缓存 10 分钟就重试、不落盘(见 swrCache)。四类例外:
 *  · `fund:` —— SEC 季频,靠独立 job 逐季攒,从没跑过 job 的库里必然缺。
 *  · `gpu`  —— 新接的 experimental 源,允许缺。
 *  · EIA 那 12 条(见 `EIA_SERIES`),**且仅当没配 key 时** —— 那是配置状态,不是失败。
 *  · e-Stat 那条(新核心核心 CPI),同样**仅当没配 ESTAT_APP_ID 时**。
 *
 * ⚠️ 第三条的「仅当」是要害:配了 key 还缺 = 网络挂了或源结构变了,属 transient,
 * 就该算不完整、10 分钟后重试。一律豁免的话会把降级结果缓存 6 小时、还写进盘上快照。
 * ⚠️ 反过来不豁免也不行:README 把 EIA key 写成可选项,缺 key 时这 12 条恒缺 →
 * `every` 恒 false → 永远不完整:每 10 分钟重拉一轮全套上游,快照也永远写不进盘。
 */
export function shouldCache(
  unavailable: readonly string[],
  { hasEiaKey, hasEstatKey }: { hasEiaKey: boolean; hasEstatKey: boolean },
): boolean {
  // e-Stat 同理:没配 appId 时新核心核心 CPI 恒缺,是配置状态不是失败。
  const exempt = new Set<string>([...(hasEiaKey ? [] : EIA_SERIES), ...(hasEstatKey ? [] : ESTAT_SERIES)]);

  return unavailable.every((n) => n.startsWith(FUND_KEY_PREFIX) || n.startsWith(GPU_KEY_PREFIX) || exempt.has(n));
}

/**
 * ⚠️ **这张名单是手抄的,必须和 fetchFresh(routes/regime.ts)里实际 `put()` 的 EIA 线一致** ——
 * 现在 12 条:周报派生 8 条(开工率水位 + 4 条季节 z + 收率 + 2 条同比)+ 零售泵价 2 条 + 零售加价 2 条。
 * 将来加第 13 条却忘了同步,缺 key 时那条不在豁免里 → 缓存又会永久关不上(见 `shouldCache`)。
 * `regimeKeys.ts` 的 `DB_BACKED_KEYS` 有同构的回归测试,这里同样在 `routes/regime.test.ts` 里钉住。
 */
export const EIA_SERIES: readonly SeriesKey[] = [
  'refUtil',
  'refUtilZ5y',
  'distStocksZ5y',
  'gasStocksZ5y',
  'distExportsZ5y',
  'distYield',
  'crudeRunsYoy',
  'distProdYoy',
  // 零售两条与两条加价同样只在配了 key 时才有 —— 加价虽然有一条 Yahoo 腿(ULSD/RBOB),
  // 但缺 key 时零售腿为空、整条出不来,所以照样要豁免。裸 `ulsd` 不在此列(它与 EIA 无关)。
  'dieselRetail',
  'gasRetail',
  'dieselRetailMargin',
  'gasRetailMargin',
];

/** 只在配了 e-Stat appId 时才有的序列(见 shouldCache)。 */
export const ESTAT_SERIES: readonly SeriesKey[] = ['jpCoreCoreCpiYoy'];
