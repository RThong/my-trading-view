# 候选数据源清单 —— 查过能用、还没接

> 配套：已接的源见 `AGENTS.md` 的「取数方式总览」；**查过确认没有的**见 `AGENTS.md` 的
> 「查过、确认没有的」——先读那一节，能省掉重复调研。
> 本文只放**实际访问 / 下载验证过**的候选。未验的线索单独放在文末 §4，别混。
>
> 最近核实：2026-11-13（OpenBB 系统性对照：开头速查表、§1 新增多条、§2 JGB VIX 补洞、§4 线索结案、§4.5 否定结论、§4.6 新坑）。

---

## 速查：OpenBB 系统性对照（2026-11-13）

对照对象：OpenBB（`github.com/openbq-org/OpenBB`，组织由 OpenBB-finance 改名而来，旧地址 301 过去），
`openbb_platform/providers` 下 16 个 provider 的 models + utils 逐个读过，地区联储 138 个文件逐个过；
EIA 那约 250 个模型是 API v2 的机械镜像，按「任意 v2 序列」处理。下表每条都**实际下载 / 调 API 验过**，
细节见各节；看过但不做的见 §4.5，新发现的坑见 §4.6。

> **2026-11-14 收尾**：值得接的已接完（CDX、ZCIS、PortWatch、MOF 资金流、短観预期、SMH / VXSMH 等）；CMDI、EIA 原油 / SPR、JSDA 日本信用利差评估后不做（理由见各条）。其余低优先候选要么与已有重合、要么面板没有对应视角，**别再主动提议扩数据源**，等用户提出具体需求再查。

| # | 内容 | 对应视角 | 依赖 | 回填 | 工作量 | 建议 | 详见 |
|---|---|---|---|---|---|---|---|
| 1 | CDS 指数（CDX IG/HY、iTraxx Main/Crossover）：ICE 结算价每天存 + DTCC 补约 2.2 年 | 信用 | 零 / `fflate` | ICE 只有当天；DTCC 约 2.2 年 | ICE 约 2h；回填约 1 天 | ✅ 已接 CDX 北美 IG / HY（2026-11-14，ICE 逐日存 + DTCC 回填）；欧洲不接（不在任何视角） | §1.2 |
| 2 | 单名 CDS 用 DTCC 回填 ICE 那几家的历史（拼接已核对） | AI 链信用 | `fflate` | 约 2.2 年 | 约半天 | ✅ 已接（2026-11-13） | §1.1 |
| 3 | JGB VIX 用 CBOE `SPJGBV_History.csv` 补 JPX 文件缺的天 | 日本 | 零 | 2008-11 起 | 小 | ✅ 已接（2026-11-14） | §2.0′ |
| 4 | EIA 馏分油 / 汽油表观需求（`WDIUPUS2` / `WGFUPUS2`） | 能源实物面 | 零 | 全历史 | 加两个 id | ✅ 已接（2026-11-14，4 周均同比） | EIA 节 |
| 5 | DTCC 利率文件：美元会议日远期 OIS（拆单次 FOMC 定价）+ 美元零息通胀掉期（补 1Y/2Y 通胀预期） | 利率 / 通胀 | `fflate` | 约 2.0 年，必须落库 | 中到大 | ✅ 只接 ZCIS 1Y / 2Y（2026-11-14）；美元会议日 OIS、日元 OIS 评估后不接 | §1.3 |
| 6 | CBOE 延迟期权链，当 moomoo 的备份 | 期权 | 零 | 只有当天 | 约半天 | ✅ 并行试跑中（2026-11-13 起），约 11-21 切主源 | §1.4 |
| 7 | 旧金山联储期限溢价（独立的第三个模型，日频） | 利率拆解 | `fflate` | 全历史 | 小 | ❌ 评估后不接（2026-11-14：3 个月变化与 ACM 相关 0.92，基本是 ACM 翻版） | §1.5 |
| 8 | IMF PortWatch 霍尔木兹海峡每日过船数 | 能源 | 零 | 2019 起 | 小 | ✅ 已接（2026-11-14，能源「油市结构」首格） | §1.6 |
| 9 | FINRA TRACE 单券收益率：Oracle / CoreWeave 等信用历史追到债券发行日 | AI 链信用 | 零（要先拿 cookie） | 发行日起 | 中 | 记入候选（中） | §1.7 |
| 10 | 其余 15 条低优先（~~VXSMH~~ 已接、政策利率分布、CMDI、SCE、GSCPI…） | 各视角 | — | — | 小 | 记入候选（低） | §1.8 |

~~另有一处现有源要改~~ → ✅ 已改（2026-11-14）：指数 CSV 换到 `cdn-api.cboe.com`；VX 期货 CSV 实测只能用旧域名（`cdn-api` 回 403），不改。见 §4.6。

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

### 1.1 DTCC 单名 CDS 成交 → 回填 ICE 那几家的历史 —— ✅ **已接（2026-11-13）**

落点：`fetchers/dtccCds.ts`（解析）+ `analytics/cdsTrades.ts`（定价）+ `jobs/dtccCdsSnapshot.ts --backfill`，读时在 `routes/yieldCurve.ts` 接到 ICE 前面，见 `AGENTS.md` 取数总览 DTCC 行。下面是接入前的调研与核对记录。

**为什么量大**：多德-弗兰克法案要求有美国人一方的掉期都要上报并公开披露，单名 CDS 归 SEC（Reg SBSR，2021 起）。
所以美国大公司的 CDS 成交基本全在里面，不是抽样。

**补的空白**：ICE 结算价只有当天快照、历史只能从开始抓那天往后攒；DTCC 往回约 2 年（2026-11 实测最早 2024-09-10）。
→ 用来**补 ICE 开始攒数之前的历史**，顺带补 ICE 漏抓的个别日子。**不替换 ICE**：结算价每天都有、口径统一，当主数据更好。

成交密度（2026-09-29 ~ 11-12 共 45 个文件、37 个有成交的工作日；只数 USD 计价、`UPI FISN` 含 `CDS Corp`、on-the-run 5Y 到期的 `NEWT`）：

| 名字 | 笔数 | 有成交天数 |
|---|---|---|
| Oracle | 326 | 35 |
| Nvidia | 339 | 31 |
| Broadcom | 295 | 31 |
| Meta | 188 | 31 |
| Amazon | 186 | 30 |
| SpaceX | 207 | 29 |
| Alphabet | 144 | 29 |
| CoreWeave | 102 | 28 |
| Microsoft | 88 | 27 |
| Intel | 80 | 26 |
| Dell | 62 | 19 |
| Apple | 11 | 8（太稀，单独看待） |

名字是按 `UPI Underlier Name` / `Underlying Asset Name` 正则粗匹配数的，接的时候要按 RED 码 / ISIN 精确认（软银那条踩过：标识有四种写法，按名字会混进同名的别家公司）。

#### 拼接核对结果（2026-11-13，家里那台的库，重叠期 2026-07-24 ~ 11-12）

方法：DTCC 当天各笔成交折成价取中位数，和同日 ICE 结算价都用 `cdsPriceToSpreadBp`（`USD_CDS`）换成 bp 再比。
付款方向用**前一天的 ICE 价**当锚来选（不用当天，免得拿答案对答案）。核对脚本是一次性的，没进仓库。

扣掉应计票息之后（见下面坑 1），**差的中位数是 0.0bp**：

