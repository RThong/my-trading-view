# AI 链基本面 —— 交接

这条线的目标:给「AI 资本开支还能不能持续」这个判断提供**客观读数**,而不是叙事。
两条判据,口径完全不同,**绝不能混**:

- **买方(云厂商)**:§6.14「capex 会不会吃穿现金流」→ 看 FCF **会不会转负**,不看水平。
- **卖方(芯片/代工/设备)**:稀缺溢价 → 看毛利率**相对自身中枢的趋势**,不设硬阈值。

卖方 FCF 在涨价周期里极大(实测 NVDA+MU 一度垫 +1290 亿),**混进买方合计会把零轴永远垫在下方,
判据直接失效**。这是 `isAggregateMember`(buyer 且 inChain)存在的唯一理由。

---

## 名单与源(`src/shared/aiChain.ts`)

| ticker | side | group | 币种 | sources | 格子 |
|---|---|---|---|---|---|
| NVDA / AMD | seller | accelerator | USD | sec | gm capex fcf fcfq |
| MU | seller | upstream | USD | sec | 同上 |
| TSM | seller | upstream | **TWD** | **sec6k + twse** | 同上 + revM revYoy |
| ASML | seller | upstream | **EUR** | **sec6k** | 同上 |
| INTC | seller | **watch** | USD | sec | 同上 |
| MSFT ORCL GOOGL AMZN META | buyer | cloud | USD | sec | 同上 |

**一家可以走多个源** —— 各测度的最佳来源本来就不同。四处按源查表分派,漏一处是编译错误:
`SOURCE_KINDS` / `SOURCE_NEEDS` / job 的 `RUNNERS`+`ADAPTERS` / 面板的 `SOURCE_PANES`。

三个源:

- `sec` — data.sec.gov **companyfacts**(XBRL)。多数美国公司。
- `sec6k` — FPI 交给 EDGAR 的**季报 6-K**,解析 HTML。TSM / ASML。
- `twse` — 台湾证交所 OpenAPI **月营收**。只有 TSM。

### 为什么 TSM / ASML 非走 6-K 不可

**外国私人发行人(FPI)豁免 10-Q**,季报以 6-K 提交且**不强制 XBRL 标记**。
实测带 XBRL 的季报 6-K:TSM 0/13,ASML 0/46(只有 2017 年试过两份)。
所以 companyfacts 对这两家只有年频 —— **季度数据存在,但只以 HTML 形式存在**。
ADR 不改变这一点(ASML 在 Nasdaq、TSM 在 NYSE,都从没有过 10-Q)。

---

## 时效阶梯

```
                     期末→申报    我们跟上   合计
ORCL                  10~22 天     ≤1 天    11~23
MU/GOOGL/NVDA/MSFT/   21~37                 22~38
META/AMZN/INTC
AMD                      39                    40
TSM 毛利率            **T+16**(财报稿)         ← 财报稿只给营收+毛利
TSM FCF/capex         **T+45**(合并报表)       ← 台湾证交法 45 日法定期限
TSM 月营收            **T+10**(TWSE)          ← 全链最快
ASML 四科目全部       **T+16~17**              ← 四个一起到,无错位
```

**我们那一段对每家都是 ≤1 天**(job 天天跑,水位比 filed)。慢在第一段,那是法条与公司习惯。

---

## 各家该怎么读(面板 `COMPANY_NOTES` 里有完整版)

- **NVDA / AMD** 同组,毛利率**可横向比** —— 同批客户同波需求,差距即定价权差距。
  AMD 抬升先于 NVDA 回落 = 客户接受第二供应商。
