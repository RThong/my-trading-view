# 候选数据源清单 —— 查过能用、还没接

> 配套：已接的源见 `AGENTS.md` 的「取数方式总览」；**查过确认没有的**见 `AGENTS.md` 的
> 「查过、确认没有的」——先读那一节，能省掉重复调研。
> 本文只放**实际访问 / 下载验证过**的候选。未验的线索单独放在文末 §4，别混。
>
> 最近核实：2026-09-25（§2.4 撤出）。

---

## 0. 怎么用这张表

选源时按三个轴看，成本从低到高：

1. **依赖档位** —— 零依赖 / `fflate`(已有) / SheetJS(未加) / `word-extractor`(未加)。
   档位定义见 `AGENTS.md` 的「依赖档位」。**`.xlsx` 和 `.xls` 是两种格式，别混。**
2. **可回填性** —— 能回填全历史 → 读时现拉零存储；滚动窗口 / 当天快照 → 必须 daily job 落库。
3. **频率** —— 日 / 周 / 月 / 季。季频序列放进日频面板要显式标注（见 `rates-decomposition-handoff.md` §3 ④）。

---

## 1. 美国（补现有拆解的缺口）

### ACM 期限溢价（纽约联储）—— ✅ **已接（2026-09-11）**

落点：`fetchers/nyfedAcm.ts`，序列 `tp10Acm`，叠在「长端分解」视角 `tp10Kw` 同一格当对照线。

⚠️ **下面这张表说的是那个 10.1 MB 的 `.xls`，实现走的不是它。** 实际用的是
`newyorkfed.org/medialibrary/media/research/data_indicators/acmPlot_data.csv` ——
**49 KB 纯 CSV、零依赖**，月频（当月最后一个交易日）、只有 10Y，列 `RunDates,TERMYld,ACMFITYld,GSWYld`。
它是该页交互图表的取数源，已逐字对账确认内容等同 xls 的 `ACM Monthly` 表（15 位有效数字相同）。
于是 xls 那条路的三个结论都作废了：**不要 SheetJS、不必落库、也不是「面板只有 KW 一家」**。
`.xls` 只在需要**日频**或 **1–9Y 其它期限**时才有必要回去啃。

| | |
|---|---|
| URL | `https://www.newyorkfed.org/medialibrary/media/research/data_indicators/ACMTermPremium.xls` |
| 格式 | **BIFF8 `.xls`（OLE），10.1 MB** → 要 SheetJS |
| 频率 | 日频 ⚠️ 「**每周更新**」是错的（来自未核实的搜索摘要）——实核为**月度更新**，见 `rates-decomposition-handoff.md` §9.2 |
| 回填 | ✅ 一个文件 1961→今 |
| 已验 | sheets `['ACM Monthly', 'ACM Daily']`；`ACM Daily` **16,273 行 × 31 列** |

列布局（已实测）：

```
DATE  ACMY01..ACMY10 (fitted yields)  ACMTP01..ACMTP10 (期限溢价)  ACMRNY01..ACMRNY10 (预期短端)
2026-09-04:  ACMTP10 = 0.6800   ACMRNY10 = 4.1226
对照同日 Kim-Wright:  TP10 = 0.8892   预期短端 = 3.9488     → 两模型差 21bp / 17bp
```

**补的空白（已兑现）**：`rates-decomposition-handoff.md` §3 口径纪律 ② 要求「两个期限溢价模型并排，
分歧带宽本身就是置信度」。两条现已并排，实测带宽平均 57 bp / 中位 47 / P90 124 / 最大 222（440 个月）。

⚠️ **原先「建议落库」那条理由（10.1 MB × 每 6h × 每个冷进程）随 CSV 一起作废** ——
49 KB 读时现拉，按规矩办即可，没有例外。别照旧文再去加 job。

---

### EIA 周报的上游缓冲垫（原油库存 / SPR）

配套：已接的六条 EIA 周度序列见 `AGENTS.md` 取数总览的 EIA 行 + `DATA_SOURCES.md` 的「能源实物面」。
端点、鉴权、三个坑都已验证并落地在 `fetchers/eia.ts`，接这两条**只是加两个 series_id**，没有新的调研成本。

| | |
|---|---|
| series_id | `WCESTUS1`（原油库存，excl. SPR）/ `WCSSTUS1`（SPR 库存） |
| URL | `https://api.eia.gov/v2/seriesid/PET.{ID}.W?api_key=…&length=…` ⚠️ **`length` 别写死** —— 由 `fetchers/eia.ts` 的 `weeksToFetch()` 按 `HISTORY_START_DATE` + `SEASONAL_BASELINE_YEARS` 动态算;写死的常数会随时间悄悄盖不住基准期,而失效是无声的 |
| 格式 | JSON，零依赖 |
| 频率 | 周（周三 10:30 ET 发，数据截止上周五，滞后约 5 天） |
| 回填 | ✅ 一次 GET 给 1982→今全历史；已发布值下周会修订 → **不落库**，live 拉 |
| 单位 | 千桶 |
| 为什么可能要 | 现有六条只覆盖成品油与炼厂；这两条是**上游缓冲垫**——原油端还剩多少余量。柴油紧张时能分清「原料也不够」还是「只是炼不出馏分油」 |