| 公司 | 重叠天数 | 每天差多少（中位） | 90% 的天数差在多少以内 |
|---|---|---|---|
| Nvidia / Meta / Broadcom / Alphabet | 71~76 | 0.7~1.0bp | ≤ 3bp |
| Oracle / Amazon / Microsoft | 66~74 | 0.7~0.8bp | 7~8bp |
| SpaceX | 16 | 2.4bp | 6bp |
| Dell / Intel | 42 / 51 | 1.2~1.6bp | 9 / 24bp（成交稀） |
| CoreWeave | 18 | 10bp（约 1%，水平在 1100bp） | 44bp |
| Apple | 6 | — | 太稀，**不回填** |

**结论：可以拼，只补 ICE 开始存数（2026-07-24）之前的日子，ICE 仍是主数据。** 不拿 DTCC 换掉 ICE 的理由：
没成交的日子是空的（重叠 80 天里 Dell 只有 42 天）、成交分散在白天而 ICE 是收盘价（行情剧烈的日子偏差最大）、
付款方向要靠锚来猜（没有 ICE 当锚就只能用自己前一天，选错会一路错下去）、规则多容易悄悄算错、文件次日才出全。

⚠️ 接的时候要处理的：

1. **成交里的前端费含应计票息，必须扣掉**。不扣时 DTCC 比 ICE 系统性低约 3bp（投资级公司低 3~6%），偏差随距上个付息日的天数线性变大：

   | 应计票息（点） | 0.00 | 0.05 | 0.10 | 0.15 | 0.20+ |
   |---|---|---|---|---|---|
   | 修正前价差（DTCC − ICE，点） | 0.073 | 0.074 | 0.120 | 0.172 | 0.230 |
   | 修正后 | 0.043 | 0.007 | −0.005 | −0.002 | −0.001 |

   公式：u = 前端费 ÷ 名义本金（%），应计 = 票息 × 距上个付息日（3/20、6/20、9/20、12/20）天数 ÷ 360；
   买方付时价 = 100 − u − 应计，卖方付时价 = 100 + u − 应计。
   ✅ 软银那条原来也没扣，已一起修（修正后读数平均高 3.1bp，90% 的天在 5.8bp 以内）
2. **换新合约那周成交价分两团**：9/21~9/23 Meta 同一份 2031-12 合约，前端费一团 0.3~0.5%、一团 1.9~2.0%，笔数相当，中位数会偏 30~40bp；9/24 起恢复一团。
   Oracle、Intel 同样。原因没查明。处理：按前一天水平选最近的那一团，或者跳过换合约那周。
   ✅ 实现为按价位断团、取离参照价最近的那团；断团门槛 = 参照利差 × 0.5%（折成点，至少 0.5 点）。固定 0.5 点会把 CoreWeave（~1100bp，日内正常波动好几个点）切碎、读数被拖向前一天，所以门槛随利差放大。
   用上后重叠期：Oracle 90% 分位 8.2 → 5.4bp、Amazon 7.2 → 4.1、Meta 2.8 → 2.2、CoreWeave 日均差 10.1 → 8.7bp；Intel 在单笔成交的日子固定偏约 −24bp，与断团无关，原因没查
   软银代码里「同日同合约两笔差 4 倍」的少报单（`dropLowPrints`）可能是同一回事，接的时候顺便核对
3. **公司识别**：公司名常常是债券描述（`NT`、`SR NT`），要用名字正则 + RED 码前 6 位 / ISIN 前 8 位（发行人前缀）一起认；
   一批行的标识只写通用的 `XSSNRREFOBL0`，只能靠名字认。实测前缀：

   ```
   Oracle 6EC42L US68389X   Microsoft US594918 5EDDA9   Alphabet US02079K 0C27GT   Amazon 0C5448 US023135
   Apple 03AFCJ US037833    Nvidia 6D76CM US67066G      Broadcom 1C248K US11135F   Intel US458140 49D954
   Meta UZEAAG US30303M     CoreWeave 239FAV US21873S   SpaceX 8CA76V US84615Q USU8531H   Dell 26B72T US247025
   ```

   正则别写太宽：`INTEL` 会撞上 Intelsat，用 `INTEL CORP`；Dell 用 `DELL INC`
4. 只收 `UPI FISN` 为 `NA/CDS Corp SN` 或 `NA/CDS Corp SN Sr` 的（排除 Sub / Jr / Basket / Sov）
5. **票息按名单配**：CoreWeave 只挂 500bp，其余 100bp（`AI_CDS[].coupon`）；`Fixed rate-Leg 1` 是小数（`0.01` / `0.05`）。
   都是美元计价，没有软银那种日元偏差，换算直接用 `USD_CDS` 参数
6. 软银那条的另外几个坑同样适用：只收 `Event type = TRAD`（排除更替 NOVA / 压缩 COMP）、跨文件剔掉被撤销（EROR）的成交、2025-11 前表头不带引号、文件里混着几年前的补报单（只收披露前 7 天内成交的）
7. 保留期：SEC 信用文件最早约 2024-09-02，中间有零星缺天（2024-10-01 回 403）；判断文件在不在**要用 GET**，见 §4.6

**接入后又发现两件事（2026-11-13，浏览器看图发现 2024~2025 年的线像乱画）**：

- **指数成交拆出来的成分腿**：一笔 CDX 指数成交被报成约 125 条「单名」，同一秒、同本金、同前端费（实测 2025-11-18 15:54 一批各 200 万 / 41938 美元），带的是**指数的价**。
  2026 年成交多、真实单压得住，所以重叠期核对没暴露；2024~2025 年每家每天一两笔，混进来就拉偏。按「同一组横跨 ≥3 家发行人」整批剔掉后，重叠期 90% 分位：
  Intel 24.3 → 7.3bp、Dell 9.1 → 3.5、Microsoft 7.0 → 2.0、Amazon 4.1 → 2.0、Alphabet 2.5 → 1.9（Intel 单笔日固定偏 −24bp 原来就是它）
- **稀疏期不可信**：2025 全年有成交的天数 Microsoft 19、Meta 13、Alphabet 7、Nvidia 3。几个月一个点、多是单笔，又没有独立来源能核对水平。
  → 只补「之后每个整月 ≥8 天有成交」的那段（`analytics/cdsTrades` 的 `denseFrom`）。结果起点：Oracle 2025-08、CoreWeave 2025-11、Amazon / Alphabet / Meta 2026-02、
  Broadcom 2026-05、Microsoft / Dell / Intel 2026-06、Nvidia / SpaceX 2026-07
- 剔掉成分腿后，名义本金被截断（`5,000,000+`）的大单和普通单的 u 比值各月中位数都在 1.0 上下 → 截断本身不是系统性问题（2025-04 关税那周有几笔比值 0.3~3.2，样本太少分不清）

**公司更多（次要）**：2026-11-12 一个文件里有 787 笔单名新成交、229 种标的写法，名单外还有 AT&T、UPS、Prudential、Petrobras、一批欧洲公司；
很多写法是债券描述，实际公司数要按 RED / ISIN 归并后才知道。

---

### ✅ 1.2 CDS 指数：ICE 结算价 + DTCC CFTC 信用文件（2026-11-13 实测，2026-11-14 已接 CDX 北美 IG / HY，见 AGENTS.md ICE / DTCC 行）

OpenBB 的 `cftc/models/cds_index_trades.py` 读的是 DTCC 的 **CFTC 信用文件**（指数归 CFTC 管，单名归 SEC，所以和软银那条是同一家的两份文件）。
顺着查到 ICE 也有指数结算价端点，和单名那个是同门。