- **MU** 毛利率 = DRAM/NAND 价格周期的免费代理。读「在自身周期哪个位置」,不跨公司比高低。
- **TSM** 月营收(T+10)是全链最快、已发生的出货;转弱先于 NVDA 季报体现。
- **ASML** ⚠️ **别照 NVDA 那套读毛利率** —— 垄断,长期稳在 50~54%,「见顶回落」判据对它无效。
  有信息量的是营收(出货)与 capex(它自己扩产)。**2026 起停发净订单**(最后一次 2025Q4),
  领先指标没了。单季 FCF 摆动极大(2026Q1 −2,588 → Q2 +1,404 百万欧元)是**营运资本节奏**,
  不是 capex 吃现金流 —— 形状像,成因完全不同。
- **INTC** ⚠️ **不是判据成员**(`inChain=false`,在 watch 组)。它的毛利率是**供给侧读数**,
  符号与稀缺溢价**相反**(修复 = 新产能进场)。它的 capex 是自建晶圆厂,绝不进买方合计。

---

## 踩过的坑(都是实测,别再踩)

### 口径 / 算法

1. **跨 tag 不比 filed**。filed 解决版本(重述),tag 解决经济口径,不能一个比较器裁决。
   实测 AMZN FY2016:`PaymentsToAcquirePropertyPlantAndEquipment` 6.737B(filed 2017-02-10)
   vs `PaymentsToAcquireProductiveAssets` 7.804B(filed 2019-02-01)——后者是**另一个口径**。
   → 链序裁口径,`periodsForTag` 内同 tag 取 filed 最大裁版本。

2. **换 tag ≠ 换口径,得量**。全量测过 21 组重叠期:17 组差额恰好为 0。
   NVDA capex 换 tag 三期差额全 0(尽管行文写作 "and intangible assets");AMZN 真差 +15.8%。

3. **AMZN capex 无可选项** —— 2017-03-31 后不再披露纯 PP&E tag。故用 `CAPEX_SCOPE_EXPECTED`
   声明已知状态,**只在偏离声明时报警**;不可比本身写进面板文案。永久黄灯会把真信号淹掉。

4. **ocf 用总额优先,不是持续经营优先**。试过反过来(为对齐只含持续经营的 capex),更糟:
   持续经营那个 tag「有终止经营才报」,AMD 的 Q1 就没有 → 同一差分组里换基础。
   代价:AMD FY2025 FCF 虚高 1.216B(终止经营 OCF),写在 `COMPANY_NOTES.AMD`。

5. **恰好为 0 不进派生**(你自己那个 commit)。ORCL 2009 的 CostOfRevenue 是占位 0,
   真实成本在 CostOfServices 下 → 吞掉一季 → 毛利率虚高且不报错。

### 6-K 解析

6. **单季起始日**:不能按「季末月−2 的 1 号」硬算 —— **13 周财季的季末不落在月末**
   (ASML 是 2021-07-04 这种)→ 算出 64 天的「季度」被长度判据丢掉,**静默少了 22 期里的 9 期**。
   → 取「上一期期末的次日」,断档 >120 天退回「期末 − 91 天」。

7. **假期末**:老申报的 `reportDate` 有时就是申报日本身。TSM 三份老财报稿
   (2023-07-20 / 2023-10-19 / 2024-01-18)因此以假季末落库,打乱 TTM 四季跨度,吃掉两个毛利率点。
   → 判据 `reportDate !== filingDate`。

8. **列序两家相反**:TSM 本期在**第 1 列**,ASML 在**第 2 列**。取错不会报错,只会静默错一年。
   → ASML 用报表**自己印的毛利率**做自校验(算出来对不上就抛),22 份全部通过。

9. **同一家换过表格编码**:ASML 2025Q1 及更早是单元格式,2025Q2 起整份无 `<table>`、
   数字与标签同处一个文本块。→ `numsAfter`(整格判定,TSM 用)与 `numsInRow`(按词判定,ASML 用)
   两个提取器。TSM 不能用后者:它的行标签后跟着「(Notes 20, 31 and 37)」会被拆成数字样。

