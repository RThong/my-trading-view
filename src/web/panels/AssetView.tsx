import type { Interval } from '../hooks/interval';
import { OptionsPanel } from './OptionsPanel';
import { VrpPanel } from './VrpPanel';

// 一个资产的全部期权指标:25Δ(call/put IV + skew),以及 VRP(SPY/BTC 才有,
// VIX 无——给波动率指数算 VRP 概念别扭)。两块图上下叠在同一个 tab 里。
export function AssetView({
  interval,
  underlying,
  vrpUnderlying,
}: {
  interval: Interval;
  underlying: string;       // 期权链标的(.VIX 带点)
  vrpUnderlying?: string;   // VRP 路由用的标的(SPY / BTC);省略 = 无 VRP(如 VIX)
}) {
  return (
    <div className="flex h-full flex-col gap-3">
      <section className="flex min-h-0 flex-1 flex-col">
        <h3 className="mb-1 text-xs text-neutral-400">25Δ 隐含波动率 / Skew</h3>
        <div className="min-h-0 flex-1">
          <OptionsPanel interval={interval} underlying={underlying} />
        </div>
      </section>
      {vrpUnderlying && (
        <section className="flex min-h-0 flex-1 flex-col">
          <h3 className="mb-1 text-xs text-neutral-400">VRP(隐含 vs 已实现波动)</h3>
          <div className="min-h-0 flex-1">
            <VrpPanel interval={interval} underlying={vrpUnderlying} />
          </div>
        </section>
      )}
    </div>
  );
}
