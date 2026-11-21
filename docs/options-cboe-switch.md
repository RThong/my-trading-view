# 期权数据源切换清单:moomoo → CBOE 延迟期权链

> 状态:**⏸ 暂停**(2026-11-20 用户定)。CBOE 延迟期权接口 2026-11-19 起被 Cloudflare 拦(不带 `Referer: https://www.cboe.com/` 一律 403;同一天 GitHub 上多个项目同报,无官方说明),本机 `options_cboe` 和存档的 CBOE 部分都在失败。
> **2026-11-21 用户定加 `Referer`**:本机 `fetchers/cboeOptions` 与存档 `fetch.sh` 都已带上,试跑恢复(Actions 上 7 个标的全通)。
> 已定要切(2026-11-21 用户拍板,最早约 11-27 验收通过后)。风险照记:`Referer` 是对方有意设的门槛,随时可能加码;加码后只剩放弃 CBOE 一条路(VIX 25Δ 没有来源;期权留 moomoo 在本机跑)。
> Yahoo 期权链不能替代:没有希腊值,收盘后 IV 是占位值、买卖价 / OI 全 0(2026-11-20 实测)。
> 原计划:并行试跑(2026-11-14 起),满 5 个交易日后验收与切换,约 2~3 小时。
> 背景与核对结论:`AGENTS.md` 的 moomoo 段、`docs/data-sources-candidates.md` §1.4。
> 改本机定时任务(第 4、7 步)前先问用户。
> ✅ ~~切换前先改代码~~ **2026-11-21 已补**:VIX 缺可用存档且本机不在收盘后、夜盘前时不抓(`jobs/cboeArchive` 的 `guardVixNightSession`),见第 3 步末。
>
> ⚠️ **这是指引,不是逐字执行的脚本**:切换时对照实际状态做,切换当天的代码改动照常跑一轮 `code-review`。
> **切换时再问用户定的两件事**:① 第 4 步停掉定时任务后要不要再 `VACUUM INTO` 备份一次(第 1 步到第 4 步之间若碰上触发点,新写入的不在第 1 步的备份里);
> ② ~~VIX 夜盘~~ **已定(2026-11-17)**:实测工作日夜里文件跟着夜盘更新(见第 3 步「VIX 那项的决策」),用户选 **GitHub Actions 存档**;
> 若到切换时 Actions 的 VIX 存档还没验收过,**其余 5 个先切**(SPY 2026-11-20 起不抓,原为 6 个),VIX 等存档验收后再切(用户定)。

## 现在的样子

- daily 有两个期权分组:`options`(moomoo,主源,上图)和 `options_cboe`(CBOE,落库键带 `@cboe` 后缀,不上图)
- moomoo 的两个已知问题:
  - **VIX**:按现货算 IV(该用同到期远期),约八成快照抓在夜盘 → 历史基本不可用(连走势也不行:11-13~19 五天 skew 在 −64 ~ +67 间跳,CBOE 稳定在 −53 ~ −63)。
    切换时**不删、只隐藏**(2026-11-21 用户定):改名成 `.VIX@moomoo`,不上图、留在库里;**不能当 CBOE 断了时的备用**
  - **TLT**:不计分红 → skew 高约 2pp。2026-11-14 前的历史已重算(source `moomoo-recalc`);并行期间 moomoo 每天新写的 TLT 仍未修正
- 两张期权表的主键**不含 source**(`option_snapshot_25delta`:标的 + 日期;`option_chain_raw`:标的 + 日期 + 到期日)

## 第 1 步:备份

```
sqlite3 data/mtv.db "PRAGMA busy_timeout=30000; VACUUM INTO 'data/mtv-pre-cboe-switch.db'"
sqlite3 data/mtv-pre-cboe-switch.db "PRAGMA integrity_check"   # 应输出 ok
```

(库是 WAL 模式,别用 `cp`:会漏掉还没写回主文件的事务。备份文件名以 `.db` 结尾,被 `.gitignore` 的 `data/*.db` 忽略。)