10. **标签撞进散文**:TSM 财报稿里「Gross profit」先命中指引句
    「Gross profit margin is expected to be between 65% and 67%」,一路扫到表格里 Net sales 的值,
    算出 cogs = 0。→ 锚在「(Unit: NT$ million)」表头之后 + 距离上限 + 「毛利不小于营收就抛」。
    **这个 bug 是新加的比对守卫当场抓到的,不是看出来的。**

11. **单位**:TSM 报表**千元**、TSM 财报稿**百万**、ASML **百万**。差 1000 倍且静默。
    → 每个解析器先校验表头单位字样,不符就拒绝解析。

12. **PP&E 在投资段出现两次**(购置/处置),必须锚在 `INVESTING ACTIVITIES` 之后。

### 口径 / 算法(续)

14. **融资租赁取得的产能不进 `ocf − capex`,而且不是延后、是永远不来**。取得时非现金(不进 capex)、
    本金还款走**筹资活动**、只有利息进经营。所以一家把采购改成融资租赁,当年 FCF 就无偿好看一整笔。
    (经营租赁不同:付款全额走经营 → OCF 吃掉 → FCF 迟早反映,只是平滑延后。)
    实测新增 ROU / **同财年**现金 capex:**MSFT 21.2%**(246/1,159 亿,财年止 2026-06-30)、
    ORCL 8.9%(另有经营租赁新增 182 亿 = capex 的 33%)、AMZN 2.3%、GOOGL 1.8%、META 0.9%。
    **MSFT 两个财年前还是 1~2%,是新出现的。**
    → 合计约 358 亿,对当时买方合计 TTM FCF **+1,259 亿**(六季从 +2,232 亿掉下来,约 −250 亿/季),
    相当于**把零轴穿越提前约 1.4 个季度**。**不翻符号 → 只做偏离声明式守卫
    (`FINANCE_LEASE_SHARE_CEILING`)+ 面板量化文案,没做成第二条线。**
    不做序列还有第二个理由:**画不出干净的线** —— ORCL 只有 FY 与 9M、一个季度数都没有,
    META 断在 2025-12-31;合计线要求每季每家都有点,做出来只能静默丢掉 ORCL 或连出假斜率(见坑 13)。

15. **量存量还是量流量,差一个数量级**(上一条里差点掉进去的)。拿 `FinanceLeasePrincipalPayments`
    (本金支付,MSFT 最近财年 31 亿)去比年度 capex,得出「2.7%,是噪声」—— **错的**:
    本金支付只反映**旧租约**的现金流,而这批租约是新签的、还没开始还。要用**新增 ROU**(246 亿)
    比年度 capex,才是同量纲。守卫因此锚在新增 ROU 上,函数注释里写了原因,别改回去。

### 画法

13. **折线只连点,断档必造假斜率**。月营收是快照攒的(中间空 11 个月),用折线画出过一条
    不存在的匀速上升。→ 离散期间量一律**柱状**(`RENDER_BY_KIND`),连续滚动量才用折线。
    路由的 `TRIM_GAPS` 判据是「用折线还是柱状」,不是「来自哪个源」,两处必须一致。

---

## 运维

```
com.mtv.sec   天天 13:00 / 19:00   → src/server/jobs/aiChainFundamentals.ts
   ├── sec_fundamentals   companyfacts,9 家
   ├── sec6k_reports      TSM + ASML
   └── twse_revenue       TSM 月营收
```

**三个源各记一条 job_run** —— 一条挂了不该把另两条弄黄,而且健康含义不同
(SEC 稳态是全 skip 算成功,TWSE 一个月才动一次)。

单跑:`bun run src/server/jobs/aiChainFundamentals.ts [--force] [TICKER...]`
— 指定 TICKER 时没被指到的源整个跳过,不记空 run。

**基本面是可回填源**,断网一天只是晚一天知道,不丢数据(区别于期权链/CDS 那种快照型)。
2026-08-07 两次触发都撞上本机 DNS 故障(`ENOTFOUND`),补跑即恢复。

### 核对手法(每次加公司必做)

