# my-trading-view — agent 指南

个人用的美股市场状态监控盘(类 TradingView)。**Bun + TypeScript 全栈**(前后端都是 TS),
不要引入 Python 工具链。EOD 天级数据,本地单机跑,SQLite 单文件 `data/mtv.db`。

## 取数方式总览

| 源 | 内容 | 频率 | 依赖 | 方式 | 历史 |
|---|---|---|---|---|---|
| **CBOE 指数** | VIX 家族 / SKEW / RXM | 日频 | 零 | **静态 CSV 直下**:`cdn.cboe.com/api/global/us_indices/daily_prices/{指数}_History.csv`(无需 key,免爬虫) | 1990 至今全历史 |
| **CBOE VX 期货** | VX 近月连续(存为 `VX1`) | 日频 | 零 | API 列清单(`www-api.cboe.com/.../product/list/VX/`)+ `cdn.cboe.com/{path}` 下 CSV | 全历史 |
| **FRED** | 利率(UST/TIPS)/ 信用利差(HY+IG 梯队)/ 流动性(WALCL/TGA/RRP/SOFR/IORB)/ 通胀(BEI=DGS−DFII、**5y5y 远期 T5YIFR**、Sticky CPI、薪资)/ **Kim-Wright 期限溢价(THREEFYTP10 + 拟合 THREEFY10)** | 日/月频 | 零(要 key) | JSON API `api.stlouisfed.org/fred/series/observations`(要 key) | 全历史 |
| **FRED(联储政策 / 通胀发布)** | 政策利率目标区间 `fedTargetUpper/Lower`(DFEDTARU/L)· SEP 点阵图中值 `sepMedian`(FEDTARMD)+ 长期 `sepMedianLr`(FEDTARMDLR)· 核心 CPI / PCE(CPILFESL / PCEPILFE)→ `coreCpiYoy/3m`、`corePceYoy/3m` · 例行发布日 `coreCpiRelease` / `corePceRelease` | 日(区间)/ 每次 SEP(点阵图)/ 月(通胀) | 零(要 key) | 同上 JSON API。发布日走 ALFRED `output_type=4`(每期首发 vintage 的 `realtime_start`)—— **不用 `series/vintagedates`**,那个会混进 CPI 2 月初的季调因子修订日、PCE 随 GDP 的年度修订日。⚠️ `FEDTARMD` 的日期 = **预测哪一年**,我们改记为 `YYYY-12-31`;⚠️ 通胀的日期 = **数据所属月份**,对日线断点要用 `*Release` | 区间 / 通胀全历史;⚠️ **点阵图 FRED 只留最新一版**(不做历史)。另派生 `oisHikes{3m,6m,12m,2y}` = SOFR OIS 隐含累计加息次数(读库 Eris 逐日算,见 `shared/policyPath`,近似值)。⚠️ 基准用 FRED `SOFR` 定盘值(也对外发 `sofr`),**别换成 Eris `SOFR1D`**:那是 T+2 起息的 1 天掉期,会提前吃进下次会议(2026-09-08~16 比定盘值高最多 24bp) |
| **NY Fed** | HLW 自然利率 r\*(`rstarHlwCurrent`,**季频**)+ ACM 10Y 期限溢价(`tp10Acm`,**月频**,给 KW 当独立对照) | 季/**月** | 零;**HLW 用 `fflate`** | HLW:官方 xlsx = **zip+XML**,`fflate` 解开后**按工作表名**(`HLW Estimates`)经 `workbook.xml`+rels 解路径 —— 不写死 `sheetN`。ACM:**纯 CSV 零依赖**(`acmPlot_data.csv`,49 KB)⚠️ 这是图表的**无文档端点**,官方公开发布的是同目录 10.1 MB 的 BIFF8 `.xls`;已逐字对账确认内容等同 xls 的 `ACM Monthly` 表,但随时可能挪走 → 拿不到就归 unavailable | 1961 起全历史;⚠️ **current estimates 的历史值会被事后重估**(前视偏差,不能用来论证「当时市场定价错了」) |
| **日本银行(BOJ)** | 需給ギャップ(产出缺口,`jpOutputGap`)+ 潜在成長率及四项贡献度(`jpPot*`) | **季频**(1/4/7/10 月第三个工作日) | 零;**用 `fflate`** | 官方 `gap.xlsx` = **zip+XML**(52 KB,免鉴权),同 HLW 的解法:按工作表名(`data1`/`data2`)解路径。⚠️ 两张表**时间轴不同**(`data1` 日历季度 / `data2` 财年半期),不可 join;⚠️ 末尾有**只有短观 DI、没有 gap** 的待发布行,按「总量列非空」过滤,别按行号取末行 | 1983 起全历史(一次 GET 拿全,故不落库);⚠️ **是估算量不是统计量**,日银自陈方法差异可致数值相差甚大 |
| **Nakajima(中島上智)** | JGB 10Y 期限溢价 + 预期短端(`jpTp10Nakajima` / `jpExpShort10Nakajima`,日频 1995 起)、自然利率 r\* 10Y 及 95% 区间(季频) | 日 + 季;**但发布 2-4 个月不规律** | 零 | GitHub raw CSV `raw.githubusercontent.com/jouchinakajima/program/main/{yield_D,rstar}.csv`。⚠️ `rstar.csv` 表头在**第 2 行**(第 1 行是 `Data as of ...` 元数据),`YYYYQ` 是 **5 位**(`20262`=2026Q2);⚠️ 判停更看 **commit 时间**不看数据末点(>150 天无 commit 才算;门槛取两文件历史最大间隔 —— `yield_D.csv` 111d / `rstar.csv` 114d —— 再留余量),两者在图上长得一样 | 1995 起全历史;✅ `期限溢价+预期短端 = MOF 名义 10Y`,**7724 个重叠日残差全 0**;⚠️ **单模型无对照**,不同于美债 KW+ACM 双模型 |
| **Yahoo** | 股票 EOD + **DXY(`DX-Y.NYB` 真 ICE 美元指数)/ MOVE(`^MOVE`)/ 油品期货(`CL=F`/`BZ=F`/`HO=F`/`RB=F`)/ USD/JPY** | 日频 | `yahoo-finance2` | `yahoo-finance2` **v4** npm(class API `new YahooFinance()`) | 可回填多年 |
| **其它** | Eris(SOFR OIS 曲线)/ MOF+JPX(JGB 收益率/JGB VIX)/ CFTC(日元净持仓 Legacy / VIX 净持仓 TFF)/ Shiller(CAPE) | 混:Eris 日 / MOF 日 / JPX 日 / **CFTC 周** / Shiller 月 | 零;**JPX JGB VIX 用 `fflate`** | 各自 adapter(见 `fetchers/`)| 多为全历史 |
| **EIA** | 周度石油报告:炼厂开工率 / 加工量 + 馏分油产量(→ 收率、同比)/ 馏分油+汽油库存 / 馏分油出口(→ 季节 z)· **零售柴油/汽油泵价**(→ 与批发期货减出零售加价) | **周频**(实物六条周三 10:30 ET 发、截止上周五,滞后 ~5 天;**零售两条周一发**,两批右端日期不齐是常态) | 零(要 key) | JSON `api.eia.gov/v2/seriesid/PET.{ID}.W`(要 key)⚠️ 裸 ID 404,必须带 `PET.` 前缀 + `.W` 后缀;`start`/`end`/`data[]` **全被忽略**,唯一生效的裁剪参数是 `length`;返回**倒序** | 1982 起全历史;**已发布值下周会被修订**(每次拉全量,故不落库) |
| **ISM(经 PR Newswire)** | 制造业 / 服务业 PMI 头条 + 各自 Prices 分项(`ismMfg` / `ismSvc` / `ismMfgPrices` / `ismSvcPrices`) | **月频**(制造业第 1 个工作日、服务业第 3 个工作日,10:00 ET) | 零 | newsroom 列表页 `prnewswire.com/news/institute-for-supply-management/?page=N&pagesize=M` 按 slug 认月报 → 单篇解析「AT A GLANCE」表(**按行首标签取行,不按行号**)。⚠️ 三代版式都实测过:报告月可能在表头第二行(2021~2023)、年份可能被拆进两个 span 成「202 1」(2020-10~2022-02)、2020 年前服务业叫 NMI;⚠️ 服务业表右半边是制造业对照列,只取前两格 | **落库**(daily `ism` 分组增量;`bun run src/server/jobs/ismSnapshot.ts --backfill` 回填,已回填 2018-01 起)。⚠️ 回填 = 每月「最后一次被发布的读数」拼接:次月那篇带回的上月值会覆盖(1 月季节因子重估由此带回一个月),更早月份不改 —— 非官方修订后全序列。**停更防护**:每轮写完查两个扇区各自最新报告月,落后当前月 >2 个月 → `ism` 记 failed(状态灯红,悬停见原因);只看列表页认不认得出月报挡不住单扇区改名(旧名月报会在第一页挂一年) |
| **ICE** | AI 巨头 + 甲骨文单名 CDS EOD 结算价(`iceCds`) | 日频 | 零 | 公开 JSON `www.ice.com/api/cds-settlement-prices/icc-single-names`(免 key) | **仅当天快照,不可回填** |
| **moomoo** | 期权链(股票/ETF/指数:SPY/.VIX) | 日频 | `moomoo-api` | 本地 OpenD WebSocket `127.0.0.1:33333` | **仅当天快照,不可回填** |
| **SEC XBRL** | AI 链公司季报财务(TTM 毛利率/capex/FCF) | **季频** | 零 | 公开 JSON `data.sec.gov`(免 key,**必须带 User-Agent**);submissions 比 filed → 有新申报才拉 companyfacts | 全历史(季频) |
| **Deribit** | 加密期权链(BTC/ETH) | 日频 | 零 | 公开 REST `deribit.com/api/v2/public`(免 key) | 链快照型;但 **DVOL** 波动率指数有历史 |
| **Computable(CGI)** | GPU 算力租赁价指数 `CGI_{H100,H200,B200,B300}`(USD/GPU/小时) | 源 15 分钟 → 我们按 UTC 日聚合 | 零 | 公开 REST `api.getcomputable.com/v1/index/{sku}/history`(免 key,匿名只读)。**采集器与算法开源:[getcomputable/gpu-index](https://github.com/getcomputable/gpu-index)**(Apache-2.0)—— 面板成员、换代生效时间、口径争议全在 CHANGELOG/METHODOLOGY 里,查口径去仓库不要猜。⚠️ `/v1/methodology` 自称窗口 90 天 / 粒度 15 分钟,**两个都不实**(见下) | **滚动窗口,不可回填更早**;2026-09-18 实测 H100/H200 26 天、B200 33 天、B300 39 天 |

**关键差异**:**两个期权源(moomoo + Deribit)的链都是快照型**——25Δ 序列只能从今往后每个
交易日攒一个点,拿不到历史(25Δ 行权价每天滚动,固定合约的历史 IV 无法重建该序列)。
其余源都能回填全历史;Deribit 的 **DVOL**(加密版 VIX)是个例外,带历史可回填。

### 依赖档位(选源时的主要成本项)

| 档位 | 谁 | 说明 |
|---|---|---|
| **零依赖** | FRED · CBOE · ICE · **EIA** · SEC · Deribit · MOF · CFTC · Shiller · **NY Fed ACM** · **Nakajima** · **Computable** · **ISM(PRN)** | `fetch` + 自己解 CSV/JSON/HTML |
| **`fflate`**(已有) | NY Fed HLW · JPX JGB VIX · **BOJ 产出缺口** | `.xlsx` = zip+XML,解 zip 后正则取(公共解包在 `fetchers/xlsx.ts`) |
| **SheetJS**(⚠️ 未加) | — | BIFF8 `.xls`(OLE)。**npm 上的 `xlsx@0.18.5` 有 2 个 high CVE**,必须走 `bun add "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz"` |
| **`word-extractor`**(⚠️ 未加) | — | OLE Word `.doc`。SheetJS 读不了(`Cannot find Workbook stream`) |

`.xlsx` 与 `.xls` 是**两种完全不同的格式**:前者 zip、现有工具链就能解;后者 OLE 二进制、
要新依赖。选源时先看扩展名,别把 `.xls` 当 `.xlsx` 估成本。

## 查过、确认没有的(别再查一遍)

否定结论比正面清单更容易丢。以下都是实际打开页面 / 调 API / 搜目录确认过的:

| 想要的 | 结论 | 查证方式(2026-09) |
|---|---|---|
| 日本 BEI / 实际收益率 / 期限溢价 / r\* | **FRED 全都没有** | 目录搜 "Japan breakeven inflation" 232 条全是美国的 `T10YIE` 之流;搜 "Japan term premium / natural rate" 只回日本名义 10Y + 美国 `DLTIIT` |
| 日本 r\* | **HLW 官方文件不含日本**(只有 US / Canada / Euro Area);BOJ 自己的估计是**一年一更的区间**(2026-03 那版 −0.9%～+0.5%),发在日銀レビュー PDF 里,不是序列。→ **另有出路(2026-09)**:中島模型的 `rstar.csv` 是季频序列带 95% 区间,**已接**;但那是**单研究员模型、非日银官方**,且是**实际口径**(日银官方另发六模型并排的一份,未接) | 解开官方 xlsx 看表头 |
| ~~日本期限溢价~~ | ~~ACM / Kim-Wright 都只做美债,日本无公开模型序列~~ → **结论已推翻(2026-09)**:中島上智公开了 JGB 期限溢价 / 预期短端 / r\* 的模型估计,**已接**(见上表 Nakajima 行)。ACM / KW 确实只做美债这半句仍成立 | GitHub `jouchinakajima/program` |
| ISM PMI 的**官方 / 结构化**源 | **都拉不到** → 已改走 PR Newswire 全文(见取数总览)。ismworld.org 的 Report On Business 页全部跳 SSO,SSO 页是 **reCAPTCHA v3 自动提交表单**(脚本拉不到,也不该绕);FRED 2016 年起就没有 ISM(`series/search` 零命中);DBnomics 有 `ISM` provider 但**停更在 2026-01**,`pmi` 数据集里唯一序列值 ~10,不是头条 | curl + FRED API + DBnomics API(2026-09) |
| S&P Global PMI(含 flash) | **源可用但不接**。官网新闻稿列表(浏览器 UA 可拉)→ 每篇是 PDF,**免费件只有 4 个头条数字,价格等分项只有文字和图、没有数值**;历史是订阅制,免费只带当期 + 上期 → 只能从今往后攒。flash 的唯一增量是时点(月中,早 ISM 一周),而 flash 当天的利率反应面板上本来就有 | 下载 2026-09-23 flash PDF 实抽(2026-09) |
| 日本物価連動国債收益率曲线 | **不存在现成曲线**。JSDA 只发**按銘柄的价格**(实测每日 10 只券),要自己选券 + 处理想定元金額 + 插值。MOF 只发名义(`jgbcmi_all.csv` → 404),BOJ API 里 `物価連動` 零命中(扫过 FM01–FM12) | — |
| 日元通胀掉期(ZCIS) | **无免费源**。JSCC 只清算普通 IRS(页面「物価/インフレ」零命中) | — |
| 日元 OIS 曲线(JSCC) | **JSCC 不发利率**。`irs_toukei_nitiji_{YYYYMMDD}.xlsx` 是**清算统计**(债务负担件数 / 金额,按 0-2Y / 2-5Y / 5-10Y / 10-30Y / 30+Y 分组),不是结算利率;且只挂当天一份(09-09 那份已 404) | 下载 2026-09-25 那份解开看(2026-09) |
| 柴油交割地(PADD1)的实物对照 | **源可用但不接** —— `WDISTP11` 端点正常,是**形式**不成立:PADD1 季节 z 与全国 z 相关 **r=0.937**、末值差 0.04、「一破一不破 −2」近两年仅 1.9%,没有增量。想要的判别(裂解爆表时分「交割地真缺货」还是「纸面挤压」)实际几乎不发生 | 拉 780 周实算(2026-09) |
| 炼厂检修日历 | **无免费权威源**(IIR / Genscape 均需订阅)。替代:用已接的 `refUtilZ5y`(开工率季节 z)当代理 —— 检修季开工率会季节性走低,z 扣掉那层后剩下的才是非计划停车 | 商业源官网询价页(2026-09) |
| ↑ 为什么 z 看不见 | PADD1 在**结构性萎缩**,5 年基准跟着降 → z 归零。同日 PADD1 同比 −24.5% 而全国 −8.3%;9 月上旬中位 2015 年 57,687 千桶(占全国 38.2%)→ 2026 年 21,003(20.2%),**十一年缩 64%**。要接只能接**绝对水位**(逼仓看池子多大,与季节偏离无关),而那是慢变量,不值一格周频图 | 同上 |

**候选源清单**(查过能用、还没接)见 `docs/data-sources-candidates.md`。

## 数据源踩坑(大多是试出来的,文档里没有——改之前先读)

### moomoo OpenAPI(期权)

- **代码格式**:个股/ETF 用普通代码 `SPY`;**美股指数用双点** `.VIX` / `.SPX`
  (market.plate.code,板块段留空)。`US.VIX` / `VIX` → 报 `未知股票`。
  moomoo 的 skill SKILL.md **没写指数格式**,只列了单点的股票/ETF。
- **指数没有现货报价**:对 `.VIX` 做 GetSecuritySnapshot → `暂不支持美股指数`。
  所以指数的 `underlyingPrice` 存 null。不影响 25Δ —— `select25Delta` 只用每个合约的
  delta,不用现货。VIX 期权**合约本身**的 snapshot 照常返回全套 greeks。
- **"未知/不支持" ≠ 数据不存在**:报错措辞的差异是线索(`未知股票` → `暂不支持指数`
  说明格式越来越对)。穷举代码格式 + 用 Option Screener(`get_option_screen --markets US_INDEX`)
  验证数据到底存不存在,**别凭一两次失败就下"做不到"的结论**。(VIX 就这么被误判过一次。)
- **两个端口别搞混**:`33333` = WebSocket(我们 TS 用的 `moomoo-api` npm 包);
  `11111` = 原生 TCP(Python SDK / moomoo 官方 skill 用的)。
- **IV 是百分数**:moomoo 返回 `19.296` 表示 19.296%,入库前 ÷100 归一化成小数。
- **put delta 为负、call delta 为正**(已用真实链核实)。25Δ 选取依赖这个符号约定。
- **链/快照字段路径**(靠 debug dump 试出来的,非直觉):
  - 静态链:`o.call.basic.security.code`、`o.call.optionExData.strikePrice`
  - 快照:greeks/IV/OI 在 `optionExData`,行情(bid/ask/curPrice/volume)在 `basic`
- **WebSocket 必须 `ws.websock?.close()`**,光 `ws.stop()` 不够——底层 socket 的重连定时器
  会让事件循环一直活着,daily CLI 永远退不出去。
- **option chain 的 start~end 跨度 ≤ 30 天**,超了报 ret=-1。
- **OpenD 必须本机在跑**:不能放 VPS(moomoo 把远程 IP 登录判为风险)。所以期权数据只在
  你的 Mac + OpenD 开着时才更新;OpenD 没开,options 这组 job 失败,其它组不受影响。
- **headless OpenD(免 GUI)**:macOS 二进制在 `OpenD.app/Contents/MacOS/OpenD`,CLI 参数
  `-login_account -login_pwd_md5 -lang -log_level=no -console=0 -no_monitor=1`(`-no_monitor=1`
  关守护进程,否则杀掉后会被重新拉起)。websocket 端口/key 可留在 OpenD.xml。**新设备首次登录
  要手机验证码,headless 给不了 → 先 GUI 登一次注册本机**。一条龙脚本见 `scripts/daily-with-opend.sh`
  (起 OpenD → 等端口就绪 → 跑 job → 收尾),命令配在 `.env` 的 `OPEND_CMD`。
- **`moomoo-api` npm 包没有类型声明**,import 处需要 `@ts-expect-error`。
- **扩标的时的限制**:GetOptionChain 限频约 60次/30s,快照每次最多 **400 个合约**
  (`SNAPSHOT_BATCH=400` 已压线)。当前 `fetchChain` **每个标的开一条 WebSocket**——
  SPY + .VIX 两个无所谓,但 moomoo 文档警告反复 connect/close 会变慢/超时,**扩到很多
  标的时应改成复用一条连接**(把 `withConnection` 抽出来包住整轮抓取,而非每标的一次)。

### Deribit(加密期权 BTC/ETH)

- **免 key 公开 REST**:`deribit.com/api/v2/public/{method}`,响应包 `{result}` 或 `{error}`。
  实现了跟 moomoo 同一个 `OptionsChainClient` 接口,所以 `select25Delta` + 入库全复用。
- **没有批量 greeks 接口**:`get_book_summary_by_currency` 只有 mark_iv/OI,**没有 delta**。
  25Δ 选取需要 delta,只能逐合约打 `ticker`(带 greeks)。好在**单个到期日才几十个合约**
  (~30天的 BTC 约 34 个),分批并发即可,不是负担。
- **IV 是百分数**(`mark_iv: 35.12` = 35.12%),÷100 归一化,与流水线一致。
- **期权价格是币本位**(如 `0.018` BTC,不是美元),归档原样保留,用时注意单位。
- **现货价**走 `get_index_price?index_name=btc_usd`(ticker 里的 `underlying_price` 是该到期日远期)。
- **DVOL**(加密版 VIX,带历史):`get_volatility_index_data?currency=BTC&...&resolution=43200`,
  返回 OHLC。目前没接,要做加密波动率历史曲线时用它(对标 SKEW/VX 那种有历史的源)。
- **加密 24/7**,没有"收盘"概念。我们仍用 `lastClosedTradingDate()` 给 BTC 打戳,
  让它跟股票/指数落在同一日期轴上(便于同图对比),这是有意为之。

### 其它数据源

- **Yahoo(股票 EOD + DXY/MOVE/油品期货/USD-JPY)**:用 `yahoo-finance2` **v4**(class API `new YahooFinance()`;
  v4 相对 v3 只把最低 Node 提到 22,**API 无变化**)。周末它会返回标着周六/日的快照——用
  `lastClosedTradingDate()` 归到正确的周五,否则 X 轴混入周末。
- **MOVE(ICE BofA 债市波动率,走 Yahoo `^MOVE`)**:带 caret,无 caret 的 `MOVE` 是 Movado 股票。
  MOVE 是 ICE 授权指数,FRED / stooq 都没有,GitHub 上的仓库不是用 yfinance 就是 Bloomberg,**没有第二个免费源**。
  坑:Yahoo 的日线 `quotes[].close` 会**整段返回 null**(2026-07-20 起,已用 CNBC 与 TradingView 核对确认值仍在更新),
  但同一响应的 `meta.regularMarketPrice/Time` 仍带当日真值。故 `fetchers/moveIndex` 用 meta 补当天,
  `jobs/moveSnapshot` 把整条序列镜像进 `market_series` 的 `MOVE`,regime 路由读时 **Yahoo 优先、库兜底**
  (`mergeMove`),源自愈后真值自动 upsert 覆盖,**没有删除路径**。断供期 meta 只有当日快照、漏一天永久缺一格,
  故 `move` 列入 `REQUIRED_JOBS`,且成败判据是「本次有没有拿到**已收盘**的 meta 点」(盘中值不落库,见 `isCloseSnapshot`:判的是**当下**——meta 的 ET 日已翻篇、或现在已过 17:00 ET——不看 meta 那一刻几点,故半日市早收不构成特例。取 17 不取 16 是因为 MOVE ~16:34 ET 才定盘)——**不要改成比对交易日历**,
  假日 `lastClosedTradingDate()` 会返回假日当天,导致整天判失败、守卫永远不绿。
- **CBOE(VIX 家族/SKEW/RXM/VX1)**:直接打 API + 下 CSV,**不需要 Playwright**。
- **FRED(利率 / 信用利差 / 流动性 / 通胀)**:免费 key 在 `.env`(`FRED_API_KEY`),不要提交。**油品现货/期货走 Yahoo(`CL/BZ/HO/RB=F`),不是 FRED**;DXY 也走 Yahoo 真 ICE 指数(`DX-Y.NYB`),不用 FRED 的贸易加权 `DTWEXBGS`。
- **ICE 单名 CDS(AI 巨头 + 甲骨文)**:免费公开端点(无 auth),真 CDS 结算价,不是债券代理/二手抓取。
  几个坑:①端点吐的是**价**(平价 100)不是 spread,读时用 `cdsPriceToSpreadBp` 线性近似成 bp(annuity=4.7 校准);
  存库存**原始价**(真值源)。②`instrumentName`(如 `ORCLE.SNRFOR.USD.XR14.100.2031-06-20`)按 ticker 匹配名单,
  **不认 ICE 的 `name` 字段**(有 "Oracle Cop" 等错拼);筛 SNRFOR+USD+100bp 票息,同名多到期取最长(on-the-run 5Y)。
  ③价 ≤0 当缺价滤掉(`Number('')→0` 会伪装成 ~2228bp 假数据)。④**仅当天快照、不可回填**,靠 daily 每天攒;
  故 `ice_cds` 列入 `REQUIRED_JOBS`,且默认展示的 core 标的缺任一即 job failed 告警(`missingCoreCds`)。
- **Computable GPU Index(算力租赁价)**:公开挂牌价的聚合,**不是成交价**;CoreWeave 在四个面板里占三个,
  所以这条线跟 CRWV 不独立,别拿它给 CRWV 做交叉验证。几个实测坑:
  ①**窗口和粒度都在变,别写死**。文档说 90 天 / 15 分钟,实测 2026-09-18 是 26~39 天(比两周前实测的 17~30 天**更长**),
  粒度改过三档(6h → 1h → 15min)且各 SKU 切换日不同。`limit` 文档写上限 20000,实测 ~2950 才是真上限,取 2880。
  ②**方法论每隔几周换代**(`methodology_id`,如 `h100_sxm_v1_calc_v16`),换代日一天内混两代 id(切换不卡 UTC 日界)。
  已逐日量过 09-03 加席与 09-15 上 EWMA 平滑两次换代:**换代日的变化量小于相邻普通日的变化量**,断点不可识别,
  故**不读 `methodology_id`、不做图上标注**。重查方法见 `fetchers/computableGpu.ts` 顶部注释。
  ③`./reproduce`、collector 那套只对自建索引的人有用,我们是纯 API 消费方,仓库的 commit 大多与我们无关。
- **图表**:用 BusinessDay(字符串日期)压掉周末空隙;跨标的共享 X 轴时先 `dropWeekends()`。

## 约定

- 改完代码跑 `bunx tsc --noEmit` + `bun test` + `bun run lint`(**Biome**:lint + format 二合一;
  `react-hooks/exhaustive-deps` 为 error)。因 typescript-eslint 不支持项目用的 TS7,lint 用 Biome/oxlint
  这类 Rust 工具(不依赖 typescript 包)。**不要自动 git commit**,等用户发话。
- 注释用中文。声明式优先于命令式 `for` 循环。
- 秘密只在 `.env`(gitignored):`FRED_API_KEY`、`MOOMOO_WS_*`、`SEC_USER_AGENT`(SEC 要求真实联系方式)。
