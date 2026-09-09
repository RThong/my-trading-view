# 日本散户日元头寸：接入 TFX 取引所 USD/JPY 売買別建玉 —— 交接文档

> 面向接手实现的 session。**本文自包含**，不需要读产生它的那次对话。
> 状态：仅方案 + 已核实的取数结论，未动任何代码。写于 2026-09-09。
> 起因：面板的日元拥挤度只有 CFTC 一条，而 CFTC 只覆盖海外投机那一半。

---

## 0. 为什么要接（先说清楚它不是「更多同类数据」）

现有 `cftcJpy` 是 CME 日元期货的 non-commercial 净持仓 = **海外投机**。
日本散户完全不在内，而两者**站在对立面**。

统一成「日元头寸」（正 = 净多日元）后的实测（2026-09-01 同日）：

| 桶 | gross | 日元头寸 | 我们有吗 |
|---|---|---|---|
| CFTC 海外投机 | 4.08 兆円 | **−1.15 兆（净空日元）** | ✅ 已有 |
| **TFX 取引所散户** | 1.37 兆円 | **+0.47 兆（净多日元）** | ⬜ 本文要接 |
| FFAJ 店頭散户 | 8.26 兆円（2025-12） | +0.16 兆（2025-12） | ⬜ backlog，见 §6 |

海外投机净空日元、日本散户净多日元。**只看 CFTC 永远只讲一半。**

⚠️ 上表的 gross / 净头寸是为了说明量级而现算的，**不是要在面板上复现它**。
面板上不做单位统一（见 §3），所以这些数字只用于「值不值得接」的判断，别当实现目标。
另：TFX 那两个数是低估的，原因见 §2 的单位坑；`USD/JPY` 单独那条不受影响。

**范围决定：只取 `USD/JPY` 一对。** 文件里有 33 对，我们那格 `日元 carry` 本来就是 USD/JPY，
且只取一对就绕开了跨货币对求和必须换算的问题（见 §2）。

---

## 1. 数据源（已实际下载核实，2026-09-09）

### 活的 URL

```
https://www.click365.jp/resorces/doc/weekly_sellbuy.xls
```

| | |
|---|---|
| 内容 | 33 个货币对，每对 **売り / 買い** 两列 |
| 频率 | **周频**（每周二收盘的数据，次周二发） |
| 覆盖 | **198 周**，最老 `11/22/2022` → 最新 `09/01/2026` |
| 格式 | `.xls` **BIFF8**（OLE 复合文档），117 KB，单 sheet `w_sellbuy` |
| 结构 | 201 行 = 3 行表头 + 198 行数据；67 列 |
| 鉴权 | 无，免 key |

表头三行（列 0 是日期）：

```
row 0:  ''       USD/JPY  ''      EUR/JPY  ''     …   ← 货币对，跨两列合并
row 1:  日付      売り      買い     売り      買い   …
row 2:  date     sell     buy     sell     buy   …
row 3+: 09/01/2026  348500  143481  29987  10936  …   ← 数据，日期降序
```

实测 `2026-09-01` 的 `USD/JPY`：**`sell 348500` / `buy 143481`**（单位见 §2）。

### ⚠️ 有个同名僵尸 URL，别用

```
https://www.tfx.co.jp/mkinfo/document/fx_sellbuy.xls   ← 不要用
```

同结构、同字段、`200 OK`、看起来完全正常，但**数据停在 2012-05-07**
（Excel 序列 41033，之后全是空的日期占位行）。搜索引擎先命中的是这个。

---

## 2. 三个已踩过的坑

### ① 文件里的数是「枚」，不是通貨；而 `枚 → 通貨` 按货币对不同

