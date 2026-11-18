# 方案:库放 GitHub、由 Actions 跑 daily

> 状态:**待定**(2026-11-18 提出,还没动手)。回家先做「下一步」那三件,再定做不做。
> 起因:真实库只在家里那台电脑,公司电脑是空库;本机常关机 / 没网,快照型数据漏一天补不回。

## 想要的样子

- **只有 Actions 一处写库**:在本仓库加定时 workflow(装 Bun → 跑 `daily` / `cryptoDaily` → 库压缩后传成 GitHub Release 附件,每次覆盖)。
- **本机只读**:看板启动时下载最新的库;家里、公司看到同一份,本机不再跑 launchd。
- 库是累积的:每天传的是「旧数据 + 今天」的整份新库,覆盖上传不丢历史,跑一年就是一年的全部数据。
- 做成后 `RThong/market-snapshots`(收盘后存原始文件、本机再写库)这一层可以撤掉:Actions 本来就在收盘后跑。

## 已定的取舍

- **不用 git 提交存库**:SQLite 是二进制,每次提交存一整份,仓库越滚越大;单文件 > 100MB 被拒。
  Release 附件单个上限 2GB、覆盖不累积。Git LFS 免费额度 1GB 存储 / 月流量 1GB,每个版本都算,不用。
- **不能两台电脑都写库再上传**:后传的整份盖掉先传的。写库只在 Actions。
- **留备份**:每天覆盖之外,每周(或每月)另存一份带日期的 Release —— 某天任务把库写坏了(bug / 写一半被杀),能退回去。
- **体积估算**(未核实):大头是 `option_chain_raw`(每天十几条、每条几十 KB),一年约一两百 MB,加其它序列估计几百 MB 以内。

## 限制 / 要先解决的

1. **moomoo 期权只能在本机跑**(要连本机 OpenD,moomoo 把远程 IP 登录判为风险)→ 先按 `docs/options-cboe-switch.md` 切到 CBOE 主源(计划 2026-11-21 前后),之后就没有必须在本机跑的组。
2. **API key 放 GitHub Secrets**:`FRED_API_KEY`、`EIA_API_KEY`、`ESTAT_APP_ID`、`SEC_USER_AGENT`(见 AGENTS.md 末条)。
3. **云 IP 可能被部分源拦**:已在 Actions 实测能拉的:CBOE 期权链、Deribit、Yahoo(`^MOVE`)、ICE。其余逐个试,重点:PR Newswire(ISM)、JPX、FINRA(要浏览器 UA)、内閣府、MOF、DTCC S3、Binance(美国 IP 回 451,Actions 机房多在美国 → **大概率不行**)。
4. **额度**:私有仓库免费每月 2000 分钟;daily 估计每天几分钟(DTCC 要下 zip 偏慢),每月约 300 分钟以内,待实测。
5. **触发时刻**:现在 launchd 是 JST 11/12/20/21/22 多点触发 + 「当天成功即止」守卫;Actions 定时会延迟、偶尔丢,也要多排几个点。
   快照型的组(期权链、ICE、MOVE)要在美东收盘后、VIX 夜盘前跑(见 `jobs/cboeArchive` 的 `archiveUsable`)。
6. **本机看板怎么拿库**:启动时下载、之后定时刷新?下载期间不能让正在读的连接读到半个文件(先下到临时文件再原子改名)。
7. **数据健康页 / 状态灯**读的是 `job_run`,库换成 Actions 写的那份后照常能看,但「最近一次运行」变成 Actions 的时刻。

## 下一步(回家做)

1. `ls -lh data/mtv.db`,再按表看大小:`sqlite3 data/mtv.db "SELECT name, SUM(pgsize)/1e6 AS MB FROM dbstat GROUP BY name ORDER BY 2 DESC LIMIT 10"` —— 决定 Release 附件是否可行。
2. 家里那台的 `git ls-remote git@github.com:RThong/market-snapshots.git` 能不能通:不通就加 `git config --global url."git@github-hong:RThong/".insteadOf "git@github.com:RThong/"`(公司电脑 2026-11-18 已加),否则存档同步一直失败、照旧自己抓。
3. 确认 Actions 定时触发恢复了:`market-snapshots` 的 `data` 分支出现 `YYYY-MM-DDT22xxZ` 目录(修复后第一次定时是 2026-11-18 22:07 UTC)。

三件都没问题,再定做不做;做的话先拿一个零依赖的组(如 `vx_term_structure`)在 Actions 上跑通「下载库 → 跑组 → 上传」,再逐组试云 IP。