| | ICE（主） | DTCC（补历史） |
|---|---|---|
| 端点 | `www.ice.com/api/cds-settlement-prices/icc-indexes`（免 key，JSON，208 条） | `kgc0418-tdw-data-0.s3.amazonaws.com/cftc/eod/CFTC_CUMULATIVE_CREDITS_YYYY_MM_DD.zip` |
| 内容 | 清算所结算价，`instrumentName` 如 `CDX-NAIGS47V1-5Y`、`eodPrice` | 成交明细，约 100KB / 天 |
| 回填 | ❌ **只有当天**，从开始存那天往后攒 | 约 2.2 年（2024-09-03 能下、2024-08-01 回 403） |
| 覆盖 | CDX NA IG / HY / EM / EMIG / EMHY / FIN，iTraxx Europe / Crossover / FinSen / FinSub / AsiaXJ / Australia | 同上 + iTraxx Japan、CMBX、iBoxx 杠杆贷款等 15 个系列 |

2026-11-12 两边对得上：

| 指数 | ICE 结算价 | DTCC 成交（当天笔数） |
|---|---|---|
| CDX NA IG S47 5Y | 101.86（约 60bp） | 58.7bp（453 笔） |
| CDX NA HY S47 5Y | 106.19 | 价 106.195（519 笔） |
| iTraxx Europe S46 5Y | 101.92 | 59.3bp（332 笔） |
| iTraxx Crossover S46 5Y | 108.95 | 291bp（295 笔） |

**补的空白**：信用 tab 只有现货债券的 ICE BofA 利差（FRED 只留滚动 3 年，见 `AGENTS.md`）。CDX 是场内交易的信用指标，可以和现货利差对照，且不受 FRED 截断影响。

⚠️ 接的时候要处理的：

1. **ICE 只有当天 → 越早开始存越好**，晚一天少一天（DTCC 只能补回约 2.2 年）
2. **票息按指数配**：IG / Main / EM 是 100bp，HY / Crossover 是 500bp
3. **回收率**：CDX HY 报价惯例有说 30% 的，查证未果（多数资料写 40%）；实现统一按 40%，2026-11 实测两者换算只差约 3bp（345.6 对 348.3bp）
4. **DTCC 里 HY 的价格有两种写法**：同一份合约 `Spread notation-Leg 1 = 1` 写 106.195，`= 3` 写 0.0106（正好是价格 ÷ 10000），两种都要认；IG 这类的 `= 3` 是小数利差（0.00585 = 58.5bp）
5. **系列 / 版本号会变**：IG 每年 3/20、9/20 换新系列（S47 → S48），**HY 晚一周（3/27、9/27）**，成分公司违约时版本号变（V1 → V2）。按最高系列取，别写死名字
6. **iTraxx Japan 暂时不能用**：一天只有 7 笔左右，只给前端费不带付款方向（100bp 票息下，前端费 1.57% 可能是 133bp 也可能是 67bp），ICE 也不清算它

---

### 1.3 DTCC 利率文件里的美元产品：会议日远期 OIS + 零息通胀掉期（2026-11-13 实测）

> **2026-11-14 结论**：✅ **只接零息通胀掉期 1Y / 2Y**（`fetchers/dtccZcis` + daily `dtcc_zcis`，见 `AGENTS.md`）。
> ❌ **会议日远期 OIS 不接**：Eris 的 SOFR OIS（24 档含短端）已在库，`oisHikes` 就是用它算的，DTCC 只是同一种产品换个源；
> 唯一独有的「逐次会议拆法」2026-07 删 Fed 路径时已判为不值得（见利率线的取舍记录）。
> ZCIS 不用克利夫兰联储 `EXPINF1YR` 等代替：那是月频模型估计（含调查、扣风险溢价），2026-11 读数 3.04% 对掉期 2.11%，不是同一个量。

文件、格式、保留期见 §2.0（同一个 `CFTC_CUMULATIVE_RATES_YYYY_MM_DD.zip`）。下面是 2026-11-13 的实测原始记录；接入范围以本节开头的结论为准（只接 ZCIS）。
⚠️ 利率文件保留期是**约 2.0 年**（最早 2024-11-10），比信用文件短。

**美元会议日远期 OIS** —— 拆出每次 FOMC 会议的定价。我们的 `oisHikes*`（读 Eris）只给累计加息次数，代码注释写明「不拆单次会议」。

- 筛选：`UPI FISN = NA/Swap OIS USD`，`Action type = NEWT`，起息日比成交日晚 7 天以上，期限 20~60 天；按起息日 / 到期日聚成会议窗口取中位数
- 11-10 实测：12-09 到 01-27 窗口 240 笔，中位数 4.144%，比 SOFR 3.89 高 25bp；亚特兰大联储 MPT 同日给 12 月加息概率 97.4%，吻合。按会议段加权回算 3M 是 4.09，Eris 3M 是 4.13，差约 4bp
- 日元同理：12-21 到 01-22 窗口 19 笔，1.417%
- ⚠️ 混着一批 21 天期的 IMM 式小段（如 03-18 到 04-08），要按 FOMC 日期对齐过滤
- ⚠️ FOMC 日期源 `federalreserve.gov/json/calendar.json` 带 UTF-8 BOM，只列到 2026-12-09；2027 年的要另抓 `fomccalendars.htm` 或从成交聚类里推

**美元零息通胀掉期（ZCIS）** —— 补 BEI 没有的 1Y / 2Y 短端（TIPS 短端不流动，我们的 `bei` 从 5Y 起）。

- 筛选：`UPI FISN = NA/Swap Infl Idx USD`，`UPI Underlier Name = USA-CPI-U`，`Event type = TRAD`
- ⚠️ **只收现货起息的**（起息日 − 成交日在 0~6 天、期限整年）。成交里混着几个月前起息的「老化」合约（如 2026-01-01 起息、3.5%），11-12 的 1Y 直接取中位数是 2.658%，只收现货起息的是 2.113%
- 实测（%）：

  | | 1Y | 2Y | 5Y | 10Y | 30Y |
  |---|---|---|---|---|---|
  | 11-10 | 2.073（43 笔） | 2.228 | 2.329 | 2.345 | 2.300 |
  | 11-12 | 2.113 | 2.261 | 2.376 | 2.382 | 2.324 |
  | 11-12 的 BEI | — | — | 2.31 | 2.24 | 2.19 |

  掉期比 BEI 高约 7~15bp 是正常基差（11-12：5Y +6.6、10Y +14.2、30Y +13.4）。
- 两天的文件里通胀掉期只有 USD / EUR / GBP / CLP，**没有日元** → 「日元 ZCIS 无免费源」的否定结论更稳了

---

### 1.4 CBOE 延迟期权链 → moomoo 的备份（2026-11-13 实测）

> **2026-11-14 进展**：并行试跑中（daily `options_cboe`，见 `AGENTS.md` moomoo 段），约 5 个交易日对照后切成主源、去掉 OpenD。
> 同日逐合约核对后发现下表里的差异**是 moomoo 的问题，不是 CBOE 的**：
> - **TLT**：两边报价、OI 完全相同，CBOE 计入分红、moomoo 不计 → moomoo 的 skew 系统性高约 2pp。历史已重算（11-13：0.30 对 CBOE 0.38）
> - **VIX**：moomoo 以现货为标的算 IV，且约八成快照抓在夜盘（报价空或极宽），101 天里只有 15 天能修 → 切换时整段删、从 CBOE 重攒
> - 覆盖：所有美国上市期权都有（个股 / ETF / 指数 SPX·NDX·RUT / ADR），非美国上市没有；纳指用 QQQ（NDX 周度期权 OI 太薄），标普 SPY 与 SPX 25Δ skew 只差 0.2~0.4pp，不换
> - 本源期权（CME 的 CL / GC / ZN 期货期权）免费拿不到（CME 站点脚本 403、CVOL 付费），且 VRP 的隐含腿 OVX / GVZ / VXTLT 本身是 ETF 口径，继续用 ETF

