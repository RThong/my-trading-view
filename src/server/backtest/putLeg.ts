// 合成 QQQ 看跌期权(put)保险叠加层:在一条 base 净值路径上,贪婪期叠一份滚动 put。纯函数。
// 账务:卖等额 QQQ 自筹权利金 → NAV_t = (NAV_{t-1} − put市值_{t-1})(1+base收益_t) + put市值_t。
// 只在贪婪期持仓(base 此时必是 100% QQQ),按 QQQ 现价 + 当天 VXN 逐日 BS 重估;到期/贪婪结束了结。
import { bsPut } from './bs';
import type { EquityPoint } from './engine';

export type PutConfig = {
  protectedNotional: number; // put 覆盖的名义占 NAV 比例(默认 0.20)
  premiumBudgetAnnual: number; // 权利金年预算占 NAV(默认 0.02),硬上限,超则缩名义
  moneyness: number; // K = moneyness × S(1.0=ATM,0.95=5% OTM)
  tenorDays: number; // 每份 put 期限(交易日,默认 21 ≈ 30 日历天)
  skewMarkup: number; // σ 加价补偿指数 put skew(默认 1.1)
};

export type PutDay = { date: string; qqq: number; vxn: number; greed: boolean };

type Position = { q: number; K: number; expiry: number }; // q=份数(share 当量),expiry=到期日 index

export function overlayPut(base: EquityPoint[], days: PutDay[], cfg: PutConfig): EquityPoint[] {
  const T = cfg.tenorDays / 252;
  const sigma = (i: number) => (days[i].vxn / 100) * cfg.skewMarkup;
  const putValue = (pos: Position | null, i: number): number =>
    pos ? pos.q * bsPut(days[i].qqq, pos.K, Math.max((pos.expiry - i) / 252, 0), sigma(i)) : 0;

  // 贪婪时按保护名义定份数,权利金超预算摊分则按比例缩减(预算硬上限)。
  const size = (i: number, nav: number): Position => {
    const S = days[i].qqq;
    const K = cfg.moneyness * S;
    const expiry = i + cfg.tenorDays;
    const qTarget = (cfg.protectedNotional * nav) / S;
    const premium = qTarget * bsPut(S, K, T, sigma(i));
    const budget = cfg.premiumBudgetAnnual * nav * (cfg.tenorDays / 252);
    const q = premium > budget && premium > 0 ? qTarget * (budget / premium) : qTarget;
    return { q, K, expiry };
  };

  let nav = base[0].value;
  let pos: Position | null = days[0].greed ? size(0, nav) : null; // [0,1] 持仓
  const out: EquityPoint[] = [{ date: base[0].date, value: nav }];

  for (let t = 1; t < base.length; t++) {
    const baseRet = base[t].value / base[t - 1].value - 1;
    nav = (nav - putValue(pos, t - 1)) * (1 + baseRet) + putValue(pos, t);
    out.push({ date: base[t].date, value: nav });

    // 收盘后为 [t, t+1] 定仓:贪婪则持有/到期换新,非贪婪平掉。两份公允价互换 → NAV 连续。
    if (!days[t].greed) pos = null;
    else if (!pos || t >= pos.expiry) pos = size(t, nav);
  }
  return out;
}