⚠️ 接之前先想清楚**发什么形式**：按「能源实物面」既定口径，库存的裸水位不携带信息，要发季节 z；
但 SPR 是**政策性释放/回补**驱动的，不是季节性的，对它算季节 z 属于口径误用。SPR 更可能该发水位或同比。

---

## 2. 日本（现在整块是空的）

日本侧目前只接了 MOF JGB 名义曲线 + JPX JGB VIX。下面按性价比排。

### ⭐ 2.1 MOF 対外及び対内証券売買契約等の状況（周频跨境证券流）

| | |
|---|---|
| URL | `https://www.mof.go.jp/policy/international_policy/reference/itn_transactions_in_securities/week.csv` |
| 格式 | **干净 CSV，Shift-JIS，255 KB，零依赖** |
| 频率 | **周频**（次周公布） |
| 回填 | ✅ 单文件含长历史 |
| 已验 | 2026-09-10 拉到，标注「最終更新日 令和8年9月10日」，最新周 `2026.8.30〜9.5` |

结构（单位 **億円**，每组三列 `取得 / 処分 / ネット`）：

```
1. 対外証券投資【居住者による取得・処分】   株式・投資ファンド持分 · 中長期債 · 短期債 · 合計
2. 対内証券投資【非居住者による取得・処分】 同上
```

**补的空白**：日元 carry 的**资金流上游**。现有 `cftcJpy` 是海外投机头寸，
而「日本机构买外债」这个最大的结构性流完全没有。生保 / GPIF 的行为都会先反映在这条上，
比直接抓生保季度组合高频得多。

同目录还有 `montha1.csv` / `montha2.csv` / `monthb1..b4.csv` / `si.csv`（月频细分）。

**这是整份清单里性价比最高的一条：零依赖、周频、补完全空白。**

### 2.2 BOJ 短観 企業の物価見通し（日本的通胀预期代理）

| | |
|---|---|
| API | `https://www.stat-search.boj.or.jp/api/v1/getDataCode?format=csv&lang=en&db=CO&startDate=202301&endDate=202602&code=<codes>` |
| 格式 | CSV（Shift-JIS），**零依赖**，免 key |
| 频率 | **季频** |
| 已验 | 三个期限都拉到了实数 |

```
TK99F0000204HCQ00000   物価全般の見通し / １年後 / 企業の物価見通しの平均 / 全規模 / 全産業
TK99F0000205HCQ00000   ３年後
TK99F0000206HCQ00000   ５年後
```

实测（%）：

| | 23Q1 | 24Q1 | 25Q1 | 26Q1 | 26Q2 |
|---|---|---|---|---|---|
| 1年後 | 2.8 | 2.4 | 2.5 | 2.6 | **2.7** |
| 3年後 | 2.3 | 2.2 | 2.4 | 2.5 | **2.6** |
| 5年後 | 2.1 | 2.1 | 2.3 | 2.4 | **2.6** |

**补的空白**：日本 BEI 造不出来（见 `AGENTS.md`「查过、确认没有的」），这是最接近的替代。
当前读数在讲一件事：**5 年後从 2.1 爬到 2.6，且长端涨得比短端快 = 长期通胀锚在上移。**

⚠️ **是调查不是市场定价** —— 无风险溢价、不可套利、季频、滞后。和 `t5yifr` 不同级，
面板上要视觉区分（同 `tp10Kw` 的处理）。

#### BOJ API 的三个坑（都踩过）

1. **季频日期是 `YYYYQQ`，QQ = `01`–`04`**（26Q2 写 `202602`）。写成 `202606` 报 `Invalid frequency (end period)`
2. **默认 gzip 返回** —— curl 要 `--compressed`，否则拿到一坨二进制
3. **CSV 是 Shift-JIS**，`lang=en` 也一样

DB 名对照在官方手册 `https://www.stat-search.boj.or.jp/info/api_manual.pdf` 第 7 页
（`CO`=短観、`FM01`–`FM09`=市场、`IR01`–`IR04`=存贷利率、`MD*`=货币、`PS*`=结算）。
另有 `getDataLayer`（层级）与 `getMetadata`（元信息，可用来搜序列名）两个端点。

### 2.3 BOJ 金融市场操作（国债买入オペ）

| | |
|---|---|
| URL | `https://www.boj.or.jp/statistics/boj/fm/ope/d_release/ope/2026/ope20260909.xlsx` |
| 格式 | `.xlsx` = zip → **`fflate` 就够，不用 SheetJS** |
| 频率 | 日频，**URL 按日期直接构造**，不用爬索引 |

**补的空白**：⚠️ **原立项理由已失效（2026-09）** —— 「日本没有公开的 JGB 期限溢价模型」不成立，中島上智
的模型估计已接入（见 `fetchers/nakajimaJgb.ts`）。这条候选源现在的价值变成**互补而非替代**：模型溢价是
「市场要多少久期补偿」的估计值，买入オペ的额度与期限分布是**供需侧的直接观测**，两者对不上时才有信息量。
优先级相应下调。