| | |
|---|---|
| URL | `https://cdn-api.cboe.com/api/global/delayed_quotes/options/{SPY,QQQ,GLD,USO,TLT,IBIT,_VIX}.json`（指数前面加 `_`；旧域名 `cdn.cboe.com` 307 过来） |
| 格式 | JSON，零依赖，免 key；SPY 约 6MB、`_VIX` 约 0.7MB |
| 内容 | 每个合约带 `iv`（小数）、`delta`、`gamma`、`vega`、`theta`、`rho`、`open_interest`、`volume`、bid/ask；**一次请求给全部到期日**（SPY 34 个）；顶层另有 `iv30` |
| 时点 | 文件 `timestamp` 是 UTC，持续刷新；11-13 11:00 UTC 拉到的是 11-12 收盘的值 |
| 回填 | ❌ 只有当天快照，和 moomoo 一样 |

和库里 moomoo 2026-11-12 的链逐合约对比（同一到期日、OI ≥ 100 的合约）：

| 标的 | IV 差中位数 | 25Δ call / put IV（CBOE vs moomoo） |
|---|---|---|
| SPY | −0.17pp | 12.25 / 17.89 vs 12.49 / 17.85 |
| GLD | −0.26pp | 23.59 / 25.28 vs 23.90 / 25.48 |
| TLT | −0.72pp | 行权价间距大，25Δ 选到了不同档 |
| .VIX | −4.5pp | 121.7 / 66.3 vs 127.9 / 57.3 ⚠️ 差得大 |

OI 基本一致（TLT 83.5 那档两边都是 10180）。

**价值**：不用 OpenD，没有 moomoo 的 30 天窗口和限频闸门。OpenD 相关的运维坑（启动即崩、行情会话悬空、本体丢失）全部绕开；
若将来完全替换，`moomoo-api` 连同 protobufjs 的 audit 漏洞也能去掉。

⚠️ 坑：.VIX 的 IV 口径和 moomoo 不同（直接换源会在换源那天出台阶）；文件带已到期的合约要过滤；约一成合约没有 IV。
~~建议先当备份并行跑两周~~ → 按本节开头的进展：并行约 5 个交易日对照后切换。

---

### ❌ 1.5 旧金山联储期限溢价 —— 评估后不接（2026-11-14）

> **结论：走势基本是 ACM 的翻版，不接。** 下面「和 KW 对比」那段只比了 KW，补上 ACM 后「独立第三条」不成立。
> 2000-01 ~ 2026-10 共 322 个月，三条都取月末值（ACM 月频）：
>
> | | 水平相关 | 3 个月变化相关 | 均差 | \|差\| 中位 |
> |---|---|---|---|---|
> | 旧金山 vs KW | 0.79 | 0.65 | +0.26pp | 0.47pp |
> | **旧金山 vs ACM** | 0.81 | **0.92** | +0.08pp | 0.51pp |
> | KW vs ACM（现有两条） | 0.81 | 0.74 | −0.18pp | 0.55pp |
>
> - 当裁判也不行：KW / ACM 3 个月方向相反（各 >10bp）的 12 个月里，它 9 个月站 ACM —— 不是中立第三方。
> - 唯一的差别是水平（2026-07~10 在 1.28~1.44%，比另两条高 0.4~0.6pp），而期限溢价的绝对水平本来就随模型而变，多一个数不增加信息。
> - 日频、比 KW 新几天也不算优势：ACM 月频的空档已由 KW（日频）补上。
> - ⚠️ 列名是 `ZCTERM10YR` / `AVGEXP10YR` / `ZCYLD10YR`（下表写的 `ZCTERM` 是简写），日期是 Excel 序列号（1899-12-30 起）。

#### 原始实测记录（2026-11-13）

| | |
|---|---|
| URL | `https://www.frbsf.org/wp-content/uploads/FRBSF_Term_Web_Chart_Data.xlsx` |
| 格式 | `.xlsx`，451KB → `fflate` |
| 表 | `Ten_year_decomposition` / `Two_year_decomposition`（列 `date, ZCYLD, AVGEXP, ZCTERM`，日期是 Excel 序列号）+ `Estimated_Short_Rate_Path` |
| 频率 | 日频，复查时更新到 2026-11-12（KW 同期只到 11-06） |
| 回填 | ✅ 一个文件给全历史 |

和 KW 对比（6705 个共同交易日）：差的均值 0.26pp、中位 0.23、|差| P90 1.05；**20 日变化的相关只有 0.63**；
11-06 那天旧金山 1.28% 对 KW 0.87%。它是 AFNS 体系，和 KW 不同族 —— 不是 DKW 那种和 KW 只差 8.5bp 的「伪第三条」
（见 `rates-decomposition-handoff.md` §9.5）。可以叠在 `tp10Kw` / `tp10Acm` 那一格当第三条对照线。

---

### ✅ 1.6 IMF PortWatch：霍尔木兹海峡每日过船数（2026-11-13 实测，2026-11-14 已接：`hormuzTransits` / `hormuzTankers`，见 `fetchers/portwatch`）

| | |
|---|---|
| URL | `https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services/Daily_Chokepoints_Data/FeatureServer/0/query?where=portname%3D%27Strait%20of%20Hormuz%27&outFields=date,n_tanker,capacity_tanker,n_total&orderByFields=date%20DESC&f=json` |
| 格式 | ArcGIS JSON，零依赖，免 key；~~单次最多 2000 行~~ → **实测单页上限 1000 行**（写 2000 也只回 1000，按 2000 翻页会静默漏掉中间 1000 天），要分页 |
| 历史 | 2019-01-01 起 |
| 时效 | 约滞后 5 天（11-13 拉到 11-08） |

月均过船数（艘 / 天）：2025 年在 56~103 之间；**2026-03 起掉到 3~13，到 11 月还是 4**。

**补的空白**：原油页注释写着「海峡恢复后切回本职」，但面板上没有一条线直接量「海峡恢复了没有」。
同一服务下还有港口日数据、贸易量、扰动事件库（OpenBB `imf/models/` 里有完整的图层名）。

---

### 1.7 FINRA TRACE 单券收益率（2026-11-13 实测）

**补的空白**：ICE 单名 CDS 2026-07 才开始攒，DTCC 只有约 2 年；TRACE 能回到债券发行日（Oracle 2060 年到期那只 2020-03-30 起逐日有数）。
Oracle 2031 年到期那只对 5Y 美债的利差，与 ICE CDS 在 77 天里**水平相关 0.937、日变化相关 0.499**。

- 端点（网站自己用的内部接口，没有正式文档，改版风险和 CNN 恐贪那条同级）：
  1. 先 `GET https://services-dynarep.ddwa.finra.org/public/reporting/v2/data/group/FixedIncomeMarket/name/CorporateAndAgencySecurities`：回 400，但会种下 `XSRF-TOKEN` cookie
  2. 再 POST 同前缀下的 `.../CorporateAndAgencySecurities`（查券）或 `.../endOfDayPriceYield`（每日收盘），带 cookie、`X-XSRF-TOKEN`、`Origin/Referer: finra.org`；不带 token 回 401
