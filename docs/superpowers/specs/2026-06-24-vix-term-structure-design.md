# VIX 期限结构(VX1 − VX3 价差)设计

日期:2026-06-24
状态:待实现

## 背景与目标

当前 vol 工具箱能看 VIX 等波动率指数的**水平**,但缺**期限结构**——即近月与远月的关系。期限结构倒挂(近月高于远月)是"恐慌从短期变结构性"的开关,是工具箱里唯一明显的内部缺口。

本设计补这个缺口:用 CBOE VX 期货的 **VX1 − VX3 价差**(前月减第三月的点差)作为期限结构指标。

- 价差 > 0:近月高于远月 = **backwardation(倒挂,恐慌结构化)**
- 价差 < 0:近月低于远月 = **contango(正常)**
- 价差 ≈ 0:曲线走平

vixcentral.com 是该指标的标杆呈现,但其底层数据就是 CBOE VX 期货,本项目已直连 CBOE 抓取,**不爬 vixcentral**。

## 现状

- `src/server/fetchers/cboeVx.ts` 已能下载 CBOE 全部 VX 合约(产品列表 + 每合约 CSV 结算价),但目前只用 `computeFrontMonth` 算出近月 VX1。
- VX 序列**未接入** daily job;`backfillVx.ts` 是早期重构遗留的孤儿,当前 `market_series` 无任何 VX 序列(只有 VIX/VXN/GVZ/OVX/DVOL)。
- 前端 `.VIX` tab 有 3 个 pane(现货 / call+put IV / skew);`paneConfig(vrpUnderlying)` 按 vrpUnderlying 配 pane。

## 方案:存原始 VX1/VX3,读时算价差

与现有 VRP 模式一致(VRP 也是存原料、`routes/vrp.ts` 读时现算),不引入新范式。原始两条序列以后可复用(看绝对水平、扩 VX2 画曲线)。

### 1. 取数 — `cboeVx.ts`

- 把 `computeFrontMonth(contractRows)` 推广为 `computeNthMonth(contractRows, n)`:对每个交易日取**第 n 近**未到期合约。
- **实现陷阱**:现 `computeFrontMonth` 用 `Map<tradeDate, 最小 expireDate>` 的 min-tracking(cboeVx.ts:109-115),**只能表达 n=1**,不能照搬。`computeNthMonth` 必须换数据结构:
  - 按 `tradeDate` 分组所有候选行(`expireDate > tradeDate` 过滤后)→ 组内按 `expireDate` 升序 → 取 `index n-1`。
  - (同一交易日会出现在近月/次月/三月多份合约 CSV 里,故每个 tradeDate 组天然有多条不同 expireDate 候选。)
- `computeFrontMonth` 用 `computeNthMonth(., 1)` 表达,保持现有行为不变。
- 入口产出 VX1 与 VX3 两条 `QuoteRow[]`(分别 symbol='VX1' / 'VX3'),**两条都要套 `HISTORY_START_DATE` 过滤**(现仅 VX1 套了,cboeVx.ts:161)。
- 边界:某交易日合约数不足 n(如远期合约尚未上市的早期日期)→ 组内无 `index n-1`,该日 VX3 缺失,只输出有第 n 近合约的交易日(不补零、不抛错)。

### 2. 存储 — `market_series`(硬前提,非迁移兼容)

- 新增 `VX1`、`VX3` 两条序列(value = 当日结算价)。
- **必须把 `VX1`、`VX3` 加进 `src/server/storage/db.ts:47` 的 `VOL_INDICES`** —— 这不是"为兼容旧库迁移",而是数据**能否活过一天**的硬前提:
  - `migrateSpotToPriceEod` 里那句 `DELETE FROM market_series WHERE series_id NOT IN (VOL_INDICES)` **不是只在旧库迁移时跑**,而是 `migrate()` 每次被调用都跑;daily 入口每天 job 一启动就 `migrate(db)`(daily.ts:81)。
  - 后果:VX1/VX3 写进 `market_series` 后,第二天 job 一启动就被无条件删掉;又因取数是增量(`freshSince` 只 upsert 近期),历史段每天被删、永不补回 → 库里只剩一个滚动窗口。
  - 所以加名单是先决条件,不是优化。顺带把那句 DELETE 的注释改为"每次 migrate 都跑的全量 DELETE,任何新序列不进名单 = 每日被清"。

### 3. daily job — `updateVxTermStructure`

- 单一职责函数:用 fetcher 的 `freshSince` 增量抓近期合约,upsert VX1/VX3 进 `market_series`。
- 独立记一条 `job_run`(job_name='vx_term_structure'),成功/失败状态与既有 job 一致。
- 在 `daily.ts` 调用,与 options/vrp 组并列;单组失败不连累其它(沿用现有容错)。

### 4. 路由 — `/api/term-structure/vix`

- 返回 `[{date, vx1, vx3, spread}]`,按日 inner join VX1 与 VX3,`spread = vx1 - vx3`,读时算。
- 仅 VIX 有此指标,路径硬编 `vix` 即可(无需泛化白名单)。

### 5. 前端 — `.VIX` tab 加期限结构 pane

- `paneConfig` 增加 `underlying` 入参;当 `underlying === '.VIX'` 时追加 pane:
  `{ key: 'term', label: '期限结构 V1−V3', series: ['v1v3'] }`。
- `useAssetData` 在 underlying 为 .VIX 时拉 `/api/term-structure/vix`。
- `buildSpecs` 把 spread 画成一条线 + **0 基准线**(priceLine at 0);正负用颜色区分(>0 倒挂偏红 / <0 contango 偏绿)。
- 复用现有折叠/换位/图例/crosshair 机制(pane 走统一 PaneDef 流程)。

## 口径

- `spread = VX1 − VX3`(点差,单位与 VIX 点一致)。
- 正 = 倒挂 / 恐慌结构化;负 = contango;0 = 走平。
- VX1/VX3 是"第 N 近合约连续序列",非常数到期(constant-maturity);对价差信号足够,且与 vixcentral 的合约口径一致。
- **Roll 噪音**:VX1 临到期会向现货收敛而抽动,价差在到期前数日会跳成毛刺。不做常数到期插值(defer),但 pane 图例/标题须标一句"到期前数日有 roll 噪音",免得看图被骗。

## 测试

- `computeNthMonth`:给定多合约 + 多交易日,断言 n=1 选到最近未到期合约、n=3 选到第三近;合约不足 n 的交易日被正确略过。
- 价差现算:给定 VX1/VX3 两序列(含只单边有值的日期),断言 inner join 只保留双边都有的日期、`spread = vx1 - vx3` 正确。

## 不做(YAGNI)

- 不存 VX2、不画完整 VX1…VXn 曲线(只要 V1−V3 价差;VX2 以后想加是 `computeNthMonth(.,2)` 一行的事)。
- 不存 derived 价差序列(读时算)。
- 不泛化期限结构路由到其它标的(只有 VIX 有)。
- 不爬 vixcentral。
