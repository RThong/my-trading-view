/**
 * moomoo OpenD option chain fetcher (WebSocket).
 *
 * Returns the same OptionChainSnapshot shape as yahooOptions.ts so the rest
 * of the pipeline (select25Delta, raw archival) is source-agnostic. Unlike
 * Yahoo, moomoo provides exchange-grade OI/IV plus pre-computed Greeks
 * (delta/gamma/vega/theta/rho), which we carry through as optional fields.
 *
 * Two-step protocol:
 *   1. GetOptionChain  → static info (contract codes, strikes) for a date window
 *   2. GetSecuritySnapshot (batched ≤400) → dynamic data (OI/IV/Greeks/quotes)
 *
 * Requires OpenD running with WebSocket enabled (default port 33333) and the
 * auth key in env. See .env: MOOMOO_WS_HOST / MOOMOO_WS_PORT / MOOMOO_WS_KEY.
 */

// @ts-expect-error — moomoo-api ships no type declarations
import mmWebsocket from 'moomoo-api';
import type { OptionContract } from './yahooOptions';
import type { OptionsChainClient } from '../jobs/optionsSnapshot';

const QOT_MARKET_US = 11;
const SNAPSHOT_BATCH = 400;
const LOGIN_TIMEOUT_MS = 10_000;

type MoomooConfig = {
  host: string;
  port: number;
  key: string;
};

function envConfig(): MoomooConfig {
  const key = process.env.MOOMOO_WS_KEY ?? '';
  if (!key) throw new Error('MOOMOO_WS_KEY not set');
  return {
    host: process.env.MOOMOO_WS_HOST ?? '127.0.0.1',
    port: Number(process.env.MOOMOO_WS_PORT ?? '33333'),
    key,
  };
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * moomoo documents strikeTime as "yyyy-MM-dd". Validate it rather than trust:
 * an unexpected format (e.g. a datetime) would otherwise parse to an Invalid
 * Date downstream and silently corrupt 25Δ selection. Fail loud instead — the
 * throw is caught by the daily job's options group and recorded as a failure.
 */
function expiryDate(raw: unknown): string {
  const s = String(raw ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error(`Unexpected moomoo strikeTime format: ${JSON.stringify(raw)}`);
  }
  return s;
}

/** Connects, runs `fn`, then always closes the socket. */
async function withConnection<T>(
  cfg: MoomooConfig,
  fn: (ws: any) => Promise<T>,
): Promise<T> {
  const ws = new mmWebsocket();
  ws.start(cfg.host, cfg.port, false, cfg.key);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('OpenD login timeout')), LOGIN_TIMEOUT_MS);
      ws.onlogin = (ret: boolean, msg: string) => {
        clearTimeout(timer);
        ret ? resolve() : reject(new Error(`OpenD login failed: ${msg}`));
      };
    });
    return await fn(ws);
  } finally {
    // stop() only unregisters the push callback. The underlying socket and its
    // reconnect timer live on ws.websock — close() shuts both, otherwise the
    // handle keeps the event loop alive and the daily CLI never exits.
    ws.stop();
    ws.websock?.close();
  }
}

type StaticContract = { code: string; strikePrice: number; type: number };

async function fetchStaticChain(
  ws: any,
  symbol: string,
  begin: string,
  end: string,
): Promise<{ expiry: string; calls: StaticContract[]; puts: StaticContract[] }[]> {
  const res = await ws.GetOptionChain({
    c2s: {
      owner: { market: QOT_MARKET_US, code: symbol },
      beginTime: begin,
      endTime: end,
    },
  });
  const chains = res?.s2c?.optionChain ?? [];
  return chains.map((ch: any) => {
    const calls: StaticContract[] = [];
    const puts: StaticContract[] = [];
    for (const o of ch.option ?? []) {
      if (o.call?.basic?.security?.code) {
        calls.push({
          code: o.call.basic.security.code,
          strikePrice: o.call.optionExData?.strikePrice,
          type: 1,
        });
      }
      if (o.put?.basic?.security?.code) {
        puts.push({
          code: o.put.basic.security.code,
          strikePrice: o.put.optionExData?.strikePrice,
          type: 2,
        });
      }
    }
    return { expiry: expiryDate(ch.strikeTime), calls, puts };
  });
}

