# VIX 期限结构(VX1−V3)从期权搬到情绪视角

日期:2026-07-05

## 目标

把 VX1−V3 期限结构(按符号上色的柱状图:backwardation 正=绿、contango 负=红,0 基线)
从期权 .VIX tab **搬到**情绪视角。语义契合:contango=平静/自满=风险(红),backwardation=恐慌=机会(绿),
与情绪视角红绿一致。"就搬,别的不动":最小改动,不重构无关代码。

## 改动

1. **`routes/regime.ts`**:再读库里 VX1/VX3,`computeSpread` 算价差,加序列
   `vxTermSpread = [{date, value: spread}]`(与刚加的 VIX/VXN 同样从 `market_series` 读)。
2. **`regimeChart.hooks.ts`**:
   - sentiment `paneDefs` 末尾加 `{ key:'vxTerm', label:'VX1−V3', series:['vxTermSpread'] }`。
   - `DimConfig` 加 `signed?: string[]`;sentiment `signed: ['vxTermSpread']`。
   - `buildRegimeSpecs`:`signed` 里的序列 → 建 `HistoSpec`(每根柱 `>=0` 绿 `<0` 红,baseline 0),
     **不套** P5/P95 参考线 / 背景带 / 徽标(它自带含义)。
   - `regimePercentiles`:跳过 `signed` 序列(无徽标)。
3. **`assetChart.hooks.ts` `paneConfig`**:去掉 `isVix` 的 term pane。.VIX 变 现货/IV/Skew 三 pane。
   (期权侧 `useAssetData` 仍取 ts、`buildSpecs` 的 v1v3 因 `paneOf('v1v3')=-1` 自动跳过 → 别的不动。)

## 不做

- 不删期权侧 ts 取数 / `/api/term-structure/vix` 路由(别的不动;`buildSpecs` 自动跳过不显示)。
- 不给期限结构套分位带(它是 0 轴符号柱,自带含义)。

## 测试 / 验证

- `regimeChart.hooks.test.ts` 加一例:sentiment 含 `vxTermSpread` 时,该 pane 出 `HistoSpec`、
  正值绿负值红、baseline 0、无 refLines;`regimePercentiles` 不含它。
- 手动:情绪视角末尾出现 VX1−V3 柱状图(红绿同期权原样);期权 .VIX 不再有该 pane、其余三 pane 正常。
- `tsc` + 相关单测通过。