## 第 2 步:重算并行期间的 TLT

```
bun run src/server/jobs/repairMoomooOptions.ts --write
```

只改 TLT(不加 `--drop-vix`):把并行期间 moomoo 新写的、没计分红的 TLT 重算掉 —— 否则第 3 步拿它和 CBOE 比必然差约 2pp、过不了线。

## 第 3 步:验收

```
bun run src/server/jobs/compareOptionsSources.ts
```

脚本看最近 5 个并行日(并行开始以来 SPY 日线有收盘的交易日 —— 取自独立的源,moomoo / CBOE 哪边整天缺都查得出),最后一行 ✅ 才继续:

- 每个标的每个并行日都要有 CBOE 的行(CBOE 整轮失败的日子也会因此被查出来)
- skew 差的**中位数**:QQQ / GLD ≤ 0.3pp,USO / IBIT ≤ 0.8pp(见下「USO / IBIT 口径差」),TLT ≤ 0.5pp(SPY 2026-11-20 起不抓链,不验;个别日子超线不卡;moomoo 个别天没数只标注,
  某标的 5 天里 moomoo 一天都没有 = 无法对照,判失败)
- VIX 不比差(moomoo 值不可用),只看库里那天 `.VIX@cboe` 的 25Δ 行 **`fetched_at` 落在 `archiveUsable` 窗口**(交易日 21:30 ~ 次日 00:15 UTC,
  即收盘后、夜盘前抓的,实际就是 Actions 存档写的);缺行判失败。2026-11-21 起脚本已按这个判
  (原先看「最后成交 ≤ 16:15:59 + 平值价差 ≤ 30%」:夜里文件的报价 / IV 跟着夜盘走、成交时间却停在收盘前,拦不住,见下面实测)

已知要盯的:**USO** 第一天(11-13)就差 −0.72pp。约 30 天那档 USO 翼上流动性薄(25Δ 附近有效报价的合约只有十几个),
两边报价稍有不同就选到不同合约。若中位数持续超线:先看两边是不是选中了不同行权价;确认是流动性噪声而非口径问题时,
可放宽 USO 的线并在这里记下理由(别为它改选取口径 —— 见记忆 options-25delta-scales-with-iv)。

**USO / IBIT 口径差(2026-11-21 定)**:两边每天偏同一个方向 —— USO skew 差 −0.3~−0.7(CBOE 的 put IV 低 0.5~0.8)、
IBIT +0.2~+0.6(CBOE 的 call IV 低 0.6~0.8),是两家 IV 算法(远期 / 借券成本等)不同,不是流动性噪声。
用户定:**接受切换那天约 0.5pp 的台阶,旧历史不平移**,验收线放到 0.8 只用来挡「抓坏了」。

**2026-11-21 首次跑**(窗口 11-16~20):全部 ❌,原因都已知 —— 11-20 CBOE 被拦整天缺(要等 5 个干净交易日,约 11-27 后);
VIX 只有 11-17 / 11-19 是收盘后抓的(存档定时 11-19 才上);TLT 差 3.4(第 2 步还没跑);USO 0.58 / IBIT 0.43(见上)。

**不通过**:哪项不达标就查哪项,别切。

