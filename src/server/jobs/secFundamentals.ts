import type { Database } from 'bun:sqlite';
import {
  insertSecFundamentals,
  insertMarketSeries,
  getSecFundamentals,
  getLatestSecFiled,
  getLatestSecPeriodEnd,
  getSecProcessedFiled,
  putSecProcessedFiled,
  putSecWatermark,
  getMarketSeriesByPrefix,
  type MarketSeriesRow,
} from '../storage/repository';
import { createSecFetcher, type LatestFiling } from '../fetchers/secXbrl';
import {
  extractFundamentals,
  financeLeaseShare,
  parseXbrlInstance,
  mergeFacts,
  segmentCumulativeFill,
  deriveSeries,
  aggregateFcf,
  seriesId,
  trailingContiguous,
  capexScopeOf,
  tagConflicts,
  BUYER_FCF_SERIES,
  BUYER_FCFQ_SERIES,
  CONCEPTS,
  type DerivedSeries,
  type QuarterPoint,
  type SeriesKind,
} from '../analytics/secFundamentals';
import {
  REQUIRED_CONCEPTS_BY_SIDE,
  activeBySource,
  activeInSecTable,
  cikOf,
  expectedCapexScope,
  financeLeaseCeiling,
  isAggregateMember,
  knownGap,
  segmentFactsOf,
  segmentKindsOf,
  sideOf,
  type SecKind,
} from '../../shared/aiChain';

/**
 * SEC XBRL 财务:AI 链里**走 SEC 这一路**的公司(名单里 source 省略或为 'sec' 的那些)。
 * 非美国发行人走别的源,见 jobs/twseRevenue 与 shared/aiChain 的 ChainSource。
 *
 * 流程:submissions(几百 KB)比 filed → 有新 10-Q/10-K 才拉 companyfacts(几 MB)
 *      → 归一化成单季行落 sec_fundamentals → 派生 TTM 三条 + 合计 FCF 写 market_series。
 *
 * CLI 入口是 jobs/aiChainFundamentals.ts(按源分派),不是本文件。
 */

// 只声明**这条 job 真的用到的**三个方法,不写成整个 createSecFetcher 的返回类型:
// 否则 fetcher 上加一个只给别处用的方法(如回填用的 periodicFilings),这里所有测试桩都得跟着补。
type Fetcher = Pick<ReturnType<typeof createSecFetcher>, 'latestFiling' | 'companyFacts' | 'filingInstance'>;

const SEC_SERIES_PREFIX = 'SEC_';
const SEC_SERIES_PREFIX_ESCAPED = 'SEC\\_'; // LIKE 的 `_` 是通配符,转义后才是字面下划线
const key = (r: MarketSeriesRow) => `${r.seriesId}@${r.obsDate}=${r.value}`;

/**
 * 体检结论带上是**哪一家**的。派生量是 sec ∪ sec6k 一起算的,但 job_run 是各源各记一条:
 * 不带 ticker 的话,MSFT(companyfacts 源)缺科目会把 `sec6k_reports` 那盏灯也弄黄,
 * 反之亦然 —— 而体检按设计每轮复发,于是一个未登记的结构性问题会让**两盏灯长期同时黄**。
 * 调用方按自己那个源下的名单筛。
 */
export type DerivedProblem = { ticker: string; message: string };

/**
 * 按**当前启用名单**整体重算派生量,和库里现有的 `SEC_*` 比对:一致就一行都不写。
 *
 * 为什么不是「只算本轮抓到的那几家」:合计线的口径随名单变化(多一家 = 每个点都变),而名单变更
 * 恰恰发生在「手动单跑核对 → 通过 → 加进启用名单」之后的那一轮 —— 那一轮所有公司都会
 * 因为没有新申报而 skip。若重算挂在「有抓到东西」上,合计线会停在旧名单口径,最长等三个月才自愈。
 *
 * 为什么用「算完比对」而不是无条件重写:算是纯本地计算(微秒级),写才是副作用。比对相同就跳过,
 * 既保证名单变更能自愈,又让没有变化的那几轮真的是 no-op。
 *
 * 删而不是只 upsert:名单缩小或历史点减少时,旧点会残留成一条口径不一的线,upsert 清不掉。
 */
