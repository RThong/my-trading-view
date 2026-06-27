/**
 * moomoo OpenD 模拟账户持仓(只读)。复用 moomooClient 的 withConnection(同一 OpenD,
 * 连不上即抛错)。Trade 半边两步(ws 方法名去掉了 Trd 前缀,同 GetOptionChain 规律):
 *   1. GetAccList → 筛 trdEnv=Simulate 的模拟账户(取第一个)
 *   2. GetPositionList(header={trdEnv, accID, trdMarket:US}) → 持仓列表
 * 只读、不解锁、不下单;真实账户需 UnlockTrade,本模块不做。
 */
import type { Position } from '../../shared/types';
import { envConfig, withConnection } from './moomooClient';

// Trd_Common 枚举(见 moomoo-api proto.js)
const TRD_ENV_SIMULATE = 0;
const TRD_CATEGORY_SECURITY = 1;
const TRD_MARKET_US = 2;

/** Number 化,非有限值(含 undefined/null/空串/NaN/非数字字符串)→ null。 */
function num(x: unknown): number | null {
  if (x == null || x === '') return null; // Number(null)===0,得先挡掉空值
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

/** 纯映射:proto Position[] → 干净 Position[]。无副作用,单测覆盖。 */
export function mapPositions(raw: any[] | undefined): Position[] {
  return (raw ?? []).map((p) => ({
    code: String(p.code ?? ''),
    name: String(p.name ?? ''),
    qty: num(p.qty),
    costPrice: num(p.costPrice),
    price: num(p.price),
    marketVal: num(p.val),
    plVal: num(p.plVal),
    plRatio: num(p.plRatio),
  }));
}

/** 取模拟账户当前持仓。返回 { accId, positions }。无模拟账户 / OpenD 未起 → 抛错。 */
export async function fetchSimPositions(): Promise<{ accId: number; positions: Position[] }> {
  return withConnection(envConfig(), async (ws) => {
    const accRes = await ws.GetAccList({
      c2s: { userID: 0, trdCategory: TRD_CATEGORY_SECURITY, needGeneralSecAccount: true },
    });
    const accList: any[] = accRes?.s2c?.accList ?? [];
    const sim = accList.find((a) => a.trdEnv === TRD_ENV_SIMULATE);
    if (!sim) throw new Error('未找到 moomoo 模拟账户(TrdEnv_Simulate)');

    const posRes = await ws.GetPositionList({
      c2s: { header: { trdEnv: TRD_ENV_SIMULATE, accID: sim.accID, trdMarket: TRD_MARKET_US } },
    });
    return { accId: Number(sim.accID), positions: mapPositions(posRes?.s2c?.positionList) };
  });
}
