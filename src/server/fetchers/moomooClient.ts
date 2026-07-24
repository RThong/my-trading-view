/**
 * moomoo OpenD WebSocket 连接的公共部分(被 moomooOptions / moomooHistoryKL 复用)。
 * 退出逻辑有讲究:stop() 只注销推送回调,底层 socket 和它的重连定时器挂在 ws.websock
 * 上,必须 close() 一起关掉,否则句柄会让事件循环一直存活、CLI 永远退不出去。
 */
// @ts-expect-error — moomoo-api 没有附带类型声明
import mmWebsocket from 'moomoo-api';

export const QOT_MARKET_US = 11;
const LOGIN_TIMEOUT_MS = 10_000;

export type MoomooConfig = { host: string; port: number; key: string };

export function envConfig(): MoomooConfig {
  const key = process.env.MOOMOO_WS_KEY ?? '';
  if (!key) throw new Error('MOOMOO_WS_KEY not set');
  return {
    host: process.env.MOOMOO_WS_HOST ?? '127.0.0.1',
    port: Number(process.env.MOOMOO_WS_PORT ?? '33333'),
    key,
  };
}

/** 建立连接并登录,返回已登录的 ws;登录失败/超时(如 OpenD 没起)抛错。 */
export async function connect(cfg: MoomooConfig): Promise<any> {
  const ws = new mmWebsocket();
  ws.start(cfg.host, cfg.port, false, cfg.key);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('OpenD login timeout')), LOGIN_TIMEOUT_MS);
      ws.onlogin = (ret: boolean, msg: string) => {
        clearTimeout(timer);
        if (ret) resolve();
        else reject(new Error(`OpenD login failed: ${msg}`));
      };
    });
  } catch (e) {
    // 登录失败也要拆掉 ws,否则其重连定时器会让事件循环一直存活、CLI 退不出去。
    disconnect(ws);
    throw e;
  }
  return ws;
}

export function disconnect(ws: any): void {
  ws.stop();
  ws.websock?.close();
}

/**
 * 行情(qot)会话是否真就绪。onlogin=true 只保证交易(trd)登录,qot 会话可能悬空
 * (见 memory opend-qot-session-drop):端口开、登录成功,但取行情全 retType=-1。
 * daily 就绪门用它探真状态,别只信端口。
 */
export async function qotReady(cfg: MoomooConfig): Promise<boolean> {
  try {
    return await withConnection(cfg, async (ws) => {
      const r = await ws.GetGlobalState({ c2s: { userID: 0 } });
      return r?.s2c?.qotLogined === true;
    });
  } catch {
    // 连不上 / 登录超时 / GetGlobalState 异常一律视为未就绪,保持布尔语义不抛。
    return false;
  }
}

/** 连接 → 执行 fn → 无论如何断开。 */
export async function withConnection<T>(cfg: MoomooConfig, fn: (ws: any) => Promise<T>): Promise<T> {
  const ws = await connect(cfg);
  try {
    return await fn(ws);
  } catch (e: any) {
    // moomoo 的 GetXxx 失败时 reject 的是 {retType,retMsg,errCode} 对象而非 Error;转成带 retMsg
    // 的 Error,否则上层 (err as Error).message 只拿到 undefined,真因(如 "Network interruption.")被吞。
    if (e && typeof e === 'object' && !(e instanceof Error) && 'retMsg' in e) {
      throw new Error(`moomoo: ${e.retMsg} (retType=${e.retType})`);
    }
    throw e;
  } finally {
    disconnect(ws);
  }
}

// CLI:供 daily-with-opend.sh 就绪门探测。qot 就绪 exit 0,否则(未就绪/连不上/缺配置)exit 1。
if (import.meta.main) {
  // envConfig() 缺 MOOMOO_WS_KEY 会同步抛,一并包进 try,避免未捕获异常打堆栈。
  (async () => {
    try {
      process.exit((await qotReady(envConfig())) ? 0 : 1);
    } catch {
      process.exit(1);
    }
  })();
}