- 按发行人搜要用 `multiFieldMatchFilters`；写成 `searchFilters` 会被**静默忽略**，返回 28 万行全量
- 拿历史用 `domainFilters: [{fieldName: 'cusip', values: [...]}]` + `dateRangeFilters`，单页上限 5000 行
- 字段 `tradeDate` / `lastSalePrice` / `lastSaleYield`：是最后一笔成交，不是中间价，有零星小单噪声
- ⚠️ U 开头的 CUSIP（Reg S / 144A）`lastSaleYield` 是 null；CoreWeave 的 1.75% / 2.875% 两只是可转债，收益率不能用（6.9% 对普通高收益券的 13.7~14.7%）
- 每家要挑一只基准券，到期要换券，还要按到期日在美债曲线上插值

---

### 1.8 其余候选（2026-11-13 实测，低优先）

| 内容 | 端点 / 序列 | 实测 | 依赖 | 备注 |
|---|---|---|---|---|
| ✅ 半导体 vol 脱钩大盘（2026-11-14 已接：「期权 › SMH」tab，不抓 SMH 期权链——25Δ 两翼价差约 40%）：`VXSMH − VXN` | CBOE `VXSMH_History.csv` | 2025-09-16 起 294 行；差值均值 20.0（11.9~36.8），最新 21.15；日变化相关 0.83 | 零 | 只有约 14 个月，先别算分位；不用 moomoo 就能做（对照记忆里砍 SOXX 的理由） |
| 期权隐含的政策利率分布（二选一，PRS 更便宜） | 亚特兰大联储 MPT `.../-/media/Project/Atlanta/FRBA/Documents/research-and-data/data/market-probability-tracker/mpt_histdata.xlsx`；堪萨斯城联储 PRS `kcresearch-share.kansascityfed.org/kc-prs/KCPRU_KCPRS.csv` | MPT 7.2MB、32 万行长表，2023-03-29~2026-11-10 共 911 天；PRS 209KB，1989 起到 11-11，和 MOVE 水平相关 0.90、日变化 0.55 | `fflate` / 零 | MPT 坑：`date` 是 ISO 字符串、`reference_start` 是 Excel 序列号。PRS 真正的新信息是偏度列 `KCPRS`；构造口径没读原文 |
| ❌ 纽约联储公司债压力指数 CMDI（2026-11-14 评估后不做：说的是 HY 利差同一件事，HY + 13 条梯队已在；周频还滞后约 3 周，它报警时利差格早看到了；周变化相关低主要是频率 / 滞后差，不是新信息）（IG / HY） | `newyorkfed.org/medialibrary/research/interactives/cmdi/downloads/Market%20CMDI.xlsx`，读 `Index Data` 表，表头第 6 行 | 每周五一个点，2005-01-07~2026-10-23 共 1138 点，滞后约 3 周；2018 起和 HY OAS 水平相关 0.848、**周变化相关 0.195** | `fflate` | 信息和 HY 利差不重复，且不受 FRED 3 年截断影响 |
| 旧金山联储核心 PCE 需求 / 供给拆分 | `frbsf.org/wp-content/uploads/supply-demand-pce-inflation.xlsx`，读 `Data` 表 | 1969m1~2026m9；最新需求 1.21、不确定 0.77、供给 1.13 | `fflate` | 最近几行月份标签前面多一个空格（`" 2026m7"`） |
| 纽约联储消费者调查 SCE 1/3/5 年通胀预期 | `frbny-sce-data.xlsx`，读 `Inflation expectations` 表，表头第 4 行 | 2013-06~2026-10（密歇根 MICH 只到 2026-09）；最新 1y 3.91、3y 3.29、5y 3.0 | `fflate`（1.27MB，43 张表） | 5 年期那列起点更晚 |
| 全球供应链压力 GSCPI | `newyorkfed.org/medialibrary/research/interactives/data/gscpi/gscpi_interactive_data.csv` | 338KB，1997-09~2026-10，最新 1.26 | 零 | 每一列是一个发布版本（表头是 Excel 序列号），取最后一列；缺值写 `#N/A`。官方「.xlsx」下载其实是 BIFF8，见 §4.6 |
| 回购尾部压力 / 融资压力 | FRED `SOFR99`；`RIFSPPFAAD90NB − DTB3` | SOFR99 2018 起，2025-09 以来最高 4.68（2025-09-15） | 零 | 各加一行 |
| VIX 期限结构两端 | CBOE `VIX9D`（2011 起）、`VIX1Y`（2007 起） | 都 200，更新到 11-12 | 零 | 各加一行 |
| BTC 永续资金费率 | `deribit.com/api/v2/public/get_funding_rate_history?instrument_name=BTC-PERPETUAL&start_timestamp=&end_timestamp=` | 每小时一点，至少 2019-06 起；单次最多 744 行要翻页 | 零 | Deribit 是小交易所，代表性有限 |
| 一级交易商美债分期限净头寸 | `markets.newyorkfed.org/api/pd/get/{PDPOSGSC-G7L11,G11L21,G21,PDPOSGS-B}.json` | 每周三时点，最新 2026-11-04（滞后 8 天），2013-04 起 | 零 | 11Y 以上两档 2022-01 才有（期限档重新划分过） |
| VX 曲线每日校验探针 | `www.cboe.com/us/futures/market_statistics/settlement/csv?dt=YYYY-MM-DD` | 1.7KB；和库里 `VX:*` 精确到 4 位小数一致；旧日期（2025-06-02）只回表头 | 零 | 周度 VX 的值等于下个月度合约（占位数，别用）；同文件有 IBHY / IBIG 信用期货 |
| 美元/日元隐含波动率 | DTCC CFTC 辖区的外汇期权成交（OpenBB `cftc/models/fx_option_trades.py`、`fx_implied_vol.py`） | 11-12 普通期权 536 笔（11~45 天到期 276 笔）；期权费、行权价、到期日齐全；有的打包成交直接报波动率 | `fflate` | 要自己反推隐含波动率、还要即期价，工作量大；部分未验 |
| 堪萨斯城联储 r\* | `kcresearch-share.kansascityfed.org/kc-mbnr/KCFed_ModelBased_Rstar_Ustar.csv` | 月频，最新 2026-09：1.46%，区间 −0.35~2.54 | 零 | 可当 HLW 对照；区间太宽 |
| 堪萨斯城联储 RORO 风险偏好指数 | `kcresearch-share.kansascityfed.org/kc-roro/roro_daily.csv` | 日频，到 11-11 | 零 | 和我们自己的 regime 面板重叠 |
| 克利夫兰联储 CPI 临近预测 | `clevelandfed.org/-/media/files/webcharts/inflationnowcasting/nowcast_month.json` | 200，7.7MB | 零 | 太胖 |
| 旧金山联储代理联邦基金利率 | `frbsf.org/wp-content/uploads/proxy-funds-rate-data.xlsx` | 周 / 月两张表；最新 5.17%，同期 EFFR 3.88% | `fflate` | 金融条件折算成等效利率 |

---

### ❌ EIA 周报的上游缓冲垫（原油库存 / SPR）—— 评估后不做（2026-11-14）

> 能源页已有价格、裂解、炼厂与成品油库存,油价眼下由霍尔木兹海峡主导(那格已接);原油库存多一条线不改变对油市的判断。SPR 是政策性放储 / 回补,不是市场信号。下面的接入细节保留,真要接时只是加两个 series_id。

