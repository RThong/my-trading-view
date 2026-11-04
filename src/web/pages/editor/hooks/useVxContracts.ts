// VX 各月合约的名单:份数每月加一份,不进静态注册表,搜索框挂载时现取(SWR 缓存,整个会话只取一次)。
import useSWR from 'swr';
import { type SeriesDef, VX_CONTRACT_PREFIX, vxContractDefs } from '../../../views/chartDoc/registry';
import { SWR_OPTS } from '../../../lib/http';

const NONE: SeriesDef[] = [];

async function getContracts(url: string): Promise<SeriesDef[]> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(String(r.status));
  return vxContractDefs((await r.json()) as string[]);
}

export function useVxContracts(): SeriesDef[] {
  const { data = NONE } = useSWR(
    `/api/series?prefix=${encodeURIComponent(VX_CONTRACT_PREFIX)}`,
    getContracts,
    SWR_OPTS,
  );
  return data;
}