**实测结论(2026-11-17,周二 JST 19:59 = 美东 05:59)**:**文件跟着夜盘更新**。最后成交全在周一 16:14:50 前、价差中位 11%
(两条硬线都会判过),但隔 1 分钟再拉,1540 个合约里 192 个买卖价变了、指数现价 23.48 ≠ 周一收盘 22.91 —— 报价与 IV 都是夜盘的,
**上面两条硬线拦不住它**。`prev_day_close` 也对不上周一最后成交(674 个里只 71 个相等),含义未定。
→ 用户选的不是下面两条,而是 **GitHub Actions 存档**(手机是 Pixel,快捷指令那条不成立):私有仓库 `RThong/market-snapshots`
的 `fetch.sh` 在美东收盘后、夜盘前定时(见其 `snapshot.yml`)抓 7 个标的的链 + ICE CDS / CDX,只留 14 天;
本机 `options_cboe` 先把存档写进库(`jobs/cboeArchive`,抓取时刻不在 `archiveUsable` 窗口的存档各标的一律不收),
已覆盖的「标的 | 交易日」本机不再抓。验收脚本的 VIX 项已改成看 `fetched_at`(见上)。
✅ **2026-11-21 已补本机闸门**:存档没写上那天的 VIX 时,本机实抓前先过 `jobs/cboeArchive` 的 `guardVixNightSession` ——
不在 `archiveUsable` 窗口(收盘后、夜盘前)就不抓 VIX、该标的记失败(整组 partial —— 存档写好的标的算进成功数,只缺 VIX 也是黄灯;当天后续触发点再试),其余标的照抓;
`daily.ts` 的 `options_cboe` 组已套上。ponytail:周五晚到周日没有夜盘、文件仍是周五收盘,也一律拦(靠存档)。

以下是原定的决策框架(用户 2026-11-14 定),留作背景 ——

- **文件停在常规时段收盘(最后成交 ≤ 16:15:59、价差正常)** → 什么都不用改,照常切换
- **文件跟着夜盘更新** → 先别切 VIX,二选一后再切(把两边实测结果给用户看,让用户选):
  1. **iPhone 快捷指令**:个人自动化,工作日 JST 08:00(= 美东收盘后、夜盘前;冬令 18:00 / 夏令 19:00)「获取 URL 内容」下 `_VIX.json`
     存到 iCloud Drive 固定文件夹;Mac 的 job 优先读它(校验最后成交是当天收盘),否则回退自己下的那份。
     背景:用户的 Mac 早上没网(手机热点不开),所以不能给 Mac 加早上的触发点;要实测锁屏时自动化会不会跑
  2. **用 `prev_day_close` 自算**:文件里每个合约带前一交易日收盘价,用它 + Black-76(远期由收盘价平价反推)自己反解 IV。
     11-13 实测该算法与 CBOE 给的 IV 差约 0.5pp;要先确认夜盘期间 `prev_day_close` 是刚结束那个常规时段的收盘价
     (当时 `analytics/optionPricing.ts` 只有美式二叉树;2026-11-21 起已有 Black-76 远期 delta `black76Delta`(Deribit 用),反解 IV 仍要另写;11-13 的验证记录见 `docs/data-sources-candidates.md` §1.4)

## 第 4 步:停掉 daily 定时任务(问用户)

切换过程中旧代码的 `options` 组若触发,会以 moomoo 写回 VIX / 没计分红的 TLT,盖掉刚提升的 CBOE 行。
`cron.sh off`(= `launchctl disable`)只设「不许加载」的标记,**不卸载已经加载着的任务**,所以还要卸载:

```
./scripts/cron.sh off
launchctl bootout gui/$(id -u)/com.mtv.daily
launchctl print gui/$(id -u)/com.mtv.daily   # 应报「找不到服务」,确认已卸载
```

## 第 5 步:切数据

```
bun run src/server/jobs/repairMoomooOptions.ts --write
```

并行期间 moomoo 若又写了 TLT,一并重算。**不加 `--drop-vix`**:moomoo 的 `.VIX` 历史改名隐藏(见下面 SQL 第一段),不删。

再把 `@cboe` 行提升为正式名字(先删同标的同日的 moomoo 行再改名,否则撞主键;2026-11-14 已在内存库上验证过):