配套：已接的八条 EIA 周度实物序列见 `AGENTS.md` 取数总览的 EIA 行 + `DATA_SOURCES.md` 的「能源实物面」。
端点、鉴权、三个坑都已验证并落地在 `fetchers/eia.ts`，接这两条**只是加两个 series_id**，没有新的调研成本。

| | |
|---|---|
| series_id | `WCESTUS1`（原油库存，excl. SPR）/ `WCSSTUS1`（SPR 库存） |
| URL | `https://api.eia.gov/v2/seriesid/PET.{ID}.W?api_key=…&length=…` ⚠️ **`length` 别写死** —— 由 `fetchers/eia.ts` 的 `weeksToFetch()` 按 `HISTORY_START_DATE` + `SEASONAL_BASELINE_YEARS` 动态算;写死的常数会随时间悄悄盖不住基准期,而失效是无声的 |
| 格式 | JSON，零依赖 |
| 频率 | 周（周三 10:30 ET 发，数据截止上周五，滞后约 5 天） |
| 回填 | ✅ 一次 GET 给 1982→今全历史；已发布值下周会修订 → **不落库**，live 拉 |
| 单位 | 千桶 |
| 为什么可能要 | 现有八条只覆盖成品油与炼厂；这两条是**上游缓冲垫**——原油端还剩多少余量。柴油紧张时能分清「原料也不够」还是「只是炼不出馏分油」 |

⚠️ 接之前先想清楚**发什么形式**：按「能源实物面」既定口径，库存的裸水位不携带信息，要发季节 z；
但 SPR 是**政策性释放/回补**驱动的，不是季节性的，对它算季节 z 属于口径误用。SPR 更可能该发水位或同比。

#### ✅ 同一端点再加两条：馏分油 / 汽油表观需求（2026-11-13 实测，2026-11-14 已接：`distDemandYoy` / `gasDemandYoy`，能源 ›「炼厂·库存」）

| | |
|---|---|
| series_id | `WDIUPUS2`（馏分油 product supplied）/ `WGFUPUS2`（汽油 product supplied），千桶/日 |
| 实测 | v2 接口测通；最新 2026-11-06 馏分油 3411，4 周均同比 +4.2%；约 1991 年起 1866 行 |
| 为什么要 | 回答「紧张来自需求还是供应」里需求那一半。接之前的六条全在供应 / 库存侧 |

⚠️ 单周噪声大（周变化中位数：馏分油约 7.7%、汽油约 2.9%，2018 年起），按「能源实物面」口径发 **4 周均同比或季节 z**，别发水位。
线索来自 OpenBB 的 EIA provider（它把 v2 的约 250 个数据集都镜像成了模型）。
⚠️ EIA v2 单次最多返回 5000 行且不报警，见 §4.6；这两条周频只有约 1866 行，不受影响。

---

## 2. 日本（现在整块是空的）

日本侧目前只接了 MOF JGB 名义曲线 + JPX JGB VIX。下面按性价比排。

### ✅ 2.0′ JGB VIX：用 CBOE 镜像补 JPX 文件缺的天（2026-11-13 实测，2026-11-14 已接，见 `fetchers/jpxJgbVix` 的 `mergeJgbVix`）

| | |
|---|---|
| URL | `https://cdn-api.cboe.com/api/global/us_indices/daily_prices/SPJGBV_History.csv`（旧域名 `cdn.cboe.com` 307 过来） |
| 格式 | `DATE,SPJGBV`，日期 MM/DD/YYYY；现成的 `parseCboeIndexCsv` 直接能解，零依赖 |
| 历史 | 2008-11 起，更新到 11-12（和 JPX 同步） |

**补的洞**：我们的 `fetchers/jpxJgbVix.ts` 读的 JPX 文件有整段缺失 —— 2021-10 整月 0 行，2019-03 只有 11 行、2019-04 只有 4 行、
2019-08 只有 6 行、2021-11 只有 12 行。2018 年起 CBOE 多出 87 天，其中 19 天是日本假日沿用前值，**约 68 天是真缺**。
两边重叠 4233 天，差超过 0.005 的只有 5 天。另外 JPX 那条用的是哈希 URL（注释自己写了「改版会变」），CBOE 正好兼作备份。

⚠️ 坑：

1. CBOE 按美国日历：美国假日没有值（2018 起有 17 个日本交易日 CBOE 没有）；日本假日沿用前一天的值（19 天）
2. 所以建议「**JPX 为主，CBOE 只补 JPX 缺的天，并剔掉和前一天相同的值**」；整条换成 CBOE 的代价是丢掉美国假日那些天
3. 2019-11-06 两边差 0.66（CBOE 2.85 对 JPX 2.19），哪边对还没核

### 2.0 DTCC SDR 公开掉期成交 → 日元 OIS 曲线 + 日银政策路径（2026-11-12 实测）

> **2026-11-14 结论：❌ 评估后不接。** 只用**即期起息**成交（起息日在成交日后 0~4 天，下限必须卡，否则混进老化合约）重算，
> 日元 OIS 与 JGB 几乎重合，短端政策预期用现有 `jp2yMinusCall`（JGB 2Y − 拆借利率）即可：
>
> | 日期 | 2025-01-15 | 2025-04-08 | 2025-09-10 | 2026-03-11 | 2026-07-15 | 2026-11-12 |
> |---|---|---|---|---|---|---|
> | JGB 2Y − OIS 2Y（bp） | +2 | +2 | +1 | +1 | −1 | +3 |
> | JGB 10Y − OIS 10Y（bp） | +10 | +28 | +20 | +19 | +13 | +17 |
>
> ⚠️ 别重蹈覆辙：起息日只卡上限时，2026-03-11 的 2Y 混进 170 多笔 2025-09 起息的老合约（0.8~0.9%），中位数被拉到 0.86%，
> 一度误判成「JGB 与 OIS 差 2~38bp」。短端 3M / 6M 每天只有 1~9 笔，单日中位数本就不可靠。
> 美元那边短端常年差 10~20bp（美债 − Eris OIS），是因为美国国库券供给 / 流动性扭曲，日本不存在这层。

线索来自 OpenBB（`openbb_platform/providers/cftc/`，Apache-2.0，名字叫 cftc，实际是 DTCC 的 PPD）。
补的是 `AGENTS.md`「查过、确认没有的」里「日元 OIS 曲线」那一格：JSCC 不发利率这条结论仍成立，
但 **CFTC Part 43 要求掉期成交实时公开披露**，日元 OIS 的成交价就在这里。

| | |
|---|---|
| 清单 | `https://pddata.dtcc.com/ppd/api/cumulative/CFTC/IR`（免 key，JSON 数组，每项带 `fileName` / `rowCount` / `fullFilePath`）|
| 文件 | `https://kgc0418-tdw-data-0.s3.amazonaws.com/cftc/eod/CFTC_CUMULATIVE_RATES_YYYY_MM_DD.zip`，**URL 可按日期构造** |
| 格式 | zip 包一个 CSV，约 18 MB / 3 万行（全币种利率掉期），**零依赖**（zip 用已有 `fflate`）|
| 频率 | 日频，次日 00:15 UTC 发 |
| 回填 | ⚠️ **滚动约 2.0 年**：2026-11-12 当天 `2024_11_11` 能下、`2024_11_08` 回 403（11-13 复查最早 2024-11-10）；清单接口只列最近 365 天（OpenBB 的 `PPD_RETENTION_DAYS=366` 指的就是这个，不是文件保留期），更早的要自己构造 URL。⚠️ **判断文件在不在要用 GET**，HEAD 对过期文件也回 200。→ **必须 daily job 落库**，否则头部每天都在丢 |