1. 对新闻/公告的黄金值(营收、毛利率)
2. 跨源对账 —— TSM 的 TWSE 月营收累计 vs 6-K 季报,实测差 0.8M(财报稿舍入)
3. 自洽性 —— Q1 + Q2 = H1(验的是两份不同申报能不能拼上)
4. **查库**:`sec_fundamentals` 的行数/期末列表、派生序列的点数与起止
   —— 上面第 6、7 两个 bug 都是这一步发现的,不是想出来的

---

## 待办

- **未推送 24 个 commit**(从没 push 过,你没要求过)
- **2026-08-14 前后**:TSM 的 Q2 合并报表会自动进来,补上它的 FCF/capex,
  并触发「财报稿 vs 报表」的比对守卫(差超 0.5% 报警)
- **SK 海力士**:2026-07 才在美上市。它的 6-K 只有营收与营业利润、**没有营业成本**,
  算不出毛利率。等它交第一份季度合并财报 6-K 后可照 ASML 那条路再试;否则要韩国 DART 的免费 key
- **设备层还缺 AMAT / LRCX / KLAC**(都是 10-Q 报送方,能走 sec 源)。但它们毛利率长期稳定,
  信息量在**营收同比** —— 要给 `SOURCE_KINDS.sec` 加一档 kind,不是加新源
- **ORCL 毛利率**永久空着(`KNOWN_GAPS`)—— **查过了,结论是别做**,理由记在这里免得再起念头:
  - 技术上**能做且不用新源**:`parseXbrlInstance` + `filingInstance` 已经能读原始实例(DERA ZIP 那条路可以废掉),
    只差三处 —— 命名空间硬编码成 `us-gaap:`、`TAG_CHAINS` 是「取第一个有值的」而这里要**求和**、
    兜底分支只在 companyfacts 落后时才跑。`submissions.recent` 有 42 份定期报告回到 2016-03,不用翻分页。
  - 组件名分三代(每财年抽样实测):2026Q1 起 `orcl:CloudAndSoftwareExpenses`+`HardwareExpenses`+`ServicesExpense`;
    2019Q3~2025 第一项叫 `CloudServicesAndLicenseSupportExpenses`;≤2018 完全另一套(5 项、混
    `us-gaap:CostOfServices`/`CostOfServicesMaintenanceCosts`)。2019-09 起才有 inline XBRL(`_htm.xml`)。
  - **没有可对账的总额**:现代 ORCL 连「总成本」小计都不印。2018Q3 是唯一同时有 extension 组件和
    `us-gaap:GrossProfit` 的重叠期,量下来 **对不上**(营收 9,771 − 印的毛利 5,968 = 隐含成本 3,803,
    而全部直接成本组件只有 2,002)→ 那个 tag 对 ORCL 不是「营收 − 直接成本」。**做不出 ASML 那种自校验**,
    只能退回「三个组件必须全齐否则不出数」。
  - **但它不该做**:ORCL 是 buyer,判据是 FCF(`REQUIRED_CONCEPTS_BY_SIDE.buyer` 里没有 cogs),
    毛利率是配角格;而且 `CloudAndSoftwareExpenses` 把**云与许可支持混在一条**,那条线会随业务结构变化而动,
    **答不了「OCI 的折旧有没有吃掉云毛利」这个真问题**。成本:+60 请求/季、新增求和语义与命名空间机制。
    换来一个既非判据、又答不了问的格子 → 不做。真要 ORCL 的读数,看它已有的 capex/FCF(TTM FCF 已 −23.7B)。
- 曾提过没做:DB 备份(13.4MB 不可再生的快照数据)、TSM 月营收历史回填(MOPS 反爬)

---

## 约定

- **不要自动 commit**,明确说了才提交
- 中文回答,专有名词首次出现括号标英文 + 先给大白话
- 秘钥只进 `.env`(gitignored),不硬编码;`SEC_USER_AGENT` 必填否则 SEC 403
- 声明式优先、表驱动代替分支、注释解释「为什么」而非「做了什么」