/**
 * 面板的每一种格子 → (库里的序列后缀, 从 DerivedSeries 里取哪一条)。
 *
 * 写成 `Record<SecKind, …>` 而不是手列数组:以后往 `SOURCE_KINDS` 加一种格子却忘了在这写派生,
 * **直接编译报错**。手列的话编译过得去,只会在面板上画一条永远「暂不可用」的线 ——
 * 那不是静默(路由会把它归 unavailable),但要等有人打开那个 tab 才发现。
 */
const DERIVED_BY_KIND: Record<SecKind, { id: SeriesKind; pick: (d: DerivedSeries) => QuarterPoint[] }> = {
  gm: { id: 'GM', pick: (d) => d.gmTtm },
  capex: { id: 'CAPEX', pick: (d) => d.capexTtm },
  fcf: { id: 'FCF', pick: (d) => d.fcfTtm },
  fcfq: { id: 'FCFQ', pick: (d) => d.fcfQ },
  rev: { id: 'REV', pick: (d) => d.revTtm },
  revGrowth: { id: 'REVG', pick: (d) => d.revGrowth },
  // 只有报了分部收入的那家算得出来;其余公司这一条恒为空数组,写不出行(见 deriveSeries)。
  capexCloud: { id: 'CAPEXCLOUD', pick: (d) => d.capexCloud },
};