筛选与字段（实测）：

- 日元 OIS：`UPI FISN = "NA/Swap OIS JPY"`，`UPI Underlier Name = "JPY-TONA-OIS Compound"`
- 价格只取 `Action type = NEWT`；`MODI` / `CORR` / `TERM` / `EROR` 是生命周期事件
- 利率是**小数**：`Fixed rate-Leg 1 = 0.03215` = 3.215%；名义本金带千分位逗号
- 期限 = `Expiration Date − Effective Date`；起息日比 `Execution Timestamp` 晚超过一周的算远期起息
  ⚠️ **旧规则，已被本节开头的结论推翻**：只卡上限会把起息日早于成交日的老化合约当成即期；下面这张 11-10 的表就是按旧规则算的，别照着用

2026-11-10 单日：日元 OIS 新成交 885 笔，其中 401 笔远期起息。即期起息的主要期限：

| 期限 | 1Y | 2Y | 5Y | 7Y | 10Y | 20Y | 30Y |
|---|---|---|---|---|---|---|---|
| 笔数 | 37 | 28 | 30 | 17 | 54 | 27 | 20 |
| 中位数 | 1.617% | 1.753% | 2.087% | 2.277% | 2.584% | 3.211% | 3.415% |

⚠️ 接之前要处理的：

1. **偏离市价的成交**：同日 8Y −0.05%、13Y 0.575%、23Y 0.35%，和相邻期限差了 200bp 以上，要按离群值剔掉，别直接取均值
2. **短端（1 年以内）单日只有一两笔**，要合并多天，或者改用远期起息的那批推政策路径（OpenBB 的 `ois_policy_path` 就是这么做的：会议日起息的远期 OIS，合并最近几天）
3. 只覆盖**向美国 SDR 报告的成交**（有美国人一方），不是全市场。量够用，但个别期限某天可能为空
4. 2026-11-11（美国退伍军人节）全币种只有 1.2 万行，美国假日数据会变稀

> ✅ SEC 辖区那份(单名 CDS)**已接软银 5Y**(2026-11-13,见 `AGENTS.md` 取数总览 DTCC 行);本节的日元 OIS **评估后不接**（见本节开头）。

同一份数据里还有（2026-11-13 已实测，见 §1）：USD 会议日远期 OIS 与零息通胀掉期（§1.3）、
CDS 指数成交（另一个文件 `CFTC_CUMULATIVE_CREDITS_*`，§1.2）、FX 期权成交（§1.8，只核了字段和笔数）。
**日元通胀掉期在这份数据里是 0 笔。**

### ✅ 2.1 MOF 対外及び対内証券売買契約等の状況（周频跨境证券流）—— 已接（2026-11-14：`jpFlowOut{Bonds,Equity}` / `jpFlowIn{Equity,Bonds}`，52 周累计兆円（起初发 4 周累计，在 0 上下乱翻看不出东西，同日改），「日本 › 资金流」tab，见 `fetchers/mofSecurities`）

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

### ✅ 2.2 BOJ 短観 企業の物価見通し（日本的通胀预期代理）—— 已接（2026-11-14：`jpInflExp1y` / `jpInflExp5y`，「日本 › 通胀」第二格；与 CGPI 同比水平相关 0.56、季变化 0.36，不重合）

> ✅ **已接(2026-11-14)**:`fetchBojSeries('CO', TANKAN_INFL_EXP, '201801', { quarterly: true })`,季频期间 `YYYYQQ` 落季末(下方坑 1 已在 `fetchers/bojStat` 处理)。
> 只取 1 年后 / 5 年后两条(3 年后与 5 年后水平相关 0.99)。下面是接入前的实测记录,保留作口径参考。

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

### ❌ 2.5 JSDA 公社債店頭売買参考統計値 —— 评估后不做（2026-11-14）

> 日本公司债利差常年极窄、几乎不动(日银长期买公司债压住了波动),画出来近乎一条平线;还要每天从约 1.2 万行里挑券、分评级、减 JGB 才算得出利差,工作量与信息量不成比例。

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

### ❌ 2.8 JPX 信用取引現在高（日本版融资余额）—— 评估后不做（2026-11-14）

> 用户选不做：日本信用余额主要反映散户在日股上的杠杆，和面板看美股状态的主线关系不大。美股版（FINRA 保证金债务）已接，见「信用 › 杠杆」。

实测（`www.jpx.co.jp/markets/statistics-equities/margin/`，要浏览器 UA）：
- **周度 `.xlsx` 只留约 5 周**：`04.html` 列的 `tvdivq0000001rk9-att/{YYYYMMDD}_mtcurrent.xlsx` 能按日期构造，但 2026-01 起更早的全 404
- 「過去推移表」(`05.html`) 的 `.xlsx`（`tvdivq0000015969.xlsx`）也只有最近 6 周；Q 列 = 合计买残金额（百万円），2026-10-30 约 6.5 兆円
- 长历史只在同页两个 **BIFF8 `.xls`**（`{YYYYMMDD}_mtgk.xls` 171KB / `_mtsk.xls` 240KB，Code page 932）→ 要 SheetJS（见 `AGENTS.md` 依赖档位，npm 版有 CVE、走官方 CDN），**没解开验过历史从哪年起**
- 真要接：要么加 SheetJS 读 `.xls` 拿全历史，要么只拿周度 `.xlsx` 从今往后落库攒

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

2026-11-12 记下的四条 OpenBB 线索，**2026-11-13 已全部验过结案**：

| 机构 | 想要的 | 结论 |
|---|---|---|
| NY Fed | 一级交易商持仓 | ✅ 可用，记入 §1.8（低优先） |
| 费城联储 | SPF 专业预测者通胀预期 | 是 `.xlsx` 不是 `.xls`（11.7KB），季频，最新 2026Q3 → 不做（§4.5） |
| FINRA | 个股做空余额 | `api.finra.org` 免 key 可用，半月频，按个股 → 不在任何视角，不做（§4.5） |
| SEC | 交割失败 FTD | 可用，滞后约 6 周，按个股 → 不做（§4.5） |

2026-11-13 OpenBB 对照里**只读了代码、没下载验过**的（看描述判断不在现有视角内）：

- 达拉斯联储：能源调查和页岩盈亏平衡价、DGEI、德州各项调查
- 里士满联储：NEI、CFO 调查；明尼阿波利斯联储、波士顿联储全部；堪萨斯城联储 LMCI 和农业；芝加哥联储 BBKI / CARTS / CFLMI / CFNAI
- 纽约联储：Business Leaders 调查、HHDC、市场预期调查 SME（按期发的 xlsx + PDF）、staff nowcast（OpenBB 用的 `.../NowCast/downloads/New-York-Fed-Staff-Nowcast_download_data` 没测）
- 费城联储：ATSIX（下载了 1.1MB xlsx 但没解析）、Anxious、Livingston、partisan conflict
- 美联储的货币市场基金、国际证券投资（EFA）
- DTCC 外汇：美元/日元远期点、交叉货币基差没算；外汇期权隐含波动率没实际反推
- ECB / IMF 经济指标 / OECD 其余数据

---

## 4.5 看过、判为不做（2026-11-13 OpenBB 对照）

每条一句理由。成熟后可以并进 `AGENTS.md`「查过、确认没有的」。

**和 FRED 同一天更新，换源没有时效增量**

