# 攻防 regime 改用 ZigZag 摆动检测 设计

日期：2026-07-09

## 背景

现「攻防」tab 的 regime 用「比值 vs trailing 150 日均线偏离 + ±12% 迟滞」判定。问题：均线滞后 → 攻防区**边界拖尾**（绿区比真实的 2022 底→2023 初防御波拖长了三五个月），不贴大级别拐点。

改用 **ZigZag 摆动检测（吸附极值）**：边界精确落在比值的真实波峰/波谷上，对上"大级别"的直觉。手写（主流 TA 库无可用 ZigZag，见调研）。

## 判定算法（regimeZones 重写）

- 常量：`SWING_PCT = 0.08`（8%），替换原 `MA_LEN`/`BAND`。
- 签名：`regimeZones(ratio: {date,value}[], pct: number): { date: string; regime: Regime; pending: boolean }[]`；`Regime = 'defense' | 'offense' | 'neutral'`。

**ZigZag 拐点检测**：一路跟踪自上个拐点以来的波峰 `hi` 和波谷 `lo`。
- 当前处于上行腿(或未定) 且 `v ≤ hi×(1−pct)` → 确认一个**峰**拐点（吸附到 `hi` 的 index），转下行腿，重置 `lo` 跟踪。
- 当前处于下行腿(或未定) 且 `v ≥ lo×(1+pct)` → 确认一个**谷**拐点（吸附到 `lo` 的 index），转上行腿，重置 `hi` 跟踪。
- 得到交替的拐点序列 `pivots = {idx, kind: 'peak'|'trough'}[]`。

**逐点上色**（腿方向 = 走向该腿终点的方向）：
- 「结束于**峰**」的腿 = 上行（比值涨=NOBL 走强）→ **defense（绿）**。
- 「结束于**谷**」的腿 = 下行 → **offense（红）**。
- 即：从起点到每个 pivot 的那段，按 `pivot.kind === 'peak' ? defense : offense`。**首个拐点之前那段也按此上色**（走向首拐点的方向），不留 neutral。
- **最后一个拐点之后**那段 = **pending 待定腿**：方向 = 上个拐点之后的走向（`last.kind === 'peak' ? offense : trough后→defense`），`pending: true`。
- **退化**：整段无任何 8% 反转（`pivots` 为空）→ 全部 `neutral`（实际数据不会发生）。

因果性：pending 那条腿会 repaint（新数据可能改其颜色/长度）——这是吸附极值的固有代价，仅影响最右未确认段；已确认的历史腿一旦定下不再变。

## 渲染（AttackDefensePanel）

- `bgColor(regime, pending)`：defense→绿、offense→红、neutral→透明；**pending 用更淡的同色**（确认段 alpha 0.35，pending 段 0.15）。
- histogram 背景 data：`{ time, value: regime==='neutral' ? 0 : 1, color: bgColor(z.regime, z.pending) }`。
- 其余（QQQ 蜡烛、比值线、useMemo、两 pane）不动。

## 影响文件

- `src/web/panels/attackDefense.hooks.ts`：删 `MA_LEN`/`BAND`，加 `SWING_PCT`；重写 `regimeZones`（`Regime`/`ratioSeries` 不变，`Regime` 加不加 neutral 都留着）。
- `src/web/panels/attackDefense.hooks.test.ts`：`regimeZones` 测试改成 ZigZag 行为。
- `src/web/panels/AttackDefensePanel.tsx`：`bgColor` 加 pending 淡色；调用处传 `z.pending`。

## 测试（regimeZones）

- 跌 8% 确认峰、涨 8% 确认谷，拐点 idx **吸附到极值点**（非确认点）。
- 腿上色：结束于峰=defense、结束于谷=offense；**首拐点前**段按走向首拐点方向上色（非 neutral）。
- 最后一条腿 `pending: true`，其余 `pending: false`。
- 不够 8% 的小回撤**不产生拐点**（大级别过滤）。
- 无拐点 → 全 neutral。

## 明确取舍

- 阈值 8% 起步，常量放着可调（用户目视后再定）。
- 接受 pending 段 repaint（吸附极值的代价），用淡色标"待定"。
- 不引 TA 库（无可用 ZigZag，手写 ~30 行）。
- Q2（把 useMemo 收进 hook 去 footgun）本次不做，后续单独处理。