export function writeDerivedSecSeries(
  db: Database,
  active: string[],
  examine: string[],
): { written: number; problems: DerivedProblem[] } {
  // 体检范围 = 启用名单 ∪ 本轮抓过的(单跑核对某家时它还没进启用名单,但那正是最该体检的时刻)。
  const all = [...new Set([...active, ...examine])].map((t) => [t, getSecFundamentals(db, t)] as const);

  // 派生只算启用且库里真有数据的那几家——刚加进名单还没抓的那家不该把合计清空。
  const loaded = all.filter(([t, rows]) => active.includes(t) && rows.length > 0);
  const derived = loaded.map(([ticker, rows]) => [ticker, deriveSeries(rows)] as const);

  const perTicker: MarketSeriesRow[] = derived.flatMap(([ticker, d]) =>
    Object.values(DERIVED_BY_KIND).flatMap(({ id, pick }) =>
      pick(d).map((p) => ({ seriesId: seriesId(ticker, id), obsDate: p.date, value: p.value })),
    ),
  );

  // ① 完整性体检:**每轮从库里查**,不挂在「这一轮有没有抓到东西」上。
  // 挂在抓取那一轮只会报一次 —— 行落库后水位前进,下周直接 skip,缺 revenue/cogs 的家从此
  // 永远没有毛利率线却再也没人提。放这里则每轮复发,直到 tag 链补好。
  // 体检对象 = 库里有数据的(启用名单里 ∪ 本轮单跑核对的那家)。「启用了但还没抓过」的 0 行是
  // 正常的、不报;而「拉到了却一行没落」在抓取处就被拦成 failed 了,到不了这里。
  //
  // 判据按**最新一期**而非全历史并集:某家若在新申报里把某科目换成链外 tag,老季度仍留在库里,
  // 按并集看四个科目全都「有过」→ 一条告警不报,而 TTM 因缺季不出新点、线静默停在旧日期。
  // 按最新一期看则立刻暴露。(rows 由 getSecFundamentals 按 period_end 升序返回。)
  //
  // 只对**该 side 判据真正用到的科目**报警(见 REQUIRED_CONCEPTS_BY_SIDE),且跳过已知结构性缺口
  // (KNOWN_GAPS)—— 对一个换源才能修的东西每轮报警,只会把真信号淹掉。
  const problems = all
    .filter(([, rows]) => rows.length > 0)
    .flatMap(([ticker, rows]) => {
      const latest = rows.at(-1)?.periodEnd;
      const present = new Set(rows.filter((r) => r.periodEnd === latest).map((r) => r.concept));
      // 分部科目**一律算必需**:声明了 SEGMENT_FACTS 就意味着「这家该有这条线」。
      // 它是整条链上最容易静默断掉的一档 —— 成员改名 / 命名空间前缀变体 / 实例结构变了,
      // 任何一种都只让正则失配、抽出 0 行,而合并科目照常推进水位 → job 绿灯、面板少一格。
      const segments = segmentFactsOf(ticker).map((s) => s.concept);
      const required = [...REQUIRED_CONCEPTS_BY_SIDE[sideOf(ticker) ?? 'buyer'], ...segments];
      const concepts: string[] = [...CONCEPTS, ...segments];
      const missing = concepts.filter((c) => required.includes(c) && !present.has(c) && !knownGap(ticker, c));

      // 非必需科目缺失只记日志,不进 problems(不把 job 变黄)。已知缺口连日志都不记。
      const soft = CONCEPTS.filter((c) => !required.includes(c) && !present.has(c) && !knownGap(ticker, c));
      if (soft.length) console.warn(`[secFundamentals] ${ticker} 最新一期缺非必需科目 ${soft.join('/')}(该格会空)`);

      return missing.length
        ? [
            {
              ticker,
              message:
                `${ticker}: 最新一期(${latest ?? '无数据'})缺**判据必需**科目 ${missing.join('/')} —— ` +
                '四种病因,处置方向不同:① mapping_gap:tag 链没覆盖到这家 → 补 TAG_CHAINS;' +
                '② disclosure_absent:源本季根本没有这条行 → 补不了,接受缺格(裁剪规则已保证图上不画假斜率);' +
                '③ source_capability_gap:数在 SEC 原始 XBRL 里、但是公司自定义(extension)概念,' +
                'companyfacts 不聚合 → 换源才能修,确认后登记进 KNOWN_GAPS。' +
                '④ 分部科目(cloudRev 这类)另有第四种:成员名 / 维度轴 / 命名空间前缀变了 → ' +
                '解析正则失配、抽出 0 行,去那一期实例里 grep 成员名,再改 SEGMENT_FACTS。' +
                '先去 sec_fundamentals 看 tag_used、再对着该期 filing 原文判是哪一种。',
            },
          ]
        : [];
    });

  // ② 合计 FCF **只汇总买方**(§6.14 判据线)。卖方在涨价周期里正 FCF 极大,混进来会让
  // 「跌破零轴」永远不成立。另:某家一个 FCF 点都出不来时把它排除并报出——aggregateFcf 要求
  // 每季每家都有点,一家全空会让整条线静默变空,而静默是这里唯一不可接受的行为。
  // 成员判据用 isAggregateMember(buyer 且在因果链内),不是光看 side ——
  // 目录里若有非链内的 buyer,光看 side 会让它静默把零轴垫高。
  const buyers = derived.filter(([t]) => isAggregateMember(t));

  // ③ 买方 capex 口径**偏离声明**才报。不报「大家不一致」——AMZN 2017 后就没有纯 PP&E tag 可选,
  // 那个不一致永远存在,报了就是永久黄灯(见 CAPEX_SCOPE_EXPECTED)。不可比本身写在面板文案里。
  // 值得报的是换档:合计线的零轴位置随之变了,必须有人看一眼那家的报表原文。
  problems.push(
    ...loaded
      .filter(([t]) => isAggregateMember(t))
      .flatMap(([t, rows]) => {
        const latestCapex = rows.filter((r) => r.concept === 'capex').at(-1);
        const scope = latestCapex && capexScopeOf(latestCapex.tagUsed);
        const want = expectedCapexScope(t);
        if (!scope || scope === want) return [];

        return [
          {
            ticker: t,
            message:
              `${t}: capex 口径从声明的 ${want} 变成 ${scope}(最新一期 tag=${latestCapex!.tagUsed})—— ` +
              '合计线的零轴位置不再可比,核一下该家报表原文,再改 CAPEX_SCOPE_EXPECTED',
          },
        ];
      }),
  );
  problems.push(
    ...buyers
      .filter(([, d]) => d.fcfTtm.length === 0)
      .map(([t]) => ({
        ticker: t,
        message: `${t}: 一个 TTM FCF 点都算不出,已排除出买方合计线(检查 ocf/capex 的 tag)`,
      })),
  );
  // 上面那条只覆盖**库里有数据**的家。已启用却一行都没抓到的买方连 derived 都进不去,
  // 于是被静默排除出合计 —— 线照画,成员却少一家,图上完全看不出来(而「离零轴多远」正取决于成员数)。
  problems.push(
    ...active
      .filter((t) => isAggregateMember(t) && !derived.some(([d]) => d === t))
      .map((t) => ({
        ticker: t,
        message: `${t}: 已启用的买方,但库里一行数据都没有 —— 买方合计线少了这一家,零轴距离不可读`,
      })),
  );

  // ④ 分部序列**出现断档就报**,而且每轮复发。
  //
  // 为什么这一条不能省:完整性体检(①)只看「最新一期」——10-K 那轮 Q4 没合成出来会变黄,
  // 可下一份 10-Q 一到,最新一期变成 Q1、科目齐全,**告警自动消失**,而 Q4 那个洞是永久的:
  // 日常 job 只读当期申报的实例,补那一季要的 9M 在别的申报里,只能人工跑 secBackfillInstances。
  // 洞留着的后果不是「少一个点」——这一格是折线,路由会用 trailingContiguous 把洞之前的历史
  // 全砍掉,面板上只剩一两个点。绿灯 + 一条短线,正是本仓库最不能接受的形态。
  //
  // 只对分部序列做:别的线有**修不掉的**历史断档(NVDA FY2013–FY2021 的 capex 在 XBRL 里就不存在),
  // 对它们报就是一盏永久黄灯,会把真信号淹掉(同 CAPEX_SCOPE_EXPECTED 的理由)。
  problems.push(
    ...derived.flatMap(([ticker, d]) =>
      segmentKindsOf(ticker).flatMap((kind) => {
        const points = DERIVED_BY_KIND[kind].pick(d);
        const visible = trailingContiguous(points);
        if (visible.length === points.length) return [];

        // 比值是两条腿的交集,**断档可能来自任一条** —— 不点明是哪条,看的人会照着去跑分部回填,
        // 而缺的若是 capex 那边,跑多少次都补不上。
        const gapAt = visible[0]!.date; // 有断档 ⇒ visible 非空
        const rows = loaded.find(([t]) => t === ticker)?.[1] ?? [];
        const legs = ['capex', ...segmentFactsOf(ticker).map((s) => s.concept)];
        const thin = legs.filter((c) => !rows.some((r) => r.concept === c && r.periodEnd < gapAt));

        return [
          {
            ticker,
            message:
              `${ticker}: 分部序列 ${seriesId(ticker, DERIVED_BY_KIND[kind].id)} 中间有断档 —— ` +
              `共 ${points.length} 点,断档后只剩尾部 ${visible.length} 点会上图(缺口止于 ${gapAt})。` +
              `缺的是这几条腿之一:${legs.join(' / ')}${thin.length ? `(库里缺口前完全没有 ${thin.join('/')})` : ''}。` +
              '若缺的是分部那条:日常 job 补不回历史,跑 ' +
              '`bun run src/server/jobs/secBackfillInstances.ts <TICKER> --limit=N` 再重算派生。',
          },
        ];
      }),
    ),
  );

  const aggregate = aggregateFcf(new Map(buyers.filter(([, d]) => d.fcfTtm.length > 0).map(([t, d]) => [t, d.fcfTtm])));
  // 单季合计同一套日历季度对齐;它是判据的早期读数(TTM 要四季累积才跌破零轴)。
  const aggregateQ = aggregateFcf(new Map(buyers.filter(([, d]) => d.fcfQ.length > 0).map(([t, d]) => [t, d.fcfQ])));
  const desired = [
    ...perTicker,
    ...aggregate.map((p) => ({ seriesId: BUYER_FCF_SERIES, obsDate: p.date, value: p.value })),
    ...aggregateQ.map((p) => ({ seriesId: BUYER_FCFQ_SERIES, obsDate: p.date, value: p.value })),
  ];

  const stored = getMarketSeriesByPrefix(db, SEC_SERIES_PREFIX);
  const same =
    stored.length === desired.length &&
    new Set(stored.map(key)).symmetricDifference(new Set(desired.map(key))).size === 0;
  if (same) return { written: 0, problems };

  // 删 + 写同一事务:中途崩掉会让整族序列空着,而下一轮比对又会以为「库里就是这样」。
  // LIKE 里的 `_` 是单字符通配符,必须转义——否则这条 DELETE 会匹配「SEC + 任意一字符」开头的序列。
  db.transaction(() => {
    db.run(`DELETE FROM market_series WHERE series_id LIKE ? ESCAPE '\\'`, [`${SEC_SERIES_PREFIX_ESCAPED}%`]);
    insertMarketSeries(db, desired);
  })();

  return { written: desired.length, problems };
}

