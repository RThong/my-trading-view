// 图表显示粒度(日/周/月/季/年)。原在 useChartData 里,该 hook 随非期权面板一并删除,
// 仅 Interval 类型仍被 Header / App / AssetChart 使用,故单拎出来。
export type Interval = '1D' | '1W' | '1M' | '1Q' | '1Y';
