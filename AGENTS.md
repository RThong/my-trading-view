# my-trading-view — agent 指南

个人用的美股市场状态监控盘(类 TradingView)。**Bun + TypeScript 全栈**(前后端都是 TS),
不要引入 Python 工具链。EOD 天级数据,本地单机跑,SQLite 单文件 `data/mtv.db`。

## 取数方式总览

| 源 | 内容 | 方式 | 历史 |
|---|---|---|---|
| **CBOE 指数** | VIX 家族 / SKEW / RXM | **静态 CSV 直下**:`cdn.cboe.com/api/global/us_indices/daily_prices/{指数}_History.csv`(无需 key,免爬虫) | 1990 至今全历史 |
| **CBOE VX 期货** | VX 近月连续(存为 `VX1`) | API 列清单(`www-api.cboe.com/.../product/list/VX/`)+ `cdn.cboe.com/{path}` 下 CSV | 全历史 |
| **FRED** | 利率(UST/TIPS)/ 信用利差(HY+IG 梯队)/ 流动性(WALCL/TGA/RRP/SOFR/IORB)/ 通胀(BEI=DGS−DFII、Sticky CPI、薪资) | JSON API `api.stlouisfed.org/fred/series/observations`(要 key) | 全历史 |
| **Yahoo** | 股票 EOD + **DXY(`DX-Y.NYB` 真 ICE 美元指数)/ MOVE(`^MOVE`)/ 油品期货(`CL=F`/`BZ=F`/`HO=F`/`RB=F`)/ USD/JPY** | `yahoo-finance2` **v4** npm(class API `new YahooFinance()`) | 可回填多年 |
| **其它** | Eris(SOFR OIS 曲线)/ MOF+JPX(JGB 收益率/JGB VIX)/ CFTC(日元净持仓)/ Shiller(CAPE) | 各自 adapter(见 `fetchers/`)| 多为全历史 |
| **moomoo** | 期权链(股票/ETF/指数:SPY/.VIX) | 本地 OpenD WebSocket `127.0.0.1:33333` | **仅当天快照,不可回填** |
| **Deribit** | 加密期权链(BTC/ETH) | 公开 REST `deribit.com/api/v2/public`(免 key) | 链快照型;但 **DVOL** 波动率指数有历史 |

**关键差异**:**两个期权源(moomoo + Deribit)的链都是快照型**——25Δ 序列只能从今往后每个
交易日攒一个点,拿不到历史(25Δ 行权价每天滚动,固定合约的历史 IV 无法重建该序列)。
其余源都能回填全历史;Deribit 的 **DVOL**(加密版 VIX)是个例外,带历史可回填。

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
- **CBOE(VIX 家族/SKEW/RXM/VX1)**:直接打 API + 下 CSV,**不需要 Playwright**。
- **FRED(利率 / 信用利差 / 流动性 / 通胀)**:免费 key 在 `.env`(`FRED_API_KEY`),不要提交。**油品现货/期货走 Yahoo(`CL/BZ/HO/RB=F`),不是 FRED**;DXY 也走 Yahoo 真 ICE 指数(`DX-Y.NYB`),不用 FRED 的贸易加权 `DTWEXBGS`。
- **图表**:用 BusinessDay(字符串日期)压掉周末空隙;跨标的共享 X 轴时先 `dropWeekends()`。

## 约定

- 改完代码跑 `bunx tsc --noEmit` + `bun test` + `bun run lint`(**Biome**:lint + format 二合一;
  `react-hooks/exhaustive-deps` 为 error)。因 typescript-eslint 不支持项目用的 TS7,lint 用 Biome/oxlint
  这类 Rust 工具(不依赖 typescript 包)。**不要自动 git commit**,等用户发话。
- 注释用中文。声明式优先于命令式 `for` 循环。
- 秘密只在 `.env`(gitignored):`FRED_API_KEY`、`MOOMOO_WS_*`。