```
sqlite3 data/mtv.db <<'SQL'
.bail on
PRAGMA busy_timeout=30000;
BEGIN;
-- moomoo 的 VIX 先整段改名隐藏(不上图、不删),下面提升 @cboe 时才不会和它撞主键 / 被当成要删的 moomoo 行
UPDATE option_snapshot_25delta SET underlying = '.VIX@moomoo' WHERE underlying = '.VIX';
UPDATE option_chain_raw SET underlying = '.VIX@moomoo' WHERE underlying = '.VIX';
DELETE FROM option_snapshot_25delta AS m WHERE m.underlying NOT LIKE '%@%'
  AND EXISTS (SELECT 1 FROM option_snapshot_25delta c WHERE c.underlying = m.underlying || '@cboe' AND c.snapshot_date = m.snapshot_date);
UPDATE option_snapshot_25delta SET underlying = replace(underlying, '@cboe', '') WHERE underlying LIKE '%@cboe';
-- 原始链按「标的 + 日期」整天删(两边同一天选中的到期日可能不同,按到期日删会留下两份混在一起)
DELETE FROM option_chain_raw AS m WHERE m.underlying NOT LIKE '%@%'
  AND EXISTS (SELECT 1 FROM option_chain_raw c WHERE c.underlying = m.underlying || '@cboe' AND c.snapshot_date = m.snapshot_date);
UPDATE option_chain_raw SET underlying = replace(underlying, '@cboe', '') WHERE underlying LIKE '%@cboe';
-- 并行分组下线后,它在 job_run 里的最后一条会一直挂在状态灯上
DELETE FROM job_run WHERE job_name = 'options_cboe';
COMMIT;
SQL
```

(`.bail on`:任一句出错就停,不会把改了一半的提交掉;`busy_timeout`:com.mtv.crypto 那个定时任务没停,可能同时在写。)

结果:并行日全部是 CBOE;更早的天 ETF 保留 moomoo(两边一致)、TLT 保留重算值;VIX 从 2026-11-13 起全是 CBOE;moomoo 的 VIX 整段(含并行日)在 `.VIX@moomoo` 下(不上图)。
并行日 moomoo 的 ETF 原始链只留在备份文件里(VIX 的在库里 `.VIX@moomoo` 下);更早日子 moomoo 的原始链保留存档。

## 第 6 步:切代码

- `jobs/daily.ts`:`options` 分组改用 `createCboeOptionsClient()`、source `'cboe'`、不加后缀(`runOptionsGroup` 对 cboe 自动开 `strictTradingDate`);删掉 `options_cboe` 分组;
  删掉文件头为静音 moomoo-api SDK 输出写的那段
- VIX 夜盘闸门已有(`guardVixNightSession`,2026-11-21):`options` 分组改用 CBOE 时**照样套上**(连同存档写库 `ingestArchivedOptions`,去掉 `@cboe` 后缀)。
  别再按「最后成交 ≤ 16:15:59 + 价差」做守卫 —— 拦不住夜盘(见第 3 步实测)
- 删除:`fetchers/moomooOptions.ts`、`moomooClient.ts`、`moomooHistoryKL.ts`(`Bar` 类型已于 2026-11-18 挪进 `bitstampBtcHistory`)、
  `jobs/repairMoomooOptions.ts`(一次性修复用,跑完即无用)、`jobs/compareOptionsSources.ts`(验收用)、以上各自的测试;
  ⚠️ `analytics/optionPricing.ts` **不能整个删**:2026-11-21 起 `fetchers/deribitOptions`(`black76Delta`)与 `analytics/fxImpliedVol`(`normCdf`)在用,只删美式二叉树那部分
- 清理残留:`biome.jsonc` 里指向 moomoo 测试文件的 override;`shared/marketCatalog.ts` 的 `optionSource: 'moomoo'` 与 `config.ts` 的 `optionUnderlyings('moomoo')`(改成 `'cboe'`);
  `config.ts` / `analytics/tradingCalendar.ts` / `optionsSnapshot.ts` / `fetchers/optionsChain.ts` 里提到 moomoo 的注释;`package.json` 的 `job:daily:opend` 脚本(指向下一步要改名的脚本);
  `.env.example` 的 `MOOMOO_*` / `OPEND_CMD` 说明;本地 `DATA_SOURCES.md`(gitignore)里列的 moomoo fetcher;
  `AGENTS.md`「关键差异」段的「两个期权源(moomoo + Deribit)」;`docs/data-sources-candidates.md` 速查表第 6 行与 §1.4 的「备份 / 并行试跑中」改成已接