async function fetchSnapshots(ws: any, codes: string[]): Promise<Map<string, any>> {
  const byCode = new Map<string, any>();
  for (let i = 0; i < codes.length; i += SNAPSHOT_BATCH) {
    const batch = codes.slice(i, i + SNAPSHOT_BATCH);
    const res = await ws.GetSecuritySnapshot({
      c2s: { securityList: batch.map((code) => ({ market: QOT_MARKET_US, code })) },
    });
    for (const s of res?.s2c?.snapshotList ?? []) {
      const code = s.basic?.security?.code;
      if (code) byCode.set(code, s);
    }
  }
  return byCode;
}

function toContract(staticC: StaticContract, snap: any): OptionContract | null {
  const ox = snap?.optionExData;
  const basic = snap?.basic;
  if (!ox || typeof ox.impliedVolatility !== 'number') return null;
  return {
    contractSymbol: staticC.code,
    strike: staticC.strikePrice,
    expiration: expiryDate(ox.strikeTime),
    // moomoo gives IV as percent (19.296 = 19.296%); normalize to decimal to
    // match yahooOptions convention (0.20 = 20%).
    impliedVolatility: ox.impliedVolatility / 100,
    bid: typeof basic?.bidPrice === 'number' ? basic.bidPrice : null,
    ask: typeof basic?.askPrice === 'number' ? basic.askPrice : null,
    lastPrice: typeof basic?.curPrice === 'number' ? basic.curPrice : null,
    volume: basic?.volume != null ? Number(basic.volume) : null,
    openInterest: typeof ox.openInterest === 'number' ? ox.openInterest : null,
    inTheMoney: false, // moomoo doesn't flag this directly; derived later if needed
    lastTradeDate: basic?.updateTime ?? null,
    // moomoo extras (absent from Yahoo): delta for 25Δ cross-check, gamma for
    // GEX off the archived chain. vega/theta/rho dropped — no reader.
    delta: typeof ox.delta === 'number' ? ox.delta : null,
    gamma: typeof ox.gamma === 'number' ? ox.gamma : null,
  };
}

export function defaultMoomooOptionsClient(): OptionsChainClient {
  return {
    async fetchChain(symbol, targetDte) {
      // Resolve config lazily: a missing MOOMOO_WS_KEY then surfaces inside the
      // options group's try/catch (recorded via finishJobRun) rather than
      // throwing at construction time and aborting the whole daily job.
      const cfg = envConfig();
      return withConnection(cfg, async (ws) => {
        // Window around target DTE (±10 days) so we catch a listed expiry.
        const now = Date.now();
        const begin = isoDate(new Date(now + (targetDte - 10) * 86400_000));
        const end = isoDate(new Date(now + (targetDte + 10) * 86400_000));

        const expiries = await fetchStaticChain(ws, symbol, begin, end);
        if (expiries.length === 0) {
          throw new Error(`No expiries for ${symbol} in ${begin}..${end}`);
        }

        // Pick expiry whose distance to targetDte is smallest.
        const target = now + targetDte * 86400_000;
        let best = expiries[0];
        let bestDiff = Infinity;
        for (const e of expiries) {
          const ms = new Date(e.expiry + 'T16:00:00Z').getTime();
          const diff = Math.abs(ms - target);
          if (diff < bestDiff) { best = e; bestDiff = diff; }
        }

        // Snapshot all strikes of the chosen expiry (calls + puts).
        const allStatic = [...best.calls, ...best.puts];
        const snaps = await fetchSnapshots(ws, allStatic.map((c) => c.code));

        const calls = best.calls
          .map((c) => toContract(c, snaps.get(c.code)))
          .filter((c): c is OptionContract => c !== null);
        const puts = best.puts
          .map((c) => toContract(c, snaps.get(c.code)))
          .filter((c): c is OptionContract => c !== null);

        // Underlying spot: snapshot the underlying itself.
        const underlyingSnap = await fetchSnapshots(ws, [symbol]);
        const spot = underlyingSnap.get(symbol)?.basic?.curPrice;
        if (typeof spot !== 'number') {
          throw new Error(`Could not get spot price for ${symbol}`);
        }

        return {
          underlyingSymbol: symbol,
          underlyingPrice: spot,
          expirationDate: best.expiry,
          calls,
          puts,
        };
      });
    },
  };
}
