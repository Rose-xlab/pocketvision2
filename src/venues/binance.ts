/**
 * Binance venue adapter (Phase 3) — the first non-PO feed.
 *
 * Why Binance first: free, honest, all-pairs market data over ONE WebSocket
 * (no browser, no rotation pool, no broker games), so the whole PO workaround
 * layer disappears. Klines arrive already aggregated — a closed kline maps
 * straight onto our Candle type and the candle→streak→outcome pipeline runs
 * unchanged.
 *
 * Market data only. Order placement is a later, separate step — the crypto
 * scan ships in paper mode, scored by the same OutcomeTracker as PO.
 *
 * Uses the native WebSocket (Node ≥ 22) — no extra dependency.
 */
import type { Candle } from '../scanner/candles.js';

const REST = 'https://api.binance.com';
const WS = 'wss://stream.binance.com:9443';
/** Binance allows 1024 streams/connection; stay comfortably below. */
const MAX_STREAMS_PER_CONN = 200;

const INTERVALS: Record<number, string> = { 60: '1m', 180: '3m', 300: '5m', 900: '15m', 3600: '1h' };

export function intervalFor(timeframeSec: number): string {
  const i = INTERVALS[timeframeSec];
  if (!i) throw new Error(`Unsupported crypto timeframe ${timeframeSec}s (use ${Object.keys(INTERVALS).join('/')})`);
  return i;
}

/** Bases that make a USDT pair a stable-stable or leveraged-token pair — no signal there. */
const EXCLUDE_BASE = /(UP|DOWN|BULL|BEAR)$|^(USDC|FDUSD|TUSD|DAI|EUR|USDP|BUSD|AEUR|USD1|XUSD)$/;

/** Top spot USDT pairs by 24h quote volume (the liquid, tradeable universe). */
export async function topUsdtPairs(n: number): Promise<string[]> {
  const res = await fetch(`${REST}/api/v3/ticker/24hr`);
  if (!res.ok) throw new Error(`Binance 24hr ticker failed: ${res.status}`);
  const rows = (await res.json()) as { symbol: string; quoteVolume: string }[];
  return rows
    .filter((r) => r.symbol.endsWith('USDT') && !EXCLUDE_BASE.test(r.symbol.slice(0, -4)))
    .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))
    .slice(0, n)
    .map((r) => r.symbol);
}

/** Last `limit` CLOSED candles for one symbol — used to warm the streak engine at startup. */
export async function recentCandles(symbol: string, timeframeSec: number, limit: number): Promise<Candle[]> {
  const res = await fetch(`${REST}/api/v3/klines?symbol=${symbol}&interval=${intervalFor(timeframeSec)}&limit=${limit + 1}`);
  if (!res.ok) throw new Error(`Binance klines failed for ${symbol}: ${res.status}`);
  const rows = (await res.json()) as [number, string, string, string, string, string, number, string, number, ...unknown[]][];
  const now = Date.now();
  return rows
    .filter((k) => k[6] < now) // closeTime in the past = candle is closed
    .slice(-limit)
    .map((k) => ({
      symbol,
      periodStart: Math.floor(k[0] / 1000),
      timeframeSec,
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      ticks: k[8],
    }));
}

interface KlineMsg {
  data?: {
    e?: string;
    k?: { t: number; s: string; i: string; o: string; h: string; l: string; c: string; n: number; x: boolean };
  };
}

export interface FeedStatus {
  conns: number;
  open: number;
  symbols: number;
  lastEventAt: number;
}

/**
 * Streams closed klines for a set of symbols as Candle objects. Handles
 * chunking across connections, and reconnects each socket with backoff
 * (Binance also recycles connections every 24 h — that's just a reconnect).
 */
export class BinanceKlineFeed {
  private sockets: (WebSocket | null)[] = [];
  private stopped = false;
  private lastEventAt = Date.now();

  constructor(
    private readonly symbols: string[],
    private readonly timeframeSec: number,
    private readonly onCandle: (c: Candle) => void,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  start(): void {
    this.stopped = false;
    const interval = intervalFor(this.timeframeSec);
    const chunks: string[][] = [];
    for (let i = 0; i < this.symbols.length; i += MAX_STREAMS_PER_CONN) {
      chunks.push(this.symbols.slice(i, i + MAX_STREAMS_PER_CONN));
    }
    this.sockets = chunks.map(() => null);
    chunks.forEach((chunk, idx) => this.connect(idx, chunk, interval, 0));
  }

  private connect(idx: number, chunk: string[], interval: string, attempt: number): void {
    if (this.stopped) return;
    const streams = chunk.map((s) => `${s.toLowerCase()}@kline_${interval}`).join('/');
    const ws = new WebSocket(`${WS}/stream?streams=${streams}`);
    this.sockets[idx] = ws;

    ws.onopen = () => {
      attempt = 0;
      this.log(`[binance] socket ${idx + 1} open (${chunk.length} pairs)`);
    };
    ws.onmessage = (ev: MessageEvent) => {
      this.lastEventAt = Date.now();
      let msg: KlineMsg;
      try { msg = JSON.parse(String(ev.data)) as KlineMsg; } catch { return; }
      const k = msg.data?.k;
      if (!k || !k.x) return; // only CLOSED klines drive the pipeline
      this.onCandle({
        symbol: k.s,
        periodStart: Math.floor(k.t / 1000),
        timeframeSec: this.timeframeSec,
        open: Number(k.o),
        high: Number(k.h),
        low: Number(k.l),
        close: Number(k.c),
        ticks: k.n,
      });
    };
    ws.onclose = () => {
      if (this.stopped) return;
      const delay = Math.min(1000 * 2 ** attempt, 60_000);
      this.log(`[binance] socket ${idx + 1} closed — reconnecting in ${Math.round(delay / 1000)}s`);
      setTimeout(() => this.connect(idx, chunk, interval, attempt + 1), delay);
    };
    ws.onerror = () => { /* onclose follows and handles the retry */ };
  }

  status(): FeedStatus {
    return {
      conns: this.sockets.length,
      open: this.sockets.filter((s) => s?.readyState === WebSocket.OPEN).length,
      symbols: this.symbols.length,
      lastEventAt: this.lastEventAt,
    };
  }

  stop(): void {
    this.stopped = true;
    for (const s of this.sockets) s?.close();
  }
}