- **全仓库搜残留要清零**:`grep -rni moomoo src scripts AGENTS.md .env.example`。允许保留:`storage/db.ts` 迁移里的默认值 `'moomoo'`、`web/chart` 里「对齐 moomoo App 口径」的注释。
  ⚠️ 特别是 `shared/marketCatalog.ts`:`optionSource` 的类型联合里要**删掉** `'moomoo'`(只加 `'cboe'` 不删的话 typecheck 不报错,漏改的 `config.ts` `optionUnderlyings('moomoo')`
  会悄悄返回空清单、期权一个都不抓;`cboeIvLegs()` 按 `!== 'deribit'` 过滤,不受影响)
- `bun remove moomoo-api`(`bun audit` 剩的 protobufjs 漏洞随之消失;`AGENTS.md` 约定段那条删掉)
- 删代码是用户定的(2026-11-21):CBOE 以后若加码拦死、要换回 moomoo,从 git 历史恢复(约 1 小时),中间漏的天补不回
- 本地 `.env` 的 `MOOMOO_*`、`OPEND_CMD` 不再需要
- `AGENTS.md`:取数总览 moomoo 行换成 CBOE 期权;moomoo 踩坑段压成一段「已下线(2026-11)」,保留 VIX / TLT 两个坑的结论;删掉并行试跑那条待办

## 第 7 步:改定时任务脚本并恢复(问用户)

`scripts/daily-with-opend.sh` **不只是**拉起 OpenD:它跑完 job 后还跑 `scripts/export-csv.sh`,并且只在 launchd 下(`XPC_SERVICE_NAME == com.mtv.daily`)
跑 `scripts/backup-db.sh` —— **iCloud 备份只有这一个入口**。所以:

1. 只删掉脚本里 OpenD 那部分(启动 / 等端口 / qot 会话探测 / 自愈重启),保留「跑 job → 导出 CSV → launchd 下备份」;改名为如 `scripts/daily-run.sh`
2. 改 `scripts/gen-cron.sh` 里写死的脚本路径(plist 由它生成,头部写着「勿手改」)
3. **先** `./scripts/cron.sh on`(任务处于 disable 状态时加载不进来),**再**跑 `scripts/gen-cron.sh`(它自带 bootout + bootstrap 重载)
4. `./scripts/cron.sh status` 确认已加载;手动跑一次前先删掉今天 `options` 组的成功记录 —— daily 会跳过「今天已成功过的组」,
   切换当天旧代码(moomoo)的 `options` 多半已经成功,不删的话手动 run 会直接跳过新的 CBOE 组:
   ```
   sqlite3 data/mtv.db "DELETE FROM job_run WHERE job_name = 'options' AND status = 'success' AND date(started_at, 'localtime') = date('now', 'localtime')"
   ./scripts/cron.sh run
   ```
   看日志里 `options` 组成功、有 CSV 导出和备份
- `scripts/gen-cron.sh` 生成 plist 时带的 `OPEND_READY_TIMEOUT` 等 OpenD 环境变量一并去掉
- 停掉常驻的 headless OpenD 进程(`daily-with-opend.sh` 用 nohup 拉起后不杀,账号登录一直挂着):`pkill -f OpenD.app/Contents/MacOS/OpenD`;
  `vendor/` 下的 OpenD 本体可删(gitignore,见记忆 opend-vendor-reinstall)
- moomoo App 本身不用卸(下单照常用)

## 第 8 步:收尾

- `bun run check`;浏览器看 6 个切换标的(期权页 QQQ / VIX / TLT / GLD / USO + BTC 视角的 IBIT;VIX 那格从 11-13 起)、跑 `code-review`、提交
- 更新记忆 `options-data-source`;把本文件状态改成「已完成」或删掉