- 纽约联储利率 API（SOFR / EFFR / OBFR / TGCR / BGCR）：和 FRED 同一个观测日，FRED 的 SOFR 发布当天 07:02 CT 就更新
- 美联储数据下载站 DDP（H.4.1 / H.15 / H.6）：FRED 在发布后约 1 小时内更新（WALCL 15:32 CT）
- BLS 直连 CPI：FRED 的 `CPILFESL` 发布当天 08:13 CT 更新，只晚约 45 分钟，对日终数据没影响
- 达拉斯联储 WEI / IGREA / 截尾 PCE，克利夫兰联储中位数 CPI / EXPINF：都在 FRED 上
- 亚特兰大联储 sticky CPI / 工资增速：**保持走 FRED**，别抄 OpenBB 的直连地址（全部 404，见 §4.6）

**和现有序列重复，或者没有可用的增量**

- 财政部日报 DTS 的每日 TGA：96 个周三和 `WDTGAL` 全部一致；只多给周中的值，和「净流动性只取周三」的设计冲突
- 财政部国债拍卖结果（fiscaldata）：没有发行前收益率（when-issued），算不出拍卖尾差；续发的期限标签不统一
- 纽约联储 SOMA 持仓汇总：WALCL 已经覆盖
- CBOE DSPX 离散度指数：和 √(VIXEQ² − VIX²) 相关 0.998（2018 起 2229 天），我们能自己算
- 克利夫兰联储通胀预期模型：`rates-decomposition-handoff.md` 已经讨论过（DKW 那段）
- 堪萨斯城联储 FSI（月频，和 HY / VIX / MOVE 重复）、纽约联储 MCT 趋势通胀（月频，和 sticky CPI 同角色）

**数据坏了或停更**

- VXHYG：2024 起只有 377 个点，日变化中位数 7.3%、P95 达 32%，在两个值之间来回跳（和记忆里「HYG 期权死盘」一致）
- JYVIX、EUVIX、BPVIX、TYVIX、SRVIX：已停发（403）
- 克利夫兰联储系统性风险 CSV：停在 2025-10-01
- 芝加哥联储 NFCI 直连 CSV：停在 2026-04-24；FRED 的 `NFCI` 是最新的

**不是市场定价，或和现有面板角色重叠**

- 旧金山联储新闻情绪（文本情绪）、费城联储 ADS 日度景气（宏观模型）、里士满联储 SOS 衰退指标（基于失业金申领）
- 费城联储 SPF：`.xlsx` 11.7KB、季频、最新 2026Q3，优先级低

**范围外或者成本太高**

- SEC 交割失败 FTD：滞后约 6 周（最新 cnsfails202609a），按个股；SEC 的 `data.json` 已 307 到 `/files/data.json`
- FINRA 做空余额：`api.finra.org` 免 key 可用，半月频，按个股
- JODI：23.6MB zip，月频，滞后约 2 个月，EIA 周报更好用
- OECD 日本先行指数 CLI：月频，最新只到 2026-08；§2.6 已有内閣府的 CI
- EIA 天然气库存（`NW2_EPG0_SWO_R48_BCF`，测通，最新 2026-10-30 为 3801 Bcf）：面板没有天然气维度，等开了再接
- DTCC 商品掉期：标的只到类别一级（"Oil"、"Heating Oil"），没有 Dubai 这类具体名字
- DTCC 日元通胀掉期：两天的文件里都是 0 笔
- 和视角无关的 provider 整组不做：ECB 及欧元相关、famafrench、nasdaq、tmx、USDA、国会、FFIEC 银行报表、BLS 新闻稿表格

---

## 4.6 OpenBB 对照中发现的坑（2026-11-13）

> ✅ 2026-11-14：涉及已接源的（1、2、3、4、5、8、10）已并入 `AGENTS.md`；6、7、9 只关乎未接的源，留在这里，接的时候再搬。

1. **CBOE 换了下载域名**：`cdn.cboe.com` 对 `api/global/...`（`daily_prices` 和 `delayed_quotes`）307 跳到 `cdn-api.cboe.com`。
   ✅ 已并入（2026-11-14）：`cboeIndex.ts` 与 AGENTS.md 已改新域名。⚠️ **VX 期货合约 CSV（`data/us/futures/...`）不跳转，且在 `cdn-api` 上回 403**，`cboeVx.ts` 保持旧域名。
   另外 CBOE 不存在的代码回 **403 + XML（AccessDenied）**，不是 404
2. **DTCC 保留期**：HEAD 对过期文件也回 200，真 GET 才回 403，判断可用性**必须 GET**（加 Range）。
   保留期按资产类别不同：利率文件最早约 2024-11-10（约 2.0 年），信用文件最早约 2024-09-02（约 2.2 年），中间有零星缺天
3. **DTCC 成交的前端费含应计票息**，换算价格前要扣掉（单名 CDS 实测，见 §1.1 坑 1）；已上线的软银那条也受影响
4. **DTCC 通胀掉期混着「老化」合约**：必须只收现货起息的（§1.3）。✅ 已并入（2026-11-14）：AGENTS.md DTCC 利率行、`fetchers/dtccZcis`（起息日下限也要卡）
5. **EIA v2 单次最多返回 5000 行，超了不报警**：日频 `RWTC` 的 `total` 是 10292，只返回 5000。`offset` 参数有效，`start` 仍被忽略。
   现有周频序列约 1866 行不受影响，**将来接日频序列必须翻页**。另外 EIA 日频现货在美国联邦假日沿用前一天的值（11-11 等于 11-10）
6. **GSCPI 官方下载名为 `.xlsx`，实际是 BIFF8 的 OLE 格式**，要 SheetJS；改走交互页那个 CSV（§1.8）
7. **财政部日报 DTS 的 TGA 收盘余额放错了字段**：在「TGA Closing Balance」那一行的 `open_today_bal` 里，`close_today_bal` 是字符串 `"null"`
8. **亚特兰大联储网站改版**：OpenBB 里所有 atlantafed 路径都 404（BIE、GDPNow、sticky、wage、Taylor、SBU、MPT），
   新前缀是 `/-/media/Project/Atlanta/FRBA/Documents/research-and-data/data/...`
9. **芝加哥联储 NFCI 直连 CSV 停在 2026-04-24**，要用就走 FRED
10. **FRED 限流可能在 HTTP 200 的 JSON 里返回 429**：OpenBB 会检查 payload 里的错误码。真出现时我们的 `fred.ts` 会报一个误导性的 TypeError
    （读 undefined 的 filter），不会污染数据。⚠️ 只读了代码，没复现

---

## 5. 什么时候该抽公共代码

现在**不要**建「通用数据源注册表」。仓库里该有的注册表已经有了，且都是加一行的形态：

```
BUILDERS            (routes/yieldCurve.ts)   加一条曲线源 = 加一行
JOB_WRITTEN_SERIES  (routes/regimeKeys.ts)   库里序列 → 对外名
REGIME_DIMS         (web/pages/<视角>/dims) 面板维度
MARKET_CATALOG      (shared/marketCatalog)   标的目录
```

再抽一层通用抽象会是**一个接口配十个互不兼容的实现** —— CSV / xlsx / BIFF8 / OLE Word /
JSON REST / 本地 WebSocket，鉴权、编码、分页、增量语义全不同，公共部分只剩「有个 URL」。

**唯一值得抽的**：等 SheetJS 真的进来、且有 **2 个以上**使用者之后，
把「下载 → 解 zip/OLE → 按表头名取列」抽成 `fetchers/xlsx.ts`。**两个用户才抽，现在零个。**
