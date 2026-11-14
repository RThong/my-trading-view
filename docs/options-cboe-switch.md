# 期权数据源切换清单:moomoo → CBOE 延迟期权链

> 状态:**并行试跑中**(2026-11-14 起)。预计 **2026-11-21 前后**(满 5 个交易日)做验收与切换,约 2~3 小时。
> 背景与核对结论:`AGENTS.md` 的 moomoo 段、`docs/data-sources-candidates.md` §1.4。
> 改本机定时任务(第 4、7 步)前先问用户。
>
> ⚠️ **这是指引,不是逐字执行的脚本**:切换时对照实际状态做,切换当天的代码改动照常跑一轮 `code-review`。
> **切换时再问用户定的两件事**:① 第 4 步停掉定时任务后要不要再 `VACUUM INTO` 备份一次(第 1 步到第 4 步之间若碰上触发点,新写入的不在第 1 步的备份里);
> ② 若 VIX 工作日夜里拿到的是夜盘报价(见第 3 步),是 7 个标的整体等 VIX 方案落地、重新并行验收后再一起切,还是其余 6 个先切。

## 现在的样子

- daily 有两个期权分组:`options`(moomoo,主源,上图)和 `options_cboe`(CBOE,落库键带 `@cboe` 后缀,不上图)
- moomoo 的两个已知问题:
  - **VIX**:按现货算 IV(该用同到期远期),约八成快照抓在夜盘 → 历史基本不可用,切换时整段删
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
- skew 差的**中位数**:SPY / QQQ / GLD / USO / IBIT ≤ 0.3pp,TLT ≤ 0.5pp(个别日子超线不卡;moomoo 个别天没数只标注,
  某标的 5 天里 moomoo 一天都没有 = 无法对照,判失败)
- VIX 不比差(moomoo 值不可用),只看 CBOE 的 VIX 原始链:最后成交 = 快照日当天且**不晚于美东 16:15:59**(晚了 = 混进夜盘)、
  平值附近(|delta| 0.2~0.5)价差中位数 ≤ 30%
  —— **重点**:daily 的触发点(JST 11/12/20/21/22)全部落在 VIX 期权夜盘(美东 20:15 ~ 次日 09:15),工作日的样本才说明问题

已知要盯的:**USO** 第一天(11-13)就差 −0.72pp。约 30 天那档 USO 翼上流动性薄(25Δ 附近有效报价的合约只有十几个),
两边报价稍有不同就选到不同合约。若中位数持续超线:先看两边是不是选中了不同行权价;确认是流动性噪声而非口径问题时,
可放宽 USO 的线并在这里记下理由(别为它改选取口径 —— 见记忆 options-25delta-scales-with-iv)。

**不通过**:哪项不达标就查哪项,别切。

**VIX 那项的决策(用户 2026-11-14 定)**:先看工作日夜里 CBOE 文件里 VIX 合约的最后成交时间与价差 ——

- **文件停在常规时段收盘(最后成交 ≤ 16:15:59、价差正常)** → 什么都不用改,照常切换
- **文件跟着夜盘更新** → 先别切 VIX,二选一后再切(把两边实测结果给用户看,让用户选):
  1. **iPhone 快捷指令**:个人自动化,工作日 JST 08:00(= 美东收盘后、夜盘前;冬令 18:00 / 夏令 19:00)「获取 URL 内容」下 `_VIX.json`
     存到 iCloud Drive 固定文件夹;Mac 的 job 优先读它(校验最后成交是当天收盘),否则回退自己下的那份。
     背景:用户的 Mac 早上没网(手机热点不开),所以不能给 Mac 加早上的触发点;要实测锁屏时自动化会不会跑
  2. **用 `prev_day_close` 自算**:文件里每个合约带前一交易日收盘价,用它 + Black-76(远期由收盘价平价反推)自己反解 IV。
     11-13 实测该算法与 CBOE 给的 IV 差约 0.5pp;要先确认夜盘期间 `prev_day_close` 是刚结束那个常规时段的收盘价
     (Black-76 要重新实现:`analytics/optionPricing.ts` 现只有美式二叉树;11-13 的验证记录见 `docs/data-sources-candidates.md` §1.4)

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
bun run src/server/jobs/repairMoomooOptions.ts --write --drop-vix
```

删 moomoo 的 `.VIX` 25Δ 历史(并行期间 moomoo 若又写了 TLT,也一并重算)。

再把 `@cboe` 行提升为正式名字(先删同标的同日的 moomoo 行再改名,否则撞主键;2026-11-14 已在内存库上验证过):

```
sqlite3 data/mtv.db <<'SQL'
.bail on
PRAGMA busy_timeout=30000;
BEGIN;
DELETE FROM option_snapshot_25delta AS m WHERE m.underlying NOT LIKE '%@cboe'
  AND EXISTS (SELECT 1 FROM option_snapshot_25delta c WHERE c.underlying = m.underlying || '@cboe' AND c.snapshot_date = m.snapshot_date);