### 2.4 ~~JSCC 日元 IRS 结算利率~~ —— ❌ 已撤出（2026-09-25）

原描述是错的：`irs_toukei_nitiji_{YYYYMMDD}.xlsx` 是**清算统计**（债务负担件数 / 金额，按 0-2Y / 2-5Y /
5-10Y / 10-30Y / 30+Y 分组），**没有利率，不是 OIS 曲线**；且只挂当天一份。已挪到 `AGENTS.md`
「查过、确认没有的」。

### 2.5 JSDA 公社債店頭売買参考統計値

| | |
|---|---|
| URL | `https://market.jsda.or.jp/shijyo/saiken/baibai/baisanchi/files/2026/S260909.csv` |
| 格式 | CSV（Shift-JIS），2.16 MB，**零依赖** |
| 频率 | 日频，**URL 按日期构造**（`S` + `YYMMDD`），2002 年起按年归档 |
| 已验 | 12,437 行/天 |

**补的空白**：日本信用利差。美国侧有 HY OAS / 评级利差 / 期限结构三格，日本侧零。
普通事業債 / 社債有明确收益率列，**不涉及物価連動国債那个选券难题**。

⚠️ 里面的物価連動国債只有 10 只，且**是价格不是收益率**——想做日本 BEI 仍然要自己定价，见
`AGENTS.md`「查过、确认没有的」。

### 2.6 内閣府 景気動向指数

| | |
|---|---|
| URL | `https://www.esri.cao.go.jp/jp/stat/di/di.html`（页面上 7 个 `.xlsx`） |
| 格式 | `.xlsx` → `fflate` |
| 频率 | 月频 |

CI / DI 的**先行指数**，日本景气拐点的标准判据。

### 2.7 投資信託協会 统计

| | |
|---|---|
| URL | `https://www.toushin.or.jp/statistics/statistics/data/`（页面上 **112 个 `.xlsx`**） |
| 格式 | `.xlsx` → `fflate` |
| 频率 | 月频 |

投信资金流出入。日本散户风险偏好的一个侧面。

---

## 3. 日本源的三个梯队（选型速查）

| 梯队 | 特征 | 谁 |
|---|---|---|
| **一** | 免 key、干净 CSV/JSON、URL 可构造、**零依赖** | **MOF 跨境流** · **BOJ API** · JSDA |
| **二** | `.xlsx`，`fflate` 够，**不用加依赖** | BOJ オペ · 内閣府 · 投信協会 |
| **三** | 要爬索引 / BIFF8 / OLE / 反爬 | JPX 投資部門別 · METI(403) · 日本相互証券 |

**优先接第一梯队** —— 零依赖意味着不用做「值不值得加一个包」这个决策。

---

## 4. 未验的线索（只是线索，别当结论）

以下**只确认了页面存在**，没有验证数据格式 / 频率 / 可下载性。写在这里是为了不重复搜索，
**不代表可用**：

| 机构 | 想要的 | 已知障碍 |
|---|---|---|
| e-Stat（政府统计总窗口） | CPI · 労働力調査 · 鉱工業生産 的统一入口，有 API | **要免费 appId** |
| 総務省統計局 | CPI 原始 | 页面无直连文件，实际走 e-Stat |
| METI | 鉱工業生産指数 IIP · 商業動態 | **403 挡爬虫**，要处理 UA |
| GPIF | 季度组合（全球最大养老金） | 索引页无直连文件，下载在子页 |
| 生命保険協会 | 生保资产构成（外债最大买家之一） | 索引页无直连文件 |
| 全国銀行協会 | 银行统计 | 完全未验 |
| JPX 投資部門別売買状況 | 周频、按投资部门分的日股买卖 | **哈希目录 URL**（`t13vrt000001rg1m-att`）构造不出来，要爬索引；且是 BIFF8 `.xls` |
| 日本相互証券 BB/JBTS | JGB **業者間実勢**レート，2Y–40Y 日频終値 | **只有 HTML 表格，无 CSV/Excel**。且我们已有 MOF 那条，增量不大 |

---

## 5. 什么时候该抽公共代码

现在**不要**建「通用数据源注册表」。仓库里该有的注册表已经有了，且都是加一行的形态：

```
BUILDERS            (routes/yieldCurve.ts)   加一条曲线源 = 加一行
JOB_WRITTEN_SERIES  (routes/regime.ts)       库里序列 → 对外名
REGIME_DIMS         (web/panels/regime/…)    面板维度
MARKET_CATALOG      (shared/marketCatalog)   标的目录
```

再抽一层通用抽象会是**一个接口配十个互不兼容的实现** —— CSV / xlsx / BIFF8 / OLE Word /
JSON REST / 本地 WebSocket，鉴权、编码、分页、增量语义全不同，公共部分只剩「有个 URL」。

**唯一值得抽的**：等 SheetJS 真的进来、且有 **2 个以上**使用者之后，
把「下载 → 解 zip/OLE → 按表头名取列」抽成 `fetchers/xlsx.ts`。**两个用户才抽，现在零个。**
