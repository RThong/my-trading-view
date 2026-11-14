# my-trading-view — agent 指南

个人用的美股市场状态监控盘(类 TradingView)。**Bun + TypeScript 全栈**(前后端都是 TS),
不要引入 Python 工具链。EOD 天级数据,本地单机跑,SQLite 单文件 `data/mtv.db`。

## 取数方式总览

| 源 | 内容 | 频率 | 依赖 | 方式 | 历史 |
|---|---|---|---|---|---|
| **CBOE 指数** | VIX 家族 / SKEW / RXM · **VRP 隐含腿**(VXN/GVZ/OVX/VXTLT/BITVX/**VXSMH**(半导体,2025-09-16 起),daily 入库)· VVIX · 隐含相关性 **COR1M / COR3M**(`cor1m` / `cor3m`,源 2006-01-03 起;**读时现拉、不入库**,同其它 CBOE 现拉序列截到 2018 起;派生 `corTermSpread` = COR3M − COR1M,pp,同日内连接)| 日频 | 零 | **静态 CSV 直下**:`cdn-api.cboe.com/api/global/us_indices/daily_prices/{指数}_History.csv`(无需 key,免爬虫;旧域名 `cdn.cboe.com` 307 跳过来;不存在的代码回 403 + XML 不是 404) | 1990 至今全历史;入库从 2018 起,GVZ/OVX 放到上市日 2009-09-18(`vrpInputs` 的 `CBOE_START`);BITVX 2025-01 起 |
| **CBOE VX 期货** | VX 近月连续(存为 `VX1`)/ 第三近 `VX3` · **每份月度合约整条曲线 `VX:<到期日>`**(如 `VX:2026-11-18`,按到期日对 VIX 期权;到期当天那行 = 最终结算 SOQ) | 日频 | 零 | API 列清单(`www-api.cboe.com/.../product/list/VX/`)+ `cdn.cboe.com/{path}` 下 CSV(⚠️ 只能用旧域名,`cdn-api` 回 403)| 全历史 |
| **CBOE 日统计** | 认沽认购比:个股 `pcEquity` / 指数 `pcIndex` / 全部 `pcTotal`(值 = 认沽量 ÷ 认购量,**Cboe 自家交易所口径** = CPCE / CPCI,不是全美 OPRA)+ 均线 `pc{Equity,Index}Ma{5,20,63}`(63 ≈ 3 个月,读库现算) | 日频 | 零 | `www.cboe.com/markets/us/options/market-statistics/daily?dt=YYYY-MM-DD`(免 key;旧地址 302 到这里;一页 ~420KB、服务端现渲染约 1~3 秒、没有更轻的接口):Next.js 服务端渲染,当天统计以 JSON 嵌在 `self.__next_f.push` 载荷里(引号转义成 `\"`),按版块名(`EQUITY OPTIONS` / `INDEX OPTIONS` / `SUM OF ALL PRODUCTS`)取 **VOLUME 行的 call / put 原始量**自己算比值(页面比值只有 2 位小数)。⚠️ 没数据的日子(周末 / 假日 / 还没发布)是 `"optionsData":null` 照常 200;临时休市日(2025-01-09 国葬日)有数据但个股成交为 0,也当没数据跳过;连 `optionsData` 键都没有 = 改版,抛错。见 `fetchers/cboePutCall` | **落库**(daily `put_call` 分组:最近 30 天里库里缺的工作日都补,漏的天下一轮自动补;源晚发布时由新鲜度探针 `CBOE_PC_EQUITY` 强制当天后续触发点重跑,同 VX1;窗口外的缺口跑 `--backfill`)。**停更防护**:库里最新一天落后上一收盘日、或中间两天之间隔了超过 5 个工作日(连休最多 3 个)→ `put_call` 记 failed 红灯 —— 挡「改版后载荷里一直 `optionsData:null`」与停机超 30 天的窗口外缺口,两种都不会自愈。源自报 `minDate` **2019-10-07**,已从那天全量回填(`bun run src/server/jobs/putCallSnapshot.ts --backfill`) |
| **美国财政部** | 美债名义 par yield 曲线(11 档 1M–30Y,`treasury` / regime 的 10Y·2Y)+ **TIPS 实际收益率曲线**(5Y/7Y/10Y/20Y/30Y,`real`)→ 现算 **BEI** = 名义 − 实际(`bei`,两腿截到共同末日) | 日频(**当天收盘即出**) | 零 | 按年 CSV `home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/{year}/all?type={daily_treasury_yield_curve \| daily_treasury_real_yield_curve}&field_tdr_date_value={year}&_format=csv`(免 key),见 `fetchers/usTreasuryPar`。⚠️ 两张表**表头大小写不同**(名义 `"5 Yr"`、实际 `"5 YR"`),按表头名定位列;文件内倒序。⚠️ 没数据的年份回 **200 + 0 字节**:只在 1 月上旬放过今年,其余年份空 / 一档都解析不出 = 失败、整条抛(防缺段冒充完整被缓存)。⚠️ **别换回 FRED `DGS*` / `DFII*`**:同值但经 H.15 固定晚一个工作日 | 读时现拉、不落库,2018 起 |
| **FRED** | 信用利差(HY+IG 梯队)/ 流动性(WALCL/TGA=WDTGAL/准备金 WRBWFRBL/RRP/SOFR/IORB;存量腿一律周三时点,别用周平均 WTREGEN/WRESBAL;RRP 是日频,净流动性只在 WALCL 周三取点,见 `netLiquidityWeekly`)/ 通胀(**5y5y 远期 T5YIFR**、Sticky CPI、薪资)/ **Kim-Wright 期限溢价(THREEFYTP10 + 拟合 THREEFY10)** | 日/月频 | 零(要 key) | JSON API `api.stlouisfed.org/fred/series/observations`(要 key) | 全历史;⚠️ **ICE BofA 利差(`BAML*`,信用 tab 的 HY + 13 条梯队)例外:FRED 自 2026-04 起只留滚动 3 年**(序列说明原文;ALFRED 旧 vintage 也一并截了),窗口每天往前挪 → daily `credit_spread` 组每天全量镜像进 `market_series`(series_id = FRED id),读时现拉优先、库兜底(`preferLive`,同 MOVE)。2018 起的旧段已从 Wayback Machine 存的 FRED 下载文件(`fredgraph.csv?id=` / `data/<ID>.txt`)一次性补回库里(与 FRED 现值重叠 805 天逐日零差):HY / BB / CCC / 15Y+ 连续;BBB / B / AAA 缺 2023 年的 2~8 个月,AA / A 与 5 条期限梯队缺 2021-04~2023-11(存档没有)|
| **FRED(联储政策 / 通胀发布)** | 政策利率目标区间 `fedTargetUpper/Lower`(DFEDTARU/L)· SEP 点阵图中值 `sepMedian`(FEDTARMD)+ 长期 `sepMedianLr`(FEDTARMDLR)· 核心 CPI / PCE(CPILFESL / PCEPILFE)→ `coreCpiYoy/3m`、`corePceYoy/3m` · 例行发布日 `coreCpiRelease` / `corePceRelease` | 日(区间)/ 每次 SEP(点阵图)/ 月(通胀) | 零(要 key) | 同上 JSON API。发布日走 ALFRED `output_type=4`(每期首发 vintage 的 `realtime_start`)—— **不用 `series/vintagedates`**,那个会混进 CPI 2 月初的季调因子修订日、PCE 随 GDP 的年度修订日。⚠️ `FEDTARMD` 的日期 = **预测哪一年**,我们改记为 `YYYY-12-31`;⚠️ 通胀的日期 = **数据所属月份**,对日线断点要用 `*Release` | 区间 / 通胀全历史;⚠️ **点阵图 FRED 只留最新一版**(不做历史)。另派生 `oisHikes{3m,6m,12m,2y}` = SOFR OIS 隐含累计加息次数(读库 Eris 逐日算,见 `shared/calc/policyPath`,近似值)。⚠️ 基准用 FRED `SOFR` 定盘值(也对外发 `sofr`),**别换成 Eris `SOFR1D`**:那是 T+2 起息的 1 天掉期,会提前吃进下次会议(2026-09-08~16 比定盘值高最多 24bp) |
| **NY Fed** | HLW 自然利率 r\*(`rstarHlwCurrent`,**季频**)+ ACM 10Y 期限溢价(`tp10Acm`,**月频**,给 KW 当独立对照) | 季/**月** | 零;**HLW 用 `fflate`** | HLW:官方 xlsx = **zip+XML**,`fflate` 解开后**按工作表名**(`HLW Estimates`)经 `workbook.xml`+rels 解路径 —— 不写死 `sheetN`。ACM:**纯 CSV 零依赖**(`acmPlot_data.csv`,49 KB)⚠️ 这是图表的**无文档端点**,官方公开发布的是同目录 10.1 MB 的 BIFF8 `.xls`;已逐字对账确认内容等同 xls 的 `ACM Monthly` 表,但随时可能挪走 → 拿不到就归 unavailable | 1961 起全历史;⚠️ **current estimates 的历史值会被事后重估**(前视偏差,不能用来论证「当时市场定价错了」) |
| **财务省(MOF)周度证券流** | 対外及び対内証券売買契約等の状況(周次・指定報告機関ベース):日本居民净买外国中长期债 / 外国股票、非居民净买日本股票 / 中长期债 → 对外发 **52 周累计**(4 周累计在 0 上下乱翻、看不出结构性流向,已弃)`jpFlowOutBonds` / `jpFlowOutEquity` / `jpFlowInEquity` / `jpFlowInBonds`(兆円,正 = 买超;「日本 › 资金流」tab) | **周频**(每周四前后发上一周,周日~周六) | 零 | `www.mof.go.jp/policy/international_policy/reference/itn_transactions_in_securities/week.csv`(免 key,**Shift-JIS**,约 250KB),见 `fetchers/mofSecurities`。⚠️ 表头是多行合并单元格,按列号取、**整行核对英文子表头**(Acquisition/Disposition/Net 两半各 11 列),版式变就抛错;⚠️ 期间写成 `2026．11．1～11．7`(全角点),跨年周终点另写年份;周截止日是**周六**,我们标**周五**(标周六会在同格日频工作日序列的时间轴上多出周六格);⚠️ 空格子要当缺值(`Number('')` 是 0);⚠️ 2014-01 起投信从「中長期債」挪进「株式・投資ファンド持分」,之前股 / 债口径不同 | 2005-01 起全历史(一个文件);读时现拉、不落库 |
| **日本银行(BOJ)** | 需給ギャップ(产出缺口,`jpOutputGap`)+ 潜在成長率及四项贡献度(`jpPot*`) | **季频**(1/4/7/10 月第三个工作日) | 零;**用 `fflate`** | 官方 `gap.xlsx` = **zip+XML**(52 KB,免鉴权),同 HLW 的解法:按工作表名(`data1`/`data2`)解路径。⚠️ 两张表**时间轴不同**(`data1` 日历季度 / `data2` 财年半期),不可 join;⚠️ 末尾有**只有短观 DI、没有 gap** 的待发布行,按「总量列非空」过滤,别按行号取末行 | 1983 起全历史(一次 GET 拿全,故不落库);⚠️ **是估算量不是统计量**,日银自陈方法差异可致数值相差甚大 |
| **日本银行 统计 API** | 银行业利率传导:普通存款挂牌利率 `jpDepositRate`(IR02 `DLDR121N`)· 存量贷款约定平均利率 `jpLoanRateStock`(IR04 `DLLR2CIDBST1`,国内银行合计)· 无担保隔夜拆借月均 `jpCallRate`(FM01 `STRDCLUCON` 日频 → 月均)→ 派生(见 `analytics/jpBanks`):日频 `jp2yMinusDeposit` = `jpCallMinusDeposit` + `jp2yMinusCall`(锚 2Y 日期,存款/拆借前向填充,逐点恒等)· 月频 `jpLoanDepositSpread`(粗代理)· 贝塔两条变动线 `jpDepositDelta` / `jpCallDelta60`(基准 2024-01)· 比值 `jpDepositBeta`(只供读数,不上图) | **月频**(存款当月中旬发;贷款滞后 ~2 个月;拆借日频,**比 2Y 晚约一周发**) | 零 | CSV `www.stat-search.boj.or.jp/api/v1/getDataCode?format=csv&lang=en&db=<DB>&code=<代码,可多个>`(免 key;**跨 DB 要分开请求**;`getMetadata?db=<DB>` 列全库代码)。⚠️ 头部有 `STATUS/MESSAGE/DATE/PARAMETER/NEXTPOSITION` 元数据行,按「首格是请求代码」认数据行;名称列带逗号,只取首格与末两格;缺值是字面量 `null`;代码写错回 **JSON 400** 不是 CSV;`NEXTPOSITION` 非空 = 分页(未实现,撞上即抛错)。⚠️ 存款是**挂牌**口径、贷款是**成交**口径,相减只是粗代理(精确值看财报「預貸金利回り差」);⚠️ 大型银行(City Banks)只有**新做**贷款分组,**存量**的银行分组 2002-03 起停发,故只接国内银行合计;⚠️ 贝塔分母用拆借月均不用政策目标(2024-01 目标 −0.1% 只作用于政策利率余额,市场在 −0.01%),政策利率月中变动的那一月贝塔失真 | 存款 2022-04 起(2007–2022 的周度旧序列 `DLDR120N` 已停更,不接)· 贷款 1993 起;能回填全历史 → **读时现拉、不落库**(从 2022 起拉) |
| **日本银行 统计 API · 企业物价(PR01)** | 企业物价指数 CGPI(`PRCG20_2200000000`,All commodities,2020=100)→ 同比 `jpCgpiYoy`(「日本 · 通胀」,生产端先行) | **月频**(次月中旬发) | 零 | 同上 `getDataCode`,`db=PR01`,复用 `fetchers/bojStat`。⚠️ 最新月可能是字面量 `null`(未发布),解析时跳过;同比用 `monthlyAnnualizedPct(pts, 12)`,对照月精确命中不往前贴,故多拉一年(2017 起)垫对照期 | 全历史;**读时现拉、不落库** |
| **日本银行 统计 API · 短観(CO)** | 企業の物価見通し:物价全般 1 年后 / 5 年后的企业预期平均(全规模全产业,`TK99F0000204HCQ00000` / `…0206…`)→ `jpInflExp1y` / `jpInflExp5y`(%,「日本 › 通胀」第二格;日本没有可用 BEI,这是通胀预期代理) | **季频**(3/6/9 月那期次月初发,12 月那期当月中旬发) | 零 | 同上 `getDataCode`,`db=CO`,`fetchBojSeries(..., { quarterly: true })`。⚠️ 季度期间写 `YYYYQQ`(QQ = 01~04,**和月频同为 6 位、形状分不出**,所以由调用方声明 quarterly);起止参数也得是 `YYYYQQ`,写月份 `202606` 报 Invalid frequency;季度值落季末(`fetchers/quarter`)。3 年后(`…0205…`)不取:与 5 年后水平相关 0.99 | 2014Q1 起(这一问 2014 年才加);读时现拉、不落库 |
| **e-Stat(总务省统计)** | CPI「生鮮食品及びエネルギーを除く総合」(新核心核心)前年同月比 `jpCoreCoreCpiYoy`(日银判断口径) | **月频**(次月下旬发) | 零(**要免费 appId**,`ESTAT_APP_ID`;没配 → 该序列归 unavailable、不挡缓存,同 EIA) | JSON `api.e-stat.go.jp/rest/3.0/app/json/getStatsData`,`statsDataId=0004052037`(**2025 年基准**)· `cdCat01=0178` · `cdArea=00000`(全国)· `cdTab=3`(前年同月比,现成同比列、不自算)。⚠️ **别用 2020 年基准 `0003427113`**:两张表 2026-09 都还在更新,但 2026 年起同比差 0.1pp,官方头条已切 2025 基准;⚠️ 时间码 `YYYY00MMMM`(月份写两遍),年值 `YYYY000000` 要滤掉;缺值 `***`;返回倒序。表 id / 分类码用 `getStatsList`(`statsCode=00200573`)/ `getMetaInfo` 实测 | 同比列 2016 起;读时现拉、不落库 |
| **Nakajima(中島上智)** | JGB 10Y 期限溢价 + 预期短端(`jpTp10Nakajima` / `jpExpShort10Nakajima`,日频 1995 起)、自然利率 r\* 10Y 及 95% 区间(季频) | 日 + 季;**但发布 2-4 个月不规律** | 零 | GitHub raw CSV `raw.githubusercontent.com/jouchinakajima/program/main/{yield_D,rstar}.csv`。⚠️ `rstar.csv` 表头在**第 2 行**(第 1 行是 `Data as of ...` 元数据),`YYYYQ` 是 **5 位**(`20262`=2026Q2);⚠️ 判停更看 **commit 时间**不看数据末点(>150 天无 commit 才算;门槛取两文件历史最大间隔 —— `yield_D.csv` 111d / `rstar.csv` 114d —— 再留余量),两者在图上长得一样 | 1995 起全历史;✅ `期限溢价+预期短端 = MOF 名义 10Y`,**7724 个重叠日残差全 0**;⚠️ **单模型无对照**,不同于美债 KW+ACM 双模型 |
| **Bitstamp** | BTC 现货日 K(`price_eod` 的 `BTC`,全站所有 BTC K 线 / 夏普 / VRP 的 RV 腿共用) | 日频(含周末) | 零 | 公开 REST `bitstamp.net/api/v2/ohlc/btcusd/?step=86400&limit=1000&start=`(免 key,单次 ≤1000 根)。现货、原生 UTC 0 点切日。⚠️ 早年零成交日回 0 价,要滤掉;分页回空会留 ~1000 天的洞 → 整次抛、降级 Yahoo。⚠️ 别换回 Deribit 日线(08:00 UTC 切,见 Deribit 踩坑) | 2011-08 起全历史,2012 起实测零缺口 |
| **Yahoo** | **ETF 现货 `price_eod`(SPY/QQQ/GLD/USO/TLT/NOBL/SMH,`close` = 只调拆股不调分红)** + 股票 EOD + **DXY(`DX-Y.NYB` 真 ICE 美元指数)/ MOVE(`^MOVE`)/ 油品期货(`CL=F`/`BZ=F`/`HO=F`/`RB=F`)/ USD/JPY / 标普 500 与等权指数(`^GSPC` / `^SPXEW`,市值集中度比值,等权 2006-12 起)** | 日频 | `yahoo-finance2` | `yahoo-finance2` **v4** npm(class API `new YahooFinance()`)。**图表编辑器的任意代码**另走 `/api/yahoo/search?q=` + `/api/yahoo/history/:symbol`(`fetchers/yahooLookup`,读时现拉、进程内存 TTL 缓存、不落库;`close` 同 price_eod 口径)。⚠️ Yahoo 搜索只认英文名 / 代码,中文搜不到;指数要按代码搜(搜 nikkei 不出 ^N225) | 可回填多年 |
| **其它** | Eris(SOFR OIS 曲线)/ MOF+JPX(JGB 收益率/JGB VIX;JGB VIX 以 JPX xlsx 为主,CBOE `SPJGBV` 补 JPX 缺的天并兼作备份,补点剔掉日本假日沿用的前值)/ CFTC(日元净持仓 Legacy / VIX 净持仓 TFF)/ Shiller(CAPE) | 混:Eris 日 / MOF 日 / JPX 日 / **CFTC 周** / Shiller 月 | 零;**JPX JGB VIX 用 `fflate`** | 各自 adapter(见 `fetchers/`)| 多为全历史 |
| **EIA** | 周度石油报告:炼厂开工率 / 加工量 + 馏分油产量(→ 收率、同比)/ 馏分油+汽油库存 / 馏分油出口(→ 季节 z)· 馏分油 / 汽油**表观需求** product supplied(`WDIUPUS2` / `WGFUPUS2` → 4 周均同比)· **零售柴油/汽油泵价**(→ 与批发期货减出零售加价) | **周频**(实物八条周三 10:30 ET 发、截止上周五,滞后 ~5 天;**零售两条周一发**,两批右端日期不齐是常态) | 零(要 key) | JSON `api.eia.gov/v2/seriesid/PET.{ID}.W`(要 key)⚠️ 裸 ID 404,必须带 `PET.` 前缀 + `.W` 后缀;`start`/`end`/`data[]` **全被忽略**,唯一生效的裁剪参数是 `length`;返回**倒序**。⚠️ 周频同比用 `yoyPctWeekly`(比 364 天前同一周),别用 `yoyPct`:52 周比一年少一天,会恒取到 53 周前 | 1982 起全历史;**已发布值下周会被修订**(每次拉全量,故不落库) |
| **IMF PortWatch** | 霍尔木兹海峡每日过船数:全部船型 / 其中油轮(AIS 推算,对外发 7 日均 `hormuzTransits` / `hormuzTankers`,能源「油市结构」首格) | 日频(含周末,**约滞后 5 天**) | 零 | ArcGIS FeatureServer `services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services/Daily_Chokepoints_Data/FeatureServer/0/query?where=portname='Strait of Hormuz'`(免 key),见 `fetchers/portwatch`。⚠️ **单页上限 1000 行**,`resultRecordCount` 写更大也只回 1000、只靠 `exceededTransferLimit` 提示 → 先 `returnCountOnly` 取总数再按 1000 并发翻页、最后核对条数;⚠️ 出错照样回 200,错误在 body 的 `error`;⚠️ 载重吨 `capacity_tanker` 小油轮常记 0,只用艘数 | 2019 起全历史;读时现拉、不落库 |
| **ISM(经 PR Newswire)** | 制造业 / 服务业 PMI 头条 + 各自 Prices 分项(`ismMfg` / `ismSvc` / `ismMfgPrices` / `ismSvcPrices`) | **月频**(制造业第 1 个工作日、服务业第 3 个工作日,10:00 ET) | 零 | newsroom 列表页 `prnewswire.com/news/institute-for-supply-management/?page=N&pagesize=M` 按 slug 认月报 → 单篇解析「AT A GLANCE」表(**按行首标签取行,不按行号**)。⚠️ 三代版式都实测过:报告月可能在表头第二行(2021~2023)、年份可能被拆进两个 span 成「202 1」(2020-10~2022-02)、2020 年前服务业叫 NMI;⚠️ 服务业表右半边是制造业对照列,只取前两格 | **落库**(daily `ism` 分组增量;`bun run src/server/jobs/ismSnapshot.ts --backfill` 回填,已回填 2018-01 起)。⚠️ 回填 = 每月「最后一次被发布的读数」拼接:次月那篇带回的上月值会覆盖(1 月季节因子重估由此带回一个月),更早月份不改 —— 非官方修订后全序列。**停更防护**:每轮写完查两个扇区各自最新报告月,落后当前月 >2 个月 → `ism` 记 failed(状态灯红,悬停见原因);只看列表页认不认得出月报挡不住单扇区改名(旧名月报会在第一页挂一年) |
| **FINRA 保证金统计** | 美股版「融资余额」:券商客户保证金账户借方余额 → `marginDebtYoy`(同比 %,「信用 › 杠杆」tab)。表里另有两类客户闲置现金,做过「净杠杆」一格,随市值单边上行、信息与同比重复,已删 | **月频**(次月中旬发,2026-11-14 已有 2026-10) | 零;**用 `fflate`** | xlsx `www.finra.org/sites/default/files/2021-03/margin-statistics.xlsx`(约 20KB,要浏览器 UA),见 `fetchers/finraMargin`。⚠️ 路径里的 2021-03 不是数据时点,文件原地覆盖更新;404 了去 `finra.org/rules-guidance/key-topics/margin-accounts/margin-statistics` 页面找新链接;⚠️ 源**倒序**;按表头名取列 | 1997-01 起全历史(一个文件);读时现拉、不落库 |
| **ICE** | AI 巨头 + 甲骨文 + CoreWeave + SpaceX 单名 CDS EOD 结算价(`iceCds`)· **CDX 北美 IG / HY 指数**主力 5Y 结算价(`ICE_CDX_{IG,HY}`,对外 `cdxIg` / `cdxHy`,读时反解成利差 %;同一 job 顺带存) | 日频 | 零 | 公开 JSON `www.ice.com/api/cds-settlement-prices/icc-single-names` / `icc-indexes`(免 key)。指数 `instrumentName` 形如 `CDX-NAIGS47V1-5Y`:取最高系列、同系列最高版本(成分违约 V1 → V2)的 5Y;欧洲 iTraxx 不接 | **仅当天快照,不可回填**;CDX 2026-11-13 起存,之前约 2 年由 DTCC CFTC 成交回填(见 DTCC 行) |
| **DTCC(SEC 辖区成交披露 SBSR)** | 单名 5Y CDS 成交(`DTCC_CDS_{ticker}`):① 软银集团(→ AI CDS 格的 `SoftBank (JPY)`),ICE 只清算 USD / EUR 计价的欧美名字,日本名字只能走成交披露;② ICE 那几家美国公司 **ICE 开始存数之前**的历史(读时接在 `ICE_CDS_*` 前面,ICE 为准;Apple 成交太稀不补) | 日频,**成交稀**(2026 年约六成工作日有点、2025 年约三成,没成交的日子空着) | 零(zip 用 `fflate`) | `kgc0418-tdw-data-0.s3.amazonaws.com/sec/eod/SEC_CUMULATIVE_CREDITS_YYYY_MM_DD.zip`(免 key,URL 按日期构造),见 `fetchers/dtccCds` + 定价 `analytics/cdsTrades`。⚠️ **成交的前端费含应计票息**,价 = 100 ∓ u − 应计(不扣时比 ICE 系统性低约 3bp);公开数据不带付款方向,按参照价(邻近一天的价;美国公司从 ICE 第一天起锚往前)选方向;换新合约那周同一合约成交分两团,按价位断团取离参照价近的那团(断团门槛随利差放大,高利差名不切)。⚠️ **混着指数交易拆出来的成分腿**:一笔 CDX 指数成交被报成约 125 条「单名」,同一秒、同本金、同前端费,带的是指数的价 —— 同一组横跨 ≥3 家发行人就整批剔(不剔时 2024~2025 年稀疏期的线像乱画)。美国公司**只补成交够密的那段**(之后每个整月 ≥8 天有成交):2026 年前多数名字一年只有几天成交,几个月一个点、多是单笔,不可信。和 ICE 重叠期核对见 `docs/data-sources-candidates.md` §1.1。⚠️ 软银是**日元计价**合约(100bp 票息 + 前端费 `UFRO`),价 = 100 − 前端费%,换算用日元参数(回收率 35%、利率 2%);比同一家的美元 CDS 读数偏低。⚠️ 标识四种写法(RED `JQCEFX*` / ISIN `JP343610*` / 名字),别只匹配 SOFTBANK(会混进软银电信);美国公司按 RED 码前 6 位 / ISIN 前 8 位发行人前缀 + 名字认(名字字段常是债券描述 `NT`,另有一批只写通用的 `XSSNRREFOBL0`),前缀表在 fetcher 里;只收 on-the-run 5Y 到期(3/20、9/20 换新)。⚠️ 2025-11 前的文件表头不带引号。⚠️ `NEWT` 里混着更替(`Event type = NOVA`)/ 压缩(`COMP`),前端费是转让结算款不是市场价,只收 `TRAD`;事后撤销的单(`EROR` 行的 `Original Dissemination Identifier` 指向原成交,常在后几天的文件里)要跨文件收齐再剔,那天因此没有有效成交就删掉库里旧值。⚠️ 文件里混着几年前的补报单,只收披露前 7 天内成交的;偶有前端费明显少报的单(同日同合约两笔差 4 倍、字段全同),读时按「低于前后各 3 点中位数的 80%」只剔低侧、首尾不判(`dropLowPrints`) | **落库**(daily `sbg_cds` 分组只跑软银,每轮重拉最近 14 天覆盖写;美国公司只在回填时补;`bun run src/server/jobs/dtccCdsSnapshot.ts --backfill` 回填,2026-11-13 已回填)。源**滚动约 2 年多**(2026-11 实测最早 2024-09-10),不落库就丢 |
| **DTCC(CFTC 辖区:信用指数成交)** | CDX 北美 IG / HY 主力 5Y 成交(`DTCC_CDX_{IG,HY}`,补 ICE 开始存之前的历史,读时接在 `ICE_CDX_*` 前面) | 日频,每天各几百笔 | 零(zip 用 `fflate`) | `kgc0418-tdw-data-0.s3.amazonaws.com/cftc/eod/CFTC_CUMULATIVE_CREDITS_YYYY_MM_DD.zip`(免 key;指数归 CFTC、单名归 SEC,是同一家的两份文件),见 `fetchers/dtccCdx`。按 `UPI Underlier Name` = `CDX.NA.IG` / `CDX.NA.HY` + `UPI FISN` = `NA/CDS Corp Idx`(带 `Tra` 的是分层、`Swt` 是期权)认;不带系列号,主力按到期日认:IG 与单名同一套 3/20、9/20 换新,⚠️ **HY 晚一周(3/27、9/27)**,按 IG 的日子认会把 HY 换新后头一周整周滤光(`onTheRunExpiry`)。⚠️ **报价写法按指数不同**(`Spread notation-Leg 1`):IG `3` = 小数利差(0.00585 = 58.5bp),HY `1` = 价、`3` = 价 ÷ 10000(0.0106 = 106.2,**不是**利差)。每天取全部成交价中位数;撤销、晚报、拉失败那天的补报同单名规则剔 | **只手动回填**:`bun run src/server/jobs/dtccCdxSnapshot.ts`(2026-11-14 已回填);源滚动约 2.2 年 |
| **DTCC(CFTC 辖区:利率掉期成交)** | 美元零息通胀掉期 1Y / 2Y(`DTCC_ZCIS_{1Y,2Y}` → `zcis1y` / `zcis2y`,补 BEI 没有的短端;通胀 ›「通胀走势」末格) | 日频(工作日通常十几到几十笔,2026-11 实测 1Y 6~43、2Y 9~23;美国假日可能为 0) | 零(zip 用 `fflate`) | `kgc0418-tdw-data-0.s3.amazonaws.com/cftc/eod/CFTC_CUMULATIVE_RATES_YYYY_MM_DD.zip`(免 key,约 1.4MB / 解开 13MB 全币种利率掉期),见 `fetchers/dtccZcis`。按 `UPI FISN` = `NA/Swap Infl Idx USD` + `UPI Underlier Name` = `USA-CPI-U` 认,固定利率可能在 Leg 1 或 Leg 2(小数)。⚠️ **只收即期起息**(起息日在成交日后 0~6 天,**下限也要卡**):混着几个月前起息的老化合约,不剔时 1Y 中位数 2.658% 对真值 2.113%。每天取中位数,不足 3 笔不出点;撤销、晚报、拉失败那天的补报同单名规则剔。同文件里的美元 / 日元 OIS **评估后不接**(见候选文档 §1.3 / §2.0) | **落库**(daily `dtcc_zcis` 分组,每轮重拉最近 14 天覆盖写;`bun run src/server/jobs/dtccZcisSnapshot.ts --backfill`,2026-11-14 已回填)。源滚动约 2.0 年(最早 2024-11-10) |
| **moomoo** | 期权链(股票/ETF/指数:SPY/.VIX) | 日频 | `moomoo-api` | 本地 OpenD WebSocket `127.0.0.1:33333` | **仅当天快照,不可回填** |
| **SEC XBRL** | AI 链公司季报财务(TTM 毛利率/capex/FCF) | **季频** | 零 | 公开 JSON `data.sec.gov`(免 key,**必须带 User-Agent**);submissions 比 filed → 有新申报才拉 companyfacts | 全历史(季频) |
| **Deribit** | 加密期权链(BTC/ETH) | 日频 | 零 | 公开 REST `deribit.com/api/v2/public`(免 key) | 链快照型;但 **DVOL** 波动率指数有历史 |
| **BRK(Bitcoin Research Kit)** | BTC ±5% 已实现供应密度原始日值 `BTC_SUPPLY_DENSITY` → 对外发 7 日均线 `btcSupplyDensity`(Glassnode「Realized Supply Density」免费复刻,Murphy 的「供应集中度」) | 日频 | 零 | 读它**算好的现成序列** `bitview.space/api/series/supply_density/day1`(免 key,一次请求全段),日期取同 index 的 `/api/series/date/day1`(`day1` 下标 = 日历日,0 = 2009-01-01;2010-08-16 前是 null)。口径实读源码确认:`crates/bitview_urpd/src/density_band.rs` 的 [0.95, 1.05] × 收盘价,URPD 价格档 4 位有效数字。开源 MIT:[bitcoinresearchkit/mono](https://github.com/bitcoinresearchkit/mono),个人维护无 SLA(OpenSats 资助到 2027-06);**数据来自它自建的全节点 + 自研链上价格预言机**(2015 前用写死的交易所收盘价)。⚠️ **别回到自算 URPD**:2026-10-30 v0.13.0 删了 `/api/urpd/{cohort}/dates`、URPD 改列式(`buckets: {price, supply, …}`),旧实现当天就断;BRK 1.0 前约 1~2 个月一次破坏性小版本,每版 API 变动 / 序列改名列在 `bitview.space/changes/`。⚠️ 当天 UTC 那点是盘中值:job 每轮**全量覆盖写**,次日自然变收盘值。⚠️ 别用 BGeometrics 的 URPD JSON:只有当天快照、$256 粗档、缺 ~250 万币 | 2012 起全历史(每轮一次拉全、覆盖写库)。2026-10 对账:与以前 log2000 自算值 2017 起逐日中位差 ~0.015pp(2012–13 早年价格源不同,差到数 pp);7 日均线与 Murphy 图逐段吻合,读数偏高 ~0.2–0.3pp |
| **Computable(CGI)** | GPU 算力租赁价指数 `CGI_{H100,H200,B200,B300}`(USD/GPU/小时) | 源 15 分钟 → 我们按 UTC 日聚合 | 零 | 公开 REST `api.getcomputable.com/v1/index/{sku}/history`(免 key,匿名只读)。**采集器与算法开源:[getcomputable/gpu-index](https://github.com/getcomputable/gpu-index)**(Apache-2.0)—— 面板成员、换代生效时间、口径争议全在 CHANGELOG/METHODOLOGY 里,查口径去仓库不要猜。⚠️ `/v1/methodology` 自称窗口 90 天 / 粒度 15 分钟,**两个都不实**(见下) | **滚动窗口,不可回填更早**;2026-09-18 实测 H100/H200 26 天、B200 33 天、B300 39 天 |

**关键差异**:**两个期权源(moomoo + Deribit)的链都是快照型**——25Δ 序列只能从今往后每个
交易日攒一个点,拿不到历史(25Δ 行权价每天滚动,固定合约的历史 IV 无法重建该序列)。
其余源都能回填全历史;Deribit 的 **DVOL**(加密版 VIX)是个例外,带历史可回填。

### 依赖档位(选源时的主要成本项)

| 档位 | 谁 | 说明 |
|---|---|---|
| **零依赖** | FRED · **美国财政部** · CBOE(含日统计认沽认购比) · ICE · **Bitstamp** · **EIA** · SEC · Deribit · MOF · CFTC · Shiller · **NY Fed ACM** · **Nakajima** · **Computable** · **BRK** · **ISM(PRN)** · **BOJ 统计 API** · **e-Stat** · **IMF PortWatch** | `fetch` + 自己解 CSV/JSON/HTML |
| **`fflate`**(已有) | NY Fed HLW · JPX JGB VIX · **BOJ 产出缺口** · **DTCC** · **FINRA 保证金** | `.xlsx` = zip+XML,解 zip 后正则取(公共解包在 `fetchers/xlsx.ts`);DTCC 是 zip+CSV,解开直接按表头取列 |
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
| 日元 OIS 曲线(JSCC) | **JSCC 不发利率**。`irs_toukei_nitiji_{YYYYMMDD}.xlsx` 是**清算统计**(债务负担件数 / 金额,按 0-2Y / 2-5Y / 5-10Y / 10-30Y / 30+Y 分组),不是结算利率;且只挂当天一份(09-09 那份已 404)。→ **另有出路(2026-11)**:DTCC SDR 公开掉期成交里有日元 TONA OIS 的成交价(各主要期限每天几十笔),但只保留约 2 年、要落库,见 `docs/data-sources-candidates.md` §2.0。→ **评估后不接(2026-11-14)**:只用即期起息成交时,日元 OIS 2Y 与 JGB 2Y 六个抽样日只差 −1~+3bp,短端政策预期用现有 `jp2yMinusCall` 即可(早先「差 2~38bp」是混进了老化合约的误判),见候选文档 §2.0 | 下载 2026-09-25 那份解开看(2026-09) |
| 柴油交割地(PADD1)的实物对照 | **源可用但不接** —— `WDISTP11` 端点正常,是**形式**不成立:PADD1 季节 z 与全国 z 相关 **r=0.937**、末值差 0.04、「一破一不破 −2」近两年仅 1.9%,没有增量。想要的判别(裂解爆表时分「交割地真缺货」还是「纸面挤压」)实际几乎不发生 | 拉 780 周实算(2026-09) |
| 炼厂检修日历 | **无免费权威源**(IIR / Genscape 均需订阅)。替代:用已接的 `refUtilZ5y`(开工率季节 z)当代理 —— 检修季开工率会季节性走低,z 扣掉那层后剩下的才是非计划停车 | 商业源官网询价页(2026-09) |
| ↑ 为什么 z 看不见 | PADD1 在**结构性萎缩**,5 年基准跟着降 → z 归零。同日 PADD1 同比 −24.5% 而全国 −8.3%;9 月上旬中位 2015 年 57,687 千桶(占全国 38.2%)→ 2026 年 21,003(20.2%),**十一年缩 64%**。要接只能接**绝对水位**(逼仓看池子多大,与季节偏离无关),而那是慢变量,不值一格周频图 | 同上 |
| BTC 供应密度 / URPD 的**独立于 BRK** 的免费源 | **没有**。Glassnode API 只给 Professional(Advanced 只有 Light API);Newhedge API 要 Pro token;Bitcoin Magazine Pro 要 Professional;CryptoQuant 付费;BGeometrics 免费但粗(见取数总览)。**Newhedge、Checkonchain 自己就是 BRK 下游**(其 README「Used by」),换它们不算独立。唯一真独立 = 自建 `bitviewd`:完整 `blk*.dat`(不能 prune,~700GB+)+ BRK ~290GB + 16GB RAM,本机放不下要外接盘;届时 job 改指 `localhost:3110` 即可 | 各家 API 文档 + BRK 仓库 README(2026-10) |

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
- ⚠️ **VIX 期权的 IV 不可用**(2026-11 查实,Codex 独立复核同结论):moomoo 以 **VIX 现货**为标的算 IV(正确口径是同到期 VX 远期 + Black-76,
  CBOE 即如此),远期偏离现货时 put IV 严重偏低(10-15:行权价 18 的 put moomoo 20.6%、按远期 77.5%);且 daily 触发点大多落在
  VIX 期权夜盘,101 天里只有 15 天 25Δ 附近有正常报价。→ VIX 的 25Δ 改用 CBOE(见下条),moomoo 的 `.VIX` 历史在切换那天整段删
  (`bun run src/server/jobs/repairMoomooOptions.ts --write --drop-vix`)。
- ⚠️ **不计分红**:TLT(年化约 4~5%,每月除息)call IV 偏低约 1pp、put 偏高约 1.3pp,skew 被系统性高估约 2pp。
  历史已按「期限内实际除息」用美式二叉树重算(`jobs/repairMoomooOptions`,source 标 `moomoo-recalc`,2026-11-14 已改 99 天)。
  ⚠️ 切换前 moomoo 每天新写的 TLT 仍没计分红(图上差约 2pp 的台阶),切换那天的 `--write --drop-vix` 会一并重算。
- **CBOE 延迟期权链在并行试跑**(daily `options_cboe` 分组,落库键带 `@cboe` 后缀、不上图;`fetchers/cboeOptions`):
  `cdn-api.cboe.com/api/global/delayed_quotes/options/{代码}.json`(免 key、无文档,指数前加 `_`),一个文件 = 全部到期日、
  带 IV / 希腊值 / OI / 全市场最优买卖价,7 个标的一轮约 5 秒、不用 OpenD。交易日取文件里最后一笔成交的日期。
  与 moomoo 逐合约对比:不分红 ETF IV 差 ≤ 0.2pp、OI 全同。
  ⏰ **待办:2026-11-21 前后(并行满 5 个交易日)验收并切成主源,按 `docs/options-cboe-switch.md` 逐步做**
  (验收脚本 `bun run src/server/jobs/compareOptionsSources.ts`;重点看工作日夜里 VIX 是否仍是收盘报价、USO 偏差)。
- **put delta 为负、call delta 为正**(已用真实链核实)。25Δ 选取依赖这个符号约定。
- **链/快照字段路径**(靠 debug dump 试出来的,非直觉):
  - 静态链:`o.call.basic.security.code`、`o.call.optionExData.strikePrice`
  - 快照:greeks/IV/OI 在 `optionExData`,行情(bid/ask/curPrice/volume)在 `basic`
- **第二档到期日**(标的目录 `secondExpiry`:.VIX / TLT / GLD / USO / IBIT):第一档(~30 天,进 25Δ 表)之外,
  另存**第一个 DTE ≥60 的标准月度**原始链(`option_chain_raw`,25Δ 表不变)。不按「最接近 N 天」挑:常挑中周度
  (实测 GLD 11/13 周度 25Δ call OI 13,12/18 月度 13800)。月度日由 `jobs/monthlyExpiry` 推算再按日查,
  因为月度间隔可达 35 天、而单次链查询跨度 ≤30 天;ETF = 第三个周五,**VIX = 次月第三个周五 −30 天的周三**
  (= VX 结算日,对 2018 起 114 份 VX 到期日:108 份吻合,6 份假日提前一天 → 查询窗口带上前一天)。
  第二档复用第一档的现货;失败记进 failures → 整组 partial → daily 守卫当天重跑(快照型,漏一天补不回)。7 标的一轮约 40 秒(链 12 次、受 3.2s 闸门约束)。
- **请求可能永不返回**:qot 会话悬空时 SDK 的 promise 不 settle(2026-10-17 一个脚本挂了 5.5 小时)。
  `withConnection` 用 Proxy 给 ws 上所有大写开头的请求方法套 `REQUEST_TIMEOUT_MS`(25s)截止,
  超时 reject → finally 断开;直接调 SDK 请求时别绕过 `withConnection`。
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
- **扩标的时的限制**:GetOptionChain 限频 **每 30 秒 10 次**(单次查询的到期日跨度 ≤30 天,
  是窗口宽度、不妨碍查 90 天后的到期日);GetSecuritySnapshot 每 30 秒 60 次、每次最多 **400 个代码**
  (`SNAPSHOT_BATCH=400` 已压线)。`moomooOptions` 用进程级 `rateGate` 排开(链 3.2s / 快照 0.55s 间隔,
  重试也过同一个闸门)。当前 `fetchChain` **每个标的开一条 WebSocket**——
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
- **日线是 08:00 UTC 切的**(交割时刻;12h 线也是 08/20 点对齐),「D 日收盘」= D+1 08:00 的价,与 Yahoo / Glassnode / BRK 的 UTC 0 点口径最多差 6%。**所以 BTC 现货日 K 不用 Deribit**,全段走 Bitstamp(现货、原生 UTC 0 点、2012 起零缺口;见 `jobs/btcPrice`)。DVOL 日线本来就是 UTC 0 点,不受影响。
- **现货价**走 `get_index_price?index_name=btc_usd`(ticker 里的 `underlying_price` 是该到期日远期)。
- **DVOL**(加密版 VIX,带历史):`get_volatility_index_data?currency=BTC&...&resolution=43200`,
  返回 OHLC。目前没接,要做加密波动率历史曲线时用它(对标 SKEW/VX 那种有历史的源)。
- **加密 24/7**,没有"收盘"概念。BTC 期权快照按**抓取时的 UTC 日期**打戳(`getTradingDate`,不跳周末),
  **不是** `lastClosedTradingDate()` —— 改成美股交易日会让周六 / 周日 / 周一早上三份都标周五、互相覆盖。
  ⚠️ 所以 BTC 与 IBIT 的 25Δ **同标签日不可直接比**:BTC 标 D 那份 ≈ IBIT 标 D−1(上一美股收盘日)那份;
  且 BTC 抓取时刻随电脑开机浮动(UTC 02~11 点),Deribit「约 30 天」那档 DTE 在 17~44 天间跳(只挂约 4 周内周度 + 月末)。
  2026-11 实测:同标签日 IV 变化相关 0.05,按抓取时刻对齐(取 IBIT 收盘后第一份 BTC)升到 0.43、skew 水平 0.66。
  两者在 BTC 页分两格、不叠图,故不改标签;要对比时按抓取时刻对齐。

### 其它数据源

- **Yahoo(股票 EOD + DXY/MOVE/油品期货/USD-JPY)**:用 `yahoo-finance2` **v4**(class API `new YahooFinance()`;
  v4 相对 v3 只把最低 Node 提到 22,**API 无变化**)。周末它会返回标着周六/日的快照——用
  `lastClosedTradingDate()` 归到正确的周五,否则 X 轴混入周末。
- **ETF 现货口径(`price_eod`,蜡烛 / EMA / RV 腿 / 攻防比值共用)**:Yahoo `close` = **只调拆股、不调分红**,
  与 TradingView 默认、IBKR `TRADES`、moomoo App 显示同一个数(2026-10 对账 SPY 2026-03-30 OHLC 逐位一致,
  EMA5/20/50 误差 0.000)。**每轮全量重拉**(一次请求即上市日起全段,`PRICE_HISTORY_START_DATE`;长周期均线要够长历史才收敛,周线 EMA365 只从 2018 起算会偏低 ~1.7%):Yahoo 历史会随新拆股整段改写,
  增量续抓会拼出两套基准。**不设降级源**(Yahoo 挂了就记失败、库里保留上一轮整段)。⚠️ 别接回 moomoo 历史 K 线:
  前复权每次除息整段改写历史,增量入库拼出过 06-22 前后差 0.25% + 09-16 单日毛刺;不复权又连拆股都不调
  (USO 2020-04-29 合股 2.13→18.00),不能回填;且其高 / 低偶含场外离谱成交(QQQ 2019-12-03 低 193.78)。
  要分红复权的(回测)走 `fetchAdjDailyBars`(`adjclose`),不读 `price_eod`。
- **MOVE(ICE BofA 债市波动率,走 Yahoo `^MOVE`)**:带 caret,无 caret 的 `MOVE` 是 Movado 股票。
  MOVE 是 ICE 授权指数,FRED / stooq 都没有,GitHub 上的仓库不是用 yfinance 就是 Bloomberg,**没有第二个免费源**。
  坑:Yahoo 的日线 `quotes[].close` 会**整段返回 null**(2026-07-20 起,已用 CNBC 与 TradingView 核对确认值仍在更新),
  但同一响应的 `meta.regularMarketPrice/Time` 仍带当日真值。故 `fetchers/moveIndex` 用 meta 补当天,
  `jobs/moveSnapshot` 把整条序列镜像进 `market_series` 的 `MOVE`,regime 路由读时 **Yahoo 优先、库兜底**
  (`mergeMove`),源自愈后真值自动 upsert 覆盖,**没有删除路径**。断供期 meta 只有当日快照、漏一天永久缺一格,
  故 `move` 失败时当天后续触发点会重跑它(守卫按组判,见 `runPendingGroups`),且成败判据是「本次有没有拿到**已收盘**的 meta 点」(盘中值不落库,见 `isCloseSnapshot`:判的是**当下**——meta 的 ET 日已翻篇、或现在已过 17:00 ET——不看 meta 那一刻几点,故半日市早收不构成特例。取 17 不取 16 是因为 MOVE ~16:34 ET 才定盘)——**不要改成比对交易日历**,
  假日 `lastClosedTradingDate()` 会返回假日当天,导致整天判失败、守卫永远不绿。
- **CBOE(VIX 家族/SKEW/RXM/VX1)**:直接打 API + 下 CSV,**不需要 Playwright**。
- **FRED(利率 / 信用利差 / 流动性 / 通胀)**:免费 key 在 `.env`(`FRED_API_KEY`),不要提交。**油品现货/期货走 Yahoo(`CL/BZ/HO/RB=F`),不是 FRED**;DXY 也走 Yahoo 真 ICE 指数(`DX-Y.NYB`),不用 FRED 的贸易加权 `DTWEXBGS`。
  ⚠️ 限流可能是 **HTTP 200 + JSON 里带 429 错误码**(OpenBB 专门查 payload);`fred.ts` 撞上时会报误导性的 TypeError
  (读 undefined 的 filter),不污染数据(只读过代码,没复现)。亚特兰大联储的序列(sticky CPI / 工资)**保持走 FRED**:
  其官网改版,OpenBB 里所有 atlantafed 直连路径都 404(新前缀 `/-/media/Project/Atlanta/FRBA/Documents/research-and-data/data/...`)。
- **DTCC 公开文件判断在不在必须 GET**(加 Range):HEAD 对已过保留期的文件也回 200,真 GET 才回 403。
  保留期按资产类别不同(利率约 2.0 年、信用约 2.2 年),中间有零星缺天(如 SEC 信用 2024-10-01 回 403)。
- **EIA v2 单次最多返回 5000 行、超了不报警**(日频 `RWTC` 的 `total` 10292 只回 5000)。`offset` 有效、`start` 仍被忽略。
  现有周频序列约 1866 行不受影响,**将来接日频序列必须翻页**。EIA 日频现货在美国联邦假日沿用前一天的值。
- **ICE 单名 CDS(AI 巨头 + 甲骨文 + CoreWeave)**:免费公开端点(无 auth),真 CDS 结算价,不是债券代理/二手抓取。
  几个坑:①端点吐的是**价**(平价 100)不是 spread,读时用 `cdsPriceToSpreadBp` 按标准 CDS 定价反解成 bp(回收率 40%、违约强度恒定、平坦利率 4%、T=5Y,二分;价 ≤ 回收价 40 = 无解 → NaN,路由丢点)。2026-10-16 前是 annuity=4.7 线性近似,离校准点越远越偏低、困境区严重低估,已换掉;
  存库存**原始价**(真值源)。②`instrumentName`(如 `ORCLE.SNRFOR.USD.XR14.100.2031-06-20`)按 ticker 匹配名单,
  **不认 ICE 的 `name` 字段**(有 "Oracle Cop" 等错拼);筛 SNRFOR+USD+**该名配置的票息档**(`AI_CDS[].coupon`,缺省 100bp;CoreWeave 只挂 500bp),同名多到期取最长(on-the-run 5Y)。
  ③价 ≤0 当缺价滤掉(`Number('')→0` 会伪装成 ~2228bp 假数据)。④**仅当天快照、不可回填**,靠 daily 每天攒;
  故 `ice_cds` 失败时当天后续触发点会重跑它(守卫按组判),且默认展示的 core 标的缺任一、或 CDX IG / HY 缺任一,即 job failed 告警(`missingCoreCds` + `CDX_TICKERS`)。
- **Computable GPU Index(算力租赁价)**:公开挂牌价的聚合,**不是成交价**;CoreWeave 在四个面板里占三个,
  所以这条线跟 CRWV 不独立,别拿它给 CRWV 做交叉验证。几个实测坑:
  ①**窗口和粒度都在变,别写死**。文档说 90 天 / 15 分钟,实测 2026-09-18 是 26~39 天(比两周前实测的 17~30 天**更长**),
  粒度改过三档(6h → 1h → 15min)且各 SKU 切换日不同。`limit` 文档写上限 20000,实测 ~2950 才是真上限,取 2880。
  ②**方法论每隔几周换代**(`methodology_id`,如 `h100_sxm_v1_calc_v16`),换代日一天内混两代 id(切换不卡 UTC 日界)。
  已逐日量过 09-03 加席与 09-15 上 EWMA 平滑两次换代:**换代日的变化量小于相邻普通日的变化量**,断点不可识别,
  故**不读 `methodology_id`、不做图上标注**。重查方法见 `fetchers/computableGpu.ts` 顶部注释。
  ③`./reproduce`、collector 那套只对自建索引的人有用,我们是纯 API 消费方,仓库的 commit 大多与我们无关。
- **图表**:用 BusinessDay(字符串日期)压掉周末空隙;跨标的共享 X 轴时先 `dropWeekends()`。
- **lightweight-charts 图元的层级**:要画在 K 线之上(如画线的「置于顶层」),图元必须挂在 series 上(`series.attachPrimitive`)并让 paneView 的 `zOrder` 返回 `'top'`。
  ⚠️ **挂在格子上(`pane.attachPrimitive`)的图元,5.2 根本不读 `zOrder`**:一律在主画布上、先于 series 画,永远被 K 线盖住 ——
  类型文档却写着格级也支持 `'top'`(源码 `PanePrimitiveWrapper` 没实现 top / bottom 分层)。
  `hoveredSeriesOnTop`(lw 默认开)我们已在 `chart/core.ts` 的 `CHART_OPTIONS` 关掉:TradingView 悬停不改层级,开着时鼠标碰到竖线图层它就盖住 K 线。
  若重新打开它,挂靠的 series 要选这一格 `seriesOrder()` 最大的那条、层次一变就换挂:图元被命中时 lw 把挂靠的 series 当悬停源挪到最上层画,挂在别的 series(如背景色带)上,悬停画线时它会整片盖住 K 线。
  验层级时别用和 K 线同色的东西读像素(下跌标签与跌 K 线同为 `#ef4444`,读到红色分不出谁在上);要分画布读:`elementsFromPoint` 里第一块是顶层画布。

## 约定

- 改完代码跑 `bun run check`(= typecheck + `bun test` + `bun run lint`)。lint 是 **Biome**(lint + format 二合一,
  `react-hooks/exhaustive-deps` 为 error;带 `--error-on-warnings`,有 warning 也算失败)。因 typescript-eslint 不支持项目用的 TS7,
  lint 用 Biome/oxlint 这类 Rust 工具(不依赖 typescript 包)。**不要自动 git commit**,等用户发话。
- `git push` 前 `.githooks/pre-push` 自动跑 `bun run check`,不过就拦下(`bun install` 时 `prepare` 脚本设 `core.hooksPath`,
  已设过别的值则不覆盖;临时跳过用 `--no-verify`)。⚠️ 它检查的是**工作区**,不是要推送的提交 —— 工作区不干净时会提示。
- 注释用中文。声明式优先于命令式 `for` 循环。
- **目录按「纯计算 / 业务」划界,业务再按视角(路由)分**:纯计算放 `web/chart`、`shared/calc`、
  `server/analytics`、`server/backtest`(允许循环);前端业务里跨视角复用的视图放 `web/views/`,
  只属于某个视角的 tab 定义 / regime 配置(`docs.ts`,每个 tab 一份 ChartDoc,与图表编辑器同一格式)/ 组件放 `web/pages/<视角>/`。业务代码禁循环由 Biome 插件
  `biome-plugins/no-loop.grit` 按目录执行(范围见 `biome.jsonc`):计算逻辑夹在业务文件里就拆进计算目录,别加 `biome-ignore`。
- **UI 组件库:shadcn/ui**(base-nova 风格,底层 Base UI `@base-ui/react`),组件源码在 `src/web/components/ui/`(拷进来归自己,可改),
  类名合并 `cn` 在 `src/web/lib/utils.ts`(clsx + tailwind-merge),颜色变量在 `styles.css` 的 `@theme inline`(映射到 neutral 色阶)。
  **明暗主题**(顶栏切换,`hooks/theme.ts`):浅色 = `:root[data-theme="light"]` 把 neutral 色阶整条翻成暖白、几档强调色换深色号,
  所以写界面**只用 `neutral-*` 表达明暗层级,别写 `white` / `black`**(不会翻);画布(lightweight-charts)读不到 CSS 变量,
  颜色走 `chartThemeOptions`,新建图的地方要并上它并在主题变化时 `applyOptions`。加组件:`bunx shadcn@latest add <名字>` 后**检查 styles.css 是否被塞进 `:root` 变量 / `body` 全局样式**,有就删掉(有意保留的只有 `:root { color-scheme: dark }`(原生控件靠它取深色)和 `:root[data-theme="light"]` 浅色色阶块)、
  缺的变量照现有写法补进 `@theme`;组件里的图标占位换 lucide。⚠️ CLI 实测会:把 `cn` 写成 `from "cn"` 并装 npm 上同名的无关包
  (改回 `@web/lib/utils`、`bun remove cn`)、漏装 `class-variance-authority`、多装 `date-fns`(react-day-picker 自带)。
  ⚠️ 组件里的 `dark:` 分支要**拍平成基础类**:`dark:` 变体恒定生效(浅色靠翻色阶,不靠 `dark:`),而 `dark:x` 与调用方传的同属性类 tailwind-merge 判不出冲突、
  CSS 里 `dark:` 排后面总是赢,调用方的激活色就盖不掉(见 `ui/button.tsx` 顶部)。`md:text-sm` 这类响应式变体同理(会盖掉调用方的 `text-xs`),也拍平。
  ⚠️ 模板按新版 Base UI 写,对不上已装的 1.9:①`data-vertical:` / `group-data-horizontal/…` 匹配不上(1.9 只输出 `data-orientation`),
  要改写成 `data-[orientation=…]:`;②tabs / toggle-group 的 `orientation` 只写进 `data-orientation`、没传给 Base UI(竖排键盘导航和 aria 都错)。
  加完组件在浏览器里量**激活 / 悬停 / 禁用 / 展开**各态的计算样式,别只看能不能点。手写组件正在分批迁到组件库。
- **有意锁死版本的依赖**(package.json 写不了注释,记在这里,别顺手改成 `^`):`@biomejs/biome` —— lint 带
  `--error-on-warnings`,新的小版本若新增 / 升级 warning 规则,代码没动也会让 check 和 pre-push 失败;两个 Grit 插件也只在这个版本测过,
  升级前先跑 `bun test biome-plugins`。`@base-ui/react` —— shadcn 模板跟着
  Base UI 版本写,自动升级可能悄悄弄坏组件样式(1.9 就和模板的 `data-vertical` 对不上),升级要手动做并在浏览器里过一遍组件;
  `fancy-canvas` —— 必须和 `lightweight-charts` 依赖的版本完全一致(升 lightweight-charts 时一起核对),否则装出两份、类型对不上。
- **`bun audit` 剩下的只有 `moomoo-api › protobufjs@6`**(1 critical + 若干 high):修复在 7.x,moomoo-api 锁 `^6.8.8`,
  跨主版本强改可能弄坏期权解析、且本机没 OpenD 验证不了 → **不修**;风险低(只解析 moomoo 自己的固定协议、只连本机 OpenD)。
  等 moomoo-api 升 protobufjs。yahoo-finance2 自带的 MCP SDK 链(express / qs / body-parser 等)上的漏洞,修复版都在上游声明的
  范围内,lock 已刷到修复版,不需要 `overrides`;再报出来就 `bun update <直接依赖>` 刷 lock,别加全局 overrides(它会悄悄压住
  以后其它依赖要的别的主版本)。
- 秘密只在 `.env`(gitignored):`FRED_API_KEY`、`EIA_API_KEY`、`ESTAT_APP_ID`、`MOOMOO_WS_*`、`SEC_USER_AGENT`(SEC 要求真实联系方式)。