export async function updateSecFundamentals(
  db: Database,
  // activeTickers 只为测试留口(要验买/卖分侧就必须能换名单);CLI 不传,取名单里走 SEC 的那些。
  opts: { tickers?: string[]; force?: boolean; fetcher?: Fetcher; activeTickers?: string[] } = {},
): Promise<{
  fetched: string[];
  skipped: string[];
  failed: string[];
  fallback: string[];
  rowsWritten: number;
  seriesWritten: number;
}> {
  const active = opts.activeTickers ?? activeBySource('sec');
  const tickers = opts.tickers ?? active;
  const sec = opts.fetcher ?? createSecFetcher();

  // 名单打错字要立刻炸,不能静默跳过——这是配置错误,不是数据源故障。
  const unknown = tickers.filter((t) => !cikOf(t));
  if (unknown.length) throw new Error(`unknown SEC ticker: ${unknown.join(', ')}`);

  const fetched: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];
  const fallback: string[] = []; // 走了申报实例兜底才拿到新一期的那几家(值得在日志里看见)
  let rowsWritten = 0;

  // 逐家串行:SEC 限速 10 req/s,且 companyfacts 有几 MB,并发没意义。
  // 单家失败只记 failed 继续跑下一家 —— 一家网络抖动不该让其余公司整轮不更新。
  for (const ticker of tickers) {
    try {
      // **submissions 无论如何都要打**(几百 KB)。`--force` 跳过的只是 skip 判定,不是这一步 ——
      // 早先 force 连 submissions 都不打,于是 force 成功吃进新一季后 processed_filed 不前进,
      // 此后每一轮:不 skip → 拉几 MB → 期末已不再前进 → 判 failed。**永久红灯 + 每轮重拉**,
      // 要等下一份 10-Q(最长约三个月)。而文档里恰恰写着「想立刻验就 --force 单跑那一家」。
      const latest: LatestFiling | null = await sec.latestFiling(cikOf(ticker)!);
      // 无条件记远端水位(不管后面拉不拉 companyfacts):面板要靠它区分「这家还没到财报期」
      // 和「财报已交但 companyfacts 还没吃进」。放在 skip 判定之前,否则稳态下永远不更新。
      if (latest) putSecWatermark(db, ticker, latest.filed);

      // 拿不到定期报告申报日 ≠ 正常跳过。大盘股必然有 10-Q/10-K,拿不到说明源出问题
      // (SEC 改了 filings.recent 结构 / 字段更名 / 响应降级)。若归入 skipped,每家都 null 时
      // 会变成「永远绿灯、永远零写入」的假绿。记 failed 但仍不拉几 MB。
      if (!latest) {
        failed.push(`${ticker}: submissions 里没有 10-Q/10-K 申报日(源结构可能变了),未拉 companyfacts`);
        continue;
      }

      // 本地水位用「**已处理到哪一份**」而不是 sec_fundamentals 的 MAX(filed):
      // 不带财务 XBRL 的修订件(只补 Part III / 重发附件的 10-K/A)一行都不落,
      // 拿 MAX(filed) 比就永远追不上远端 → 天天重拉几 MB + 常驻黄灯,要等下一份 10-Q 才自愈。
      //
      // ⚠️ 是 **COALESCE 而不是取两者较大**:`MAX(filed)` 会被**比较期**追平 —— 一份 10-Q 在
      // companyfacts 里同时贡献本季与去年同季,后者也带着新 filed 落库。于是新一季被期间长度/
      // 差分规则挡住时,MAX(filed) 照样追平远端 → 下一轮直接 skip → 守卫**只复发一轮**、
      // 第二轮起 job 转绿,正是它要防的假绿灯。processed_filed 只在 advanced() 为真时才写,
      // 所以它在场时说了算;为 NULL(v5 之前的旧库 / 这家第一次见)则**就地播种**。
      //
      // ⚠️ 播种必须在拉 companyfacts **之前**:拉完之后 MAX(filed) 已被这份申报的比较期抬上去,
      // 那时再播就是把假水位固化。而完全不播的话 COALESCE 会长期回落到 MAX(filed),
      // 上面防的事等于没防(实测:守卫第一轮报、第二轮就 skip 转绿)。
      //
      // ⚠️ 播种**不受 force 管**,只有下面那个 skip 判定归 force 管:v5 迁移只加列不回填,
      // 旧库里 processed_filed 全是 NULL,若播种也塞进 force 分支里,
      // 「--force 单跑那一家」(文档推荐的核对方式)就会把一份已处理过的申报判成 failed。
      let localFiled = getSecProcessedFiled(db, ticker);
      if (localFiled === null) {
        localFiled = getLatestSecFiled(db, ticker);
        if (localFiled) putSecProcessedFiled(db, ticker, localFiled);
      }

      if (!opts.force && localFiled && latest.filed <= localFiled) {
        skipped.push(ticker);
        continue;
      }
      const remoteFiled = latest.filed;

      // 拿到的行一律落库(可审计)。科目完整性搬到 writeDerived 每轮从库里体检(那里才能复发),
      // 但**这一轮有没有拿到东西必须在这里判**:writeDerived 只看得见「库里最新一期」,
      // 而库里已有历史的那家若新申报一行都解析不出(四科目全换链外 tag / SEC 改了 facts 结构 /
      // 响应降级成空 JSON),最新一期仍是那条旧的、四科目齐全的期 → 体检一条不报 → 绿灯 +
      // 水位不前进 + 每周白拉几 MB。稳态下(库早就有数据)这是唯一会发生的形态。
      // 落库**前**的最新期末:advanced() 靠「它有没有变大」判断这一轮是不是真吃进了新一季。
      const periodEndBefore = getLatestSecPeriodEnd(db, ticker);

      // **在拉 companyfacts 之前**抓一次:库里是不是已经吃进过这一份申报的行。
      // 只给分部公司的「实例重试轮」当指纹用 —— 上一轮 companyfacts 已经落了行、期末已经前进,
      // 所以重试那一轮 advanced() 必然为 false,没有这个指纹就永远判不出「其实已经处理完了」。
      // 必须在 insert 之前抓,之后抓恒为真。
      const seenThisFiling = (getLatestSecFiled(db, ticker) ?? '') >= latest.filed;

      const companyFacts = await sec.companyFacts(cikOf(ticker)!);

      // tag 冲突只能在这里查:库里只存了链序赢的那个值,输的那个没留下,事后查不出来。
      // 取值本身是安全的(链序 = 口径优先级),这条只是提醒去核「是不是换口径了」。
      failed.push(
        ...tagConflicts(companyFacts).map(
          (c) =>
            `${ticker}: ${c.concept} 在 ${c.period} 有两个 tag 值不一致 —— ` +
            `取了 ${c.a.tag}=${c.a.val}(filed ${c.a.filed}),另有 ${c.b.tag}=${c.b.val}(filed ${c.b.filed});` +
            '口径可能变了,去核一下该期报表原文',
        ),
      );

      // 融资租赁漏计:同 tagConflicts,**只能在这里对着原始 facts 做** —— 这个科目不落库
      // (为什么不做成序列见 analytics 的 financeLeaseShare)。只查买方:卖方的租赁不进合计线。
      const lease = isAggregateMember(ticker) ? financeLeaseShare(companyFacts) : undefined;
      const ceiling = financeLeaseCeiling(ticker);
      if (lease && ceiling !== undefined && lease.share > ceiling) {
        const pct = (x: number) => `${Math.round(x * 100)}%`;
        failed.push(
          `${ticker}: 融资租赁新增 ROU 占该财年现金 capex ${pct(lease.share)}(财年止 ${lease.fy}),` +
            `超过声明的 ${pct(ceiling)} —— 租来的产能不进 ocf−capex(取得非现金、本金走筹资),` +
            '买方合计线的零轴被垫高了这么多。核一下该家现金流量表的补充披露,再改 FINANCE_LEASE_SHARE_CEILING',
        );
      }

      const rows = extractFundamentals(ticker, companyFacts);
      insertSecFundamentals(db, rows);
      rowsWritten += rows.length;

      // 判据是「**最新期末有没有往前走**」,不是 rows.length、也不是 MAX(filed) / accn:
      //  · rows.length 盖不住「拉到了但新那一期没解析出来」(库里已有历史时它恒 > 0)。
      //  · MAX(filed) 与 accn 都会被**比较期**带偏:一份 10-Q 在 companyfacts 里同时贡献本季
      //    与去年同季,后者也带着新的 filed/accn 落库 → 新一季即使被期间长度或差分规则挡住,
      //    这两个判据照样为真 → 兜底不跑、假绿灯、面板不标滞后。期末推进才是「新一期」本身。
      //  · 例外是**修订件**(10-Q/A):它合法地只重述旧期、不带来新期末,期末判据对它不成立。
      //    而且**修订件可能压根不带财务 XBRL**(只补 Part III / 重发附件),那种一行都不落也
      //    完全正常 —— 所以修订件一律算已处理,只在贡献了行时才说得上「补到了什么」。
      //    代价:一份真该带重述却没解析出来的 /A 会被放过。相比「常驻黄灯 + 天天重拉几 MB」
      //    这个确定会发生的代价,换它划算;真重述会在下一份 10-Q 的比较期里再来一次。
      //
      // ponytail: 这是「本轮之前 → 之后」的**相对**比较,所以进程若在 insert 与
      // putSecProcessedFiled 之间被杀(OOM / launchd 超时),下一轮会看到期末不再前进而永久判 failed。
      // 根治要换成**绝对**判据(拿 submissions 的 reportDate 比库里最新期末),但那得先确认
      // 各家 10-Q/10-K 的 reportDate 与 XBRL 期末逐份一致 —— 真实数据验过再改。
      //  · 还有一个例外是 `--force` **重跑一份已经处理过的申报**:期末当然不会再前进,那不是失败。
      //    普通路径到不了这里就已经 skip 了,所以这个分支只在 force 时成立,不削弱守卫。
      const isAmendment = latest.form.endsWith('/A');
      const alreadyProcessed = (getSecProcessedFiled(db, ticker) ?? '') >= latest.filed;
      const advanced = () =>
        isAmendment || alreadyProcessed || (getLatestSecPeriodEnd(db, ticker) ?? '') > (periodEndBefore ?? '');

      // 读申报实例的两个理由,**性质完全不同**:
      //  ① companyfacts 落后于 submissions —— 临时的,稳态下这个分支零开销。
      //  ② 这家有**分部科目**(如 Google Cloud 收入)—— 那一档带 XBRL 维度,companyfacts
      //     按设计永远不聚合,所以**每份新申报都得读一次**(GOOGL 实测 2.9MB × 一年 4 次)。
      //     不是「落后」,补不到 companyfacts 里,别指望它下周自愈。
      // **必须与 companyfacts 合并再算**:现金流多数只报本年累计,单季靠差分 —— 减掉的上一季在
      // companyfacts 里。兜底自身的失败单独记:直接往外抛会让 catch 只报「没找到实例」,
      // 盖掉真正的主症状(companyfacts 落后),下面那条诊断必须还能发出来。
      const segments = segmentFactsOf(ticker);
      const wasBehind = !advanced();
      let segmentReadFailed = false;
      if (segments.length || wasBehind) {
        try {
          const stored = getSecFundamentals(db, ticker);
          const xml = await sec.filingInstance(cikOf(ticker)!, latest.accn);
          const patch = parseXbrlInstance(xml, latest, {}, segments);
          // 10-K 的分部数只有全年,减掉的 9M 在上一份 10-Q 的实例里(companyfacts 永远没有)——
          // 用库里已有的单季行把它加回来,否则每年 Q4 静默缺一格。见 segmentCumulativeFill。
          const base = mergeFacts(companyFacts, patch);
          const patched = extractFundamentals(ticker, mergeFacts(base, segmentCumulativeFill(base, stored)));
          insertSecFundamentals(db, patched);
          rowsWritten += patched.length;
          // 只有**真的是来兜底**的那次才记进 fallback:②的读取是常态,记了会让日志天天有一行
          // 「走了兜底」,而那个词在这里的意思是「companyfacts 落后了」,看的人会去查一个不存在的病。
          if (wasBehind && advanced()) fallback.push(`${ticker}(${latest.form} ${latest.filed})`);
        } catch (e) {
          segmentReadFailed = segments.length > 0;
          failed.push(`${ticker}: 申报实例读取失败(${e instanceof Error ? e.message : String(e)})`);
        }
      }

      // 这一份处理完了 —— 不管它有没有带来行。skip 判据读它,否则「合法地不带行」的修订件
      // 会让水位永远追不上远端(见上面 isAmendment 那段与 schema.sql 的 processed_filed)。
      //
      // **例外:分部公司的实例没读成**。旧代码里实例只在 `wasBehind` 时读,读失败 ⇒ advanced()
      // 必为 false ⇒ 水位不动 ⇒ 下一轮自动重试 —— 「catch 住继续走」是靠这个前提才安全的。
      // 分部这条路把前提打破了:companyfacts 已跟上时 advanced() 早就为真,一次 SEC 429 / 超时
      // 就会把水位推过去,那一季的分部数**日常 job 再也不读第二次**,只能人工跑回填。
      // 一次网络抖动换一个要人工介入的永久洞,不划算 —— 不推进,下一轮重来。
      //
      // ⚠️ **重试轮不能再用 advanced() 判「处理完了」**:它是「本轮之前 → 之后期末有没有变大」的
      // 相对比较,而上一轮 companyfacts 已经把新一期落库了,重试轮期末不会再动 → advanced() 恒 false
      // → 水位永远推不动 → 每轮重拉几 MB + 常驻红灯,要等下一份财报(最长三个月)才自愈。
      // 这正是当初引入 processed_filed 要消灭的形态(见 schema.sql),不能自己再造一个。
      // 故重试轮改用 `seenThisFiling` 这个指纹:库里已经有这一份 filed 的行 = companyfacts 那半边
      // 上一轮就做完了,这一轮只欠实例;实例读到了,这一份就算处理完。
      // **只对分部公司放开**:普通公司若也认这个指纹,「拉到了却一行没落」的守卫会被比较期带偏
      // (一份 10-Q 同时贡献去年同季,MAX(filed) 照样被抬高)—— 那是它当初刻意不用 MAX(filed) 的理由。
      const retriedInstance = segments.length > 0 && seenThisFiling;
      const done = () => (advanced() || retriedInstance) && !segmentReadFailed;

      if (done()) putSecProcessedFiled(db, ticker, latest.filed);

      if (!done()) {
        // 实例读挂那种已经在上面记过真症状了,别再叠一条指向「tag 链变了」的错诊断 ——
        // 这一轮的行可能落得好好的,只是分部那半边没读到。
        if (!segmentReadFailed) {
          failed.push(
            `${ticker}: companyfacts 与申报实例都没贡献新一期的行(远端 filed=${remoteFiled ?? '未查'});` +
              'tag 链或 SEC 响应结构可能变了,水位不会前进 → 下次仍会重拉',
          );
        }
        continue;
      }

      fetched.push(ticker);
    } catch (e) {
      failed.push(`${ticker}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 无条件重算但只在结果有变化时才写(见 writeDerived):没变化的那几周仍是零写入。
  // 完整性问题每轮复发,并入 failed —— 有问题时 job 记 partial,状态灯不会绿。
  // 派生范围是 sec ∪ sec6k(少了 sec6k 那家的线永远不出);activeTickers 那个测试口子要能穿透到这里,
  // 否则用子集名单跑时会拿全名单去体检,报一堆「这家没数据」。
  const { written, problems } = writeDerivedSecSeries(db, opts.activeTickers ?? activeInSecTable(), fetched);
  // **只收自己源下那几家的体检结论**:TSM/ASML(sec6k)的问题不该把这盏灯弄黄,它们各有一条 job_run。
  // 本轮抓过的也算自己的 —— 单跑核对一家还没进启用名单的公司时,那正是最该看见体检结论的时刻。
  const mine = new Set([...active, ...fetched]);
  failed.push(...problems.filter((p) => mine.has(p.ticker)).map((p) => p.message));

  return { fetched, skipped, failed, fallback, rowsWritten, seriesWritten: written };
}

// CLI 入口在 jobs/aiChainFundamentals.ts —— 那里按源分派(本文件只管 SEC 那一路)。
