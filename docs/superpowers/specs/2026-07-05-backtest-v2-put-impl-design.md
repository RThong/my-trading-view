# 回测器 v2 实现设计:合成 QQQ put 保险腿

日期:2026-07-05  ·  策略见 [backtest-strategy-vixterm.md §5](../../backtest-strategy-vixterm.md) · 承接 [v1 实现](2026-07-05-backtest-v1-impl-design.md)

## 范围
在 v1 基础上加**合成 QQQ 看跌期权(put)保险腿**:贪婪时买 put、逐日 mark-to-market、月度 roll、贪婪结束平仓。
CLI 增加 put 相关对比行。**核心看点**:put 的凸性(convexity)比现金减仓多换回多少回撤、值不值权利金(premium)拖累。
铁律仍是 v1 那三条(复权价、无未来函数、close-to-close),put 定价只用当天 VXN/QQQ。

## 1. Black-Scholes 定价器 `src/server/backtest/bs.ts`(纯)
`bsPut(S, K, T, sigma, r=0): number` —— 标准 Black-Scholes 欧式看跌:
`put = K e^{-rT} N(-d2) − S N(-d1)`,`d1=(ln(S/K)+(r+σ²/2)T)/(σ√T)`、`d2=d1−σ√T`。
`N` = 标准正态 CDF(用 erf 近似,纯函数)。边界:`T≤0` → 返回 intrinsic `max(K−S,0)`;`σ≤0` → intrinsic。
单测:对拍已知参考值(如 S=100,K=100,T=1,σ=0.2,r=0 → put≈7.97)。

## 2. 保险叠加层账务(`putLeg.ts`,纯)

**模型:put 叠加在 QQQ 上,卖等额 QQQ 自筹权利金。**
> NAV 逐日:`(NAV_{t-1} − putValue_{t-1}) × (1 + qqqRet_t) + putValue_t`

其中 `putValue_t = 份数 q × bsPut(S_t, K, T剩余, σ_t)`;`σ_t = VXN_t/100 × skewMarkup`。
- **买入日**:`q = min(保护名义, 预算约束) × NAV / S_买`;putValue 从 0 → 权利金(公允价),当天 NAV 不跳变(卖 QQQ 出资)。
- **持有**:逐日按 BS 重估(theta 衰减为主,崩盘跳正)。
- **到期 / roll / 贪婪结束**:按当日公允价了结(折回 QQQ 部分),仅在仍贪婪时买新一份。同时只持 1 份。

**份数与预算**:`保护名义 pn` 决定名义;若该次 roll 权利金 `q×premium` 超过 `premiumBudget×NAV × (tenor/252)`(按持有期摊分),则按比例缩减 `q`(预算是硬上限)。

**行权价**:`K = moneyness × S_买`(ATM→moneyness=1,5% OTM→0.95)。**剩余 T**:`(到期index − t)/252` 年。

## 3. 无未来函数
put 定价只用当天 `S_t`、`σ_t`(=VXN_t);roll/到期由持有天数决定,不看未来价。信号(贪婪状态)沿用 v1 的 as-of。执行仍 t+1(状态第 t 天定,收益/重估从 t+1 起)。

## 4. 参数(策略 §8)
protectedNotional 20% · premiumBudgetAnnual 2% · moneyness 1.0(ATM,可 0.95) · tenor 30(交易日近似 21) · skewMarkup 1.1。
> tenor 用**交易日**近似:30 日历天 ≈ 21 交易日;T 换算按 /252。文档默认 tenor=21 交易日。

## 5. 与轮动腿的组合 + CLI 新增(`run.ts`)

**组合方式**:`putLeg` 是**叠加在一条 base 净值路径上**的一层,输入 base 每日收益 + QQQ/VXN/greed 状态。
- `put-only` 的 base = 纯 QQQ;`both A + put` 的 base = **仅轮动 A** 的净值路径(恐慌→TQQQ,其余 100% QQQ,**贪婪不减仓**)。
- 因为恐慌与贪婪互斥,**贪婪期 base 必是 100% QQQ**,所以"卖等额 QQQ 自筹权利金 + 按 QQQ 定价"始终成立。put 只在贪婪期持有,非贪婪期 putValue=0、公式退化为 base 路径本身。
- 注意:put 版的贪婪**不走现金减仓**(那是 cash 基准);贪婪时保持 QQQ + 叠 put。

**CLI 加行**:`put-only (greed)`、`both A + put`,并排现有 `cash-only`、`both A`(现金),直接对比 put vs 现金两种保险。put 组合用同一份 greed 状态(与恐慌入场变体无关)。

## 6. 结构 / 测试
- 🆕 `bs.ts` + `bs.test.ts`(对拍参考价、T≤0 取 intrinsic)。
- 🆕 `putLeg.ts` + `putLeg.test.ts`:①买入日 NAV 不跳变;②平静期 theta 使 put 缓慢衰减、NAV 略拖累;③单日大跌 put 跳正、护住 NAV;④贪婪结束平仓折回;⑤预算上限缩减份数。
- ✏️ `run.ts`:加 put 组合行 + 保险对比。
- 复用不改:`signal.ts`/`metrics.ts`;VXN 读 `market_series`;QQQ 复权价 v1 已抓(需在 run.ts 一并把 VXN 对齐进来)。

## 7. 验证(实现后手动)
`bun run src/server/backtest/run.ts` → put-only 一行:CAGR 应比基准**略低**(权利金拖累)、MDD 应比现金版**更浅**(凸性护得更多);若 put 的 MDD 改善远大于 CAGR 拖累,说明凸性划算。对拍 §7 现金版(−33% 附近)看 put 是否更低。

## 8. 影响文件
- 🆕 `src/server/backtest/{bs,putLeg}.ts` + `{bs,putLeg}.test.ts`
- ✏️ `src/server/backtest/run.ts`(对齐 VXN + put 组合行)
- 复用不改:`signal.ts` / `engine.ts` / `metrics.ts` / `shared/stats.ts`