单位表见 [click365 商品概要](https://www.click365.jp/about_fx/about_fx02.html)：

| 取引単位 | 货币对 |
|---|---|
| **1 万通貨** | **USD/JPY** · EUR/JPY · GBP/JPY · AUD/JPY · CHF/JPY · CAD/JPY · NZD/JPY · TRY/JPY · PLN/JPY · CNH/JPY + 全部非日元交叉 |
| **10 万通貨** | ZAR/JPY · NOK/JPY · HKD/JPY · SEK/JPY · MXN/JPY · HUF/JPY · CZK/JPY + 全部**ラージ** |

**`USD/JPY` = 1 万通貨 / 枚。** 只取这一对 → 不需要任何换算，直接存原始「枚」。

⚠️ 别顺手做跨货币对求和。里拉/日元的**枚数**是全场第一（`buy 1,852,026`），
但 1 里拉 ≈ ¥3.19，换成名义额只有 `+0.058 兆円`、排第 4。不换算就求和会得出「散户在猛买里拉」的假结论。

### ② 列会随时间增删 —— 按表头名字取，绝不按列号

`KRW/JPY` 与 `CNY/JPY` 在 2012 年那版文件里有（KRW 的単位还是 1000 万通貨），
现在**已从文件里消失**。反过来 `CNH/JPY`（离岸人民币）是后加的。

按列号硬编码会在下一次上下架时静默错位。**先在 row 0 找 `'USD/JPY'` 拿到列号 `c`，
则 `c` = 売り、`c+1` = 買い。**

### ③ 有 ラージ 合约，本次刻意不取

文件里有 `USL/JPY`（米ドル・日本円ラージ，10 万通貨 / 枚）。
实测 `2026-09-01`：`sell 87 / buy 67` 枚 = 1,540 万 USD ≈ `0.024 兆円`，
是 USD/JPY 主约（`0.758 兆円`）的 **约 3%**。

不影响读数，故跳过。**若日后要加，记得它的単位是 10 万不是 1 万**，
两条不能直接相加成「枚」，要先各自换成通貨。

---

## 3. 存储：必须落库，且不统一单位

### 为什么必须落库（这是本次唯一的硬约束）

`AGENTS.md` 的规矩是「可回填全历史 → 读时现拉零存储；不可回填 → daily job 落库」。

这个文件是**滚动窗口**：最老只到 `2022-11-22`。项目的 `HISTORY_START_DATE` 是 `2018-01-01`，
**2018–2022 那段已经永久拿不回来**，而且每周还会往前掉一周。

→ 与 `ice_cds` / `moomoo` 那两条「仅当天快照」同一类，只是窗口宽一点。**不攒就永久丢。**

⚠️ 但别为此焦虑：窗口 198 周 ≈ 3.8 年，job 停几周甚至几个月都补得回来。
只有连续几年不跑才会真丢。

### 库在本机、不进 git

`data/*.db` 已在 `.gitignore` 里，每台机器各自一份。
**攒数据这件事只在常开的那台机器上有意义**（公司电脑跑了也只是攒一份用不上的）。

### 落点

用现有的 `market_series`（`series_id, obs_date, value`），**不新建表** ——
这份数据的形状和 `ERIS_OIS_*` / `ICE_CDS_*` 完全一样，新表要改 schema、加迁移，不值。

两条 symbol：

```
TFX_SELL_USDJPY    ← 売り建玉(枚)
TFX_BUY_USDJPY     ← 買い建玉(枚)
```

`obs_date` 用文件里那一行的日期（周二）。幂等，同周重跑覆盖 —— 同 `erisSnapshot`。

### ⚠️ 不统一单位（这是刻意的决定，不是偷懒）

`cftcJpy` 保持现状（**合约张数**），TFX 单独一格存**枚**。理由：统一成日元名义额要改
`cftcJpy` 的数值口径（张数 → 兆円），会动到已有那格的历史刻度，收益不足。

**代价必须写进面板说明**：两格数值不可直接比较，只能各读各的方向与拐点。

### ⚠️ 符号方向是反的 —— 最容易读错的一点

- **CFTC**：合约是日元期货，`long` = **多日元**
- **TFX**：货币对是 `USD/JPY`，`買い` = 多美元 = **空日元**

两格看起来一样、读出来相反。**面板说明必须显式写出各自的方向**，
或者给 TFX 那格直接画 `売 − 買`（= 日元多头方向），并在标题里写明口径。

---

## 4. 依赖：SheetJS，**但不能从 npm 装**

BIFF8 在 JS 侧基本只有 SheetJS 能读。已实测：

| 装法 | 版本 | `bun audit` |
|---|---|---|
| `bun add xlsx` | `0.18.5`（npm 冻在 2022-03-24） | ❌ **2 个 high** |
| `bun add "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz"` | `0.20.3` | ✅ **No vulnerabilities** |

npm 上那两个 high：

```
xlsx  <0.19.3
  high: Prototype Pollution in sheetJS  — GHSA-4r6h-8v6p-xvw6
  high: SheetJS ReDoS                   — GHSA-5pgg-2g8v-p4x9
```

修复版**不在 npm** —— SheetJS 已把发布搬到自己的 CDN。
所以 `package.json` 里会多一条非 registry 的 tarball URL 依赖，这是必要代价。
装完 `node_modules/xlsx` 约 7.8 MB。

**已验证可用的读法**（scratchpad 实测，三个文件都读对了）：

```ts
import * as XLSX from 'xlsx';
const wb = XLSX.read(await Bun.file(path).arrayBuffer(), { type: 'buffer' });
const rows = XLSX.utils.sheet_to_json(wb.Sheets.w_sellbuy, { header: 1 });
```

---

## 5. 实现清单

### 5.1 `src/server/fetchers/tfxRetailFx.ts`

参照 `fetchers/jpxJgbVix.ts`（同样是外部 Excel 现拉）。

- 纯函数 `parseWeeklySellBuy(rows: unknown[][]): { date: string; sell: number; buy: number }[]`
  —— 接 `sheet_to_json(..., {header:1})` 的结果，**按表头名字定位 `USD/JPY`**（坑 ②）
- 日期是 `MM/DD/YYYY` 字符串（如 `09/01/2026`）→ 转 ISO；非法行跳过
- 升序返回（`lightweight-charts` 对乱序 `setData` 会抛）
- 非 2xx 抛错，别把错误页当空数据吞
- 找不到 `USD/JPY` 列或 sheet 缺失 → 抛错并在消息里写「表结构可能改版」

### 5.2 `src/server/jobs/tfxRetailSnapshot.ts`

参照 `jobs/erisSnapshot.ts`（最短的那个 job）：

```ts
export async function updateTfxRetail(db, fetch = fetchTfxRetailUsdJpy) {
  const rows = await fetch();
  insertMarketSeries(db, rows.flatMap((r) => [
    { seriesId: 'TFX_SELL_USDJPY', obsDate: r.date, value: r.sell },
    { seriesId: 'TFX_BUY_USDJPY',  obsDate: r.date, value: r.buy },
  ]));
  return { total: rows.length };
}
```

一次写全 198 周（幂等覆盖），不用增量逻辑 —— 每次都拿到完整窗口，简单且自愈。

### 5.3 挂进 `jobs/daily.ts`

按 `erisUpdater` 那个注入式写法加 `tfxRetailUpdater`。

⚠️ **成败判据的坑**：这是**周频**数据，daily job 每天拉到的是同一个文件。
**别把「没有新的一周」判成 failed** —— 那会让当天守卫永远不绿、整条 pipeline 白重跑 5 次。
性质同 `AGENTS.md:86` 那条 MOVE 的注释。建议判据：**拿到 ≥1 行且能解析出 `USD/JPY` 两列即 success**；
真正该告警的是「解析不出 USD/JPY 列」（= 源改版）。

**不要**加进 `REQUIRED_JOBS`（`daily.ts:182`）—— 周频数据缺一天不是异常。

### 5.4 让 regime 路由读到

- `routes/regime.ts` 的 `JOB_WRITTEN_SERIES`（`:102`）加两行：
  `['tfxRetailSell', 'TFX_SELL_USDJPY']`、`['tfxRetailBuy', 'TFX_BUY_USDJPY']`
- `DB_BACKED_KEYS`（`:173`）由 `JOB_WRITTEN_SERIES` 自动派生，不用改
- 缓存命中路径也走同一个 `readDbBacked`，不用额外处理（那处注释解释了为什么抽成一处）

### 5.5 前端：`jpy` 视角加一格

现有 `cftcJpy` 那格在 `web/panels/regime/regimeChart.hooks.ts:455`。
新格用 `overlay` 机制（上一批改动刚加的，见 `PaneSpec.overlay`）把 売 / 買 两条画同一格。

⚠️ **pane key 不得与 overlay key 重复**，也不得与别的 pane 撞 —— 已有断言覆盖
（`REGIME_DIMS：每个 dim 内的 pane key（含 overlay）不得重复`），撞了会挂测试。

`desc` 里必须写清四件事：

1. **单位是「枚」**，1 枚 = 1 万 USD；与 `cftcJpy` 的合约张数**不可直接比较**
2. **方向**：`買い` = 多美元 = **空日元**；`cftcJpy` 的 `long` = 多日元。两格方向相反
3. **它和 CFTC 是对立的两个群体**（海外投机 vs 日本散户），这格的价值在于「另一边」，
   实测 2026-09-01 两者确实反向
4. **盲区**：店頭 FX（FFAJ）体量是这格的 6 倍、CFTC 的 2 倍，**完全没覆盖**。
   现在它净头寸小只是当下状态，不是结构性的 —— 哪天店頭散户一边倒，面板看不见最大的搬运工

### 5.6 文档

- `README.md` 数据源清单加 TFX 一条（无需 key）
- `README.md` 视角表的「日本 Japan」行加这一格
- `AGENTS.md` 的源表加一行，标注 **「滚动窗口约 198 周，不可回填」**

---

## 6. Backlog：两个顺带解锁的源

### ACM 期限溢价（一旦 SheetJS 进来，边际成本≈0）

`docs/rates-decomposition-handoff.md` §6 当时把 ACM 挂起了，理由是「为一条对照线加一个 xls 依赖不值」。
**那个理由现在不成立了** —— 依赖为 TFX 已经加了。

已实测 `https://www.newyorkfed.org/medialibrary/media/research/data_indicators/ACMTermPremium.xls`
（10.1 MB BIFF8）能被 SheetJS 0.20.3 读开：

```
sheets: ['ACM Monthly', 'ACM Daily']
ACM Daily: 16,273 行 × 31 列
  DATE  ACMY01..ACMY10 (fitted)  ACMTP01..ACMTP10 (期限溢价)  ACMRNY01..ACMRNY10 (预期短端)
2026-09-04: ACMTP10 = 0.6800   ACMRNY10 = 4.1226
对照同日 Kim-Wright: TP10 = 0.8892  预期短端 = 3.9488   → 两模型差 21bp / 17bp
```

这 21bp 就是 `rates-decomposition-handoff.md` §3 口径纪律 ② 要的**分歧带宽**，
接了才算真正闭合那份文档的「只报单一模型点估计」自我批评。
而且 `ACMRNY` 列直接给预期短端，不用像 KW 那样靠 `拟合 − 溢价` 现减。

⚠️ ACM **可回填全历史**（一个文件 1961→今），按规矩该读时现拉。但它 10.1 MB，
而 regime 路由是 6h 内存 TTL（`routes/regime.ts:65`）、现拉全部源已约 1.3s ——
**建议也落库**，理由是体积不是不可回填。这个理由要写进注释，免得后人以为规矩变了。

### FFAJ 店頭 FX（要第二个依赖，不急）

- `https://www.ffaj.or.jp/wp-content/uploads/2026/01/fx_flash_e.doc`（按年一个文件，2008-12 起）
- 内容已核实：`【Open Positions】` → `USDJPY, Cross Yen`，有 `①Short / ②Long / Net long=②-①`，单位億円
  - 2025-12 实测：`Short 42,094 / Long 40,499 / Net long −1,595`（億円）
- 格式是 **OLE Word `.doc`**，SheetJS 读不了（报 `Cannot find Workbook stream`）
- 要额外加 `word-extractor@1.0.4`（116 KB，`bun audit` 干净）。已实测能抽出制表符分隔的正文
- **月频**，且**可回填到 2008** → 什么时候接都不丢历史，不像 TFX 有时效压力
- 它是三个桶里 gross 最大的一个（8.26 兆円），要读日本散户全貌最终得接

---

## 7. 已核实 / 未核实（边界说明）

**已实际下载并解析核实（2026-09-09）**：

- `weekly_sellbuy.xls` 的活 URL、格式、sheet 名、三行表头结构、198 周覆盖、33 对列表
- `USD/JPY` 的 `sell 348500 / buy 143481`（2026-09-01）
- 各货币对的取引単位（1 万 / 10 万通貨），及 `USD/JPY` = 1 万
- `USL/JPY` 存在且约占主约 3%；`KRW/JPY` / `CNY/JPY` 已下架
- `tfx.co.jp/mkinfo/document/fx_sellbuy.xls` 是停在 2012 的僵尸文件
- SheetJS `0.20.3` 从 CDN tarball 装得上、`bun audit` 干净、能读 TFX 与 ACM 两个 `.xls`
- npm `xlsx@0.18.5` 的两个 high（`bun audit` 实报，非凭记忆）
- `word-extractor@1.0.4` 能读 FFAJ `.doc`，SheetJS 不能
- CFTC 的日元名义额换算（1 张 = 1250 万日元），2026-09-01 `net −1.15 兆円`

**未核实、实现时要自己确认**：

- **文件是不是真的滚动**（只有一次观测）。198 周这个长度是从「创建于 2013 却只有 2022 起的数据」
  反推的，没有第二次观测证明它在往前掉。**但无论滚不滚，2018–2022 段确实已经缺，落库的结论不变。**
- 発表时点的确切规则（「次周二」是从页面文案读的，没有跨周实测）
- 单位是否会随合约改版变动（本次只核实了当下这一版单位表）
- 日期列在 SheetJS 下是否恒为 `MM/DD/YYYY` 字符串而非 Date 对象
  （实测这一版是字符串，但 `cellDates` 之类的默认行为值得在解析器里防一手）

---

## 8. 验收

- [ ] `bun add "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz"` 后 `bun audit` 仍 **No vulnerabilities**
- [ ] `bun run src/server/jobs/tfxRetailSnapshot.ts` 写入 198 × 2 = **396 行**
- [ ] `sqlite3 data/mtv.db "SELECT * FROM market_series WHERE series_id='TFX_BUY_USDJPY' ORDER BY obs_date DESC LIMIT 1"`
      → `2026-09-01 | 143481`（跑得晚的话日期会更新，值对得上文件即可）
- [ ] `/api/regime` 返回里出现 `tfxRetailSell` / `tfxRetailBuy`，且**不在** `unavailable`
- [ ] 解析器单测：至少一条「按表头名字定位、列顺序变了也能取对」的用例
      —— 这是坑 ② 唯一的防线，静默错位不会报错
- [ ] daily job 连跑两天：第二天**没有新的一周**时仍记 success，不告警
- [ ] 面板那格的 `desc` 含 §5.5 的四条（单位不可比 / 方向相反 / 与 CFTC 对立 / FFAJ 盲区）
- [ ] `bun run typecheck` + `bun run lint` + `bun test` 全绿
