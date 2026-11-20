# 方案:库放 GitHub、由 Actions 跑 daily

> 状态:**已定做**(2026-11-19 用户定,不做「本机跑完再上传」的过渡方案)。还没动手;moomoo 那组要等 CBOE 切换(下面限制 1)。
> ⚠️ my-trading-view 是**公开仓库**:workflow 与 Release 都不能放这里(公开仓库的 Release 人人能下,库里有授权数据,Actions 日志也公开)。
> 放私有仓库(倾向直接用 `market-snapshots`:已有 cron-job.org 触发),checkout 公开的 my-trading-view 代码来跑。
> 起因:真实库只在家里那台电脑,公司电脑是空库;本机常关机 / 没网,快照型数据漏一天补不回。

## 想要的样子

- **只有 Actions 一处写库**:在私有仓库加定时 workflow(装 Bun → 跑 `daily` / `cryptoDaily` → 库压缩后传成 GitHub Release 附件,每次覆盖)。
- **本机只读**:看板启动时下载最新的库;家里、公司看到同一份,本机不再跑 launchd。
- 库是累积的:每天传的是「旧数据 + 今天」的整份新库,覆盖上传不丢历史,跑一年就是一年的全部数据。
- 做成后 `RThong/market-snapshots` 里存原始文件那层(`fetch.sh` + `data` 分支、本机再写库)可以撤掉:Actions 本来就在收盘后跑;仓库本身留着放 workflow 和 Release。

## 已定的取舍

- **不用 git 提交存库**:SQLite 是二进制,每次提交存一整份,仓库越滚越大;单文件 > 100MB 被拒。
  Release 附件单个上限 2GB、覆盖不累积。Git LFS 免费额度 1GB 存储 / 月流量 1GB,每个版本都算,不用。
- **不能两台电脑都写库再上传**:后传的整份盖掉先传的。写库只在 Actions。
- **留备份**:每天覆盖之外,每周(或每月)另存一份带日期的 Release —— 某天任务把库写坏了(bug / 写一半被杀),能退回去。
- **体积估算**(未核实):大头是 `option_chain_raw`(每天十几条、每条几十 KB),一年约一两百 MB,加其它序列估计几百 MB 以内。

## 限制 / 要先解决的

1. **moomoo 期权只能在本机跑**(要连本机 OpenD,moomoo 把远程 IP 登录判为风险)→ 先按 `docs/options-cboe-switch.md` 切到 CBOE 主源(计划 2026-11-21 前后),之后就没有必须在本机跑的组。
2. ~~**API key 放 GitHub Secrets**~~ → 2026-11-19 已配 `FRED_API_KEY` / `SEC_USER_AGENT` / `DART_API_KEY`(定时任务只用这三个;EIA / e-Stat 是读时现拉,不用放)。
3. ~~**云 IP 可能被部分源拦**~~ → **2026-11-19 实测全通**:在 Actions(美国弗吉尼亚、微软 IP)用空库真跑 `daily` / `cryptoDaily` / `aiChainFundamentals`,带上 Secrets(`FRED_API_KEY` / `SEC_USER_AGENT` / `DART_API_KEY`,已配在 `market-snapshots`),除 moomoo 外所有组都拉到了(SEC 季报 partial 是空库缺分部历史 + 一次 SEC 502,不是被拦)。三个任务共约 2.5 分钟。Binance 回 451,但它是读时现拉、跑在本机看板,不受影响;其它读时现拉的源(JPX / FINRA / 内閣府 / MOF 等)同理不用测。
4. **额度**:私有仓库免费每月 2000 分钟。2026-11-19 实测三个任务一轮约 2.5 分钟(按分钟向上取整约 3 分钟),一天两轮(主 + 补)约 6 分钟,每月约 200 分钟,够用。
5. **触发时刻**:GitHub 自带 `schedule` 在 `market-snapshots` 从没触发过,要靠 cron-job.org 调 `workflow_dispatch`(见其 README「触发」;现有 token 只授权这个仓库,workflow 放这里就直接在 cron-job.org 加任务)。现在 launchd 是 JST 11/12/20/21/22 多点触发 + 「当天成功即止」守卫;Actions 这边至少排主 + 补两个点。
   快照型的组(期权链、ICE、MOVE)要在美东收盘后、VIX 夜盘前跑(见 `jobs/cboeArchive` 的 `archiveUsable`)。
6. **本机看板怎么拿库**:启动时下载、之后定时刷新?下载期间不能让正在读的连接读到半个文件(先下到临时文件再原子改名)。
7. **数据健康页 / 状态灯**读的是 `job_run`,库换成 Actions 写的那份后照常能看,但「最近一次运行」变成 Actions 的时刻。

## 下一步

1. ~~量库大小~~ → 2026-11-19 量过,很小,Release 附件可行。
2. ~~家里能不能拉存档~~ → 2026-11-20 家里查存档成功。
3. ~~外部触发~~ → 2026-11-19 22:07 UTC 第一次外部触发成功,`2026-11-19T2207Z` 11 个文件齐全(23:17 那轮只补 ICE,同设计)。

三件都过了。等 CBOE 切换(11-21 前后)后动手:先拿一个零依赖的组(如 `vx_term_structure`)在 Actions 上跑通「下载库 → 跑组 → 上传」,再放开全部组。
