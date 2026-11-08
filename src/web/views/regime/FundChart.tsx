import type { Interval } from '../../hooks/interval';
import type { ChartDoc } from '../chartDoc/chartDoc';
import { DocChart } from '../chartDoc/DocChart';
import { type FundDim, secFiledNote, secLagNote, secTrimNote, useRegimeData } from './regimeChart.hooks';

// 基本面维度(一家公司 / 买方合计):画法同固定面板(DocChart),外加 SEC 的三条提示 ——
// 滞后(公司已申报、SEC 还没提供)、断档裁剪(否则只看到一条短线)、最新一期与申报日。三者可同时成立。
// SWR 按 URL 去重:/api/regime 与 DocChart 取数共用同一份响应,不多发请求。
export function FundChart({ dim, doc, interval }: { dim: FundDim; doc: ChartDoc; interval: Interval }) {
  const { data } = useRegimeData();
  const notes = [secLagNote(data, dim), secTrimNote(data, doc)].filter((n) => n !== undefined);

  return <DocChart doc={doc} interval={interval} notes={notes} caption={secFiledNote(data, dim)} />;
}