UPDATE option_snapshot_25delta SET underlying = replace(underlying, '@cboe', '') WHERE underlying LIKE '%@cboe';
-- 原始链按「标的 + 日期」整天删(两边同一天选中的到期日可能不同,按到期日删会留下两份混在一起)
DELETE FROM option_chain_raw AS m WHERE m.underlying NOT LIKE '%@cboe'
  AND EXISTS (SELECT 1 FROM option_chain_raw c WHERE c.underlying = m.underlying || '@cboe' AND c.snapshot_date = m.snapshot_date);
UPDATE option_chain_raw SET underlying = replace(underlying, '@cboe', '') WHERE underlying LIKE '%@cboe';
-- 并行分组下线后,它在 job_run 里的最后一条会一直挂在状态灯上
DELETE FROM job_run WHERE job_name = 'options_cboe';
COMMIT;
SQL
```

(`.bail on`:任一句出错就停,不会把改了一半的提交掉;`busy_timeout`:com.mtv.crypto 那个定时任务没停,可能同时在写。)

结果:并行日全部是 CBOE;更早的天 ETF 保留 moomoo(两边一致)、TLT 保留重算值;VIX 从 2026-11-13 起全是 CBOE。
并行日 moomoo 的原始链只留在备份文件里;更早日子 moomoo 的原始链保留存档。

## 第 6 步:切代码

- `jobs/daily.ts`:`options` 分组改用 `createCboeOptionsClient()`、source `'cboe'`、不加后缀(`runOptionsGroup` 对 cboe 自动开 `strictTradingDate`);删掉 `options_cboe` 分组;
  删掉文件头为静音 moomoo-api SDK 输出写的那段
- `fetchers/cboeOptions.ts`:给 `.VIX` 加一道**收盘报价守卫** —— 链里最后成交晚于交易日美东 16:15:59、或平值附近价差中位数 > 30% 就抛错。
  只 VIX 失败、其余成功时整组记 partial(状态灯黄),当天后续触发点会重跑;不写库、不存夜盘数。写单测
- 删除:`fetchers/moomooOptions.ts`、`moomooClient.ts`、`moomooHistoryKL.ts`(其中 `Bar` 类型被 `bitstampBtcHistory` / `jobs/btcPrice` / `jobs/vrpInputs` 引用,先挪到别处)、
  `jobs/repairMoomooOptions.ts` + `analytics/optionPricing.ts`(一次性修复用,跑完即无用)、`jobs/compareOptionsSources.ts`(验收用)、以上各自的测试
- 清理残留:`biome.jsonc` 里指向 moomoo 测试文件的 override;`shared/marketCatalog.ts` 的 `optionSource: 'moomoo'` 与 `config.ts` 的 `optionUnderlyings('moomoo')`(改成 `'cboe'`);
  `config.ts` / `jobs/tradingCalendar.ts` / `optionsSnapshot.ts` 里提到 moomoo 的注释;`package.json` 的 `job:daily:opend` 脚本(指向下一步要改名的脚本);
  `.env.example` 的 `MOOMOO_*` / `OPEND_CMD` 说明;本地 `DATA_SOURCES.md`(gitignore)里列的 moomoo fetcher;
  `AGENTS.md`「关键差异」段的「两个期权源(moomoo + Deribit)」;`docs/data-sources-candidates.md` 速查表第 6 行与 §1.4 的「备份 / 并行试跑中」改成已接
- **全仓库搜残留要清零**:`grep -rni moomoo src scripts AGENTS.md .env.example`。允许保留:`storage/db.ts` 迁移里的默认值 `'moomoo'`、`web/chart` 里「对齐 moomoo App 口径」的注释。
  ⚠️ 特别是 `shared/marketCatalog.ts`:`optionSource` 的类型联合里要**删掉** `'moomoo'`(只加 `'cboe'` 不删的话 typecheck 不报错,但 `cboeIvLegs()` 按 `'moomoo'` 过滤,
  VRP 的隐含腿 VXN / GVZ / OVX / VXTLT 会悄悄消失)
- `bun remove moomoo-api`(`bun audit` 剩的 protobufjs 漏洞随之消失;`AGENTS.md` 约定段那条删掉)
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

- `bun run check`;浏览器看期权页 7 个标的(VIX 那格从 11-13 起)、跑 `code-review`、提交
- 更新记忆 `options-data-source`;把本文件状态改成「已完成」或删掉
