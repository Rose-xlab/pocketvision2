/**
 * Tick → 1-minute candle builder.
 *
 * Pocket Option's `updateStream` is a TICK feed ([symbol, epochSeconds, price]),
 * not OHLC candles — so we aggregate ticks into fixed-timeframe candles here.
 *
 * Candle boundaries: a tick at epoch `ts` belongs to bucket
 * `floor(ts / timeframe) * timeframe`. A bucket is only reported CLOSED once
 * `now >= bucketEnd + grace`, so a late tick can't flip the colour after the
 * boundary (brief §6, closed-candle grace period). Still-forming candles are
 * never emitted; only closed ones drive streaks.
 *
 * NOTE: open = first tick of the bucket, close = last tick of the bucket. This
 * must be validated against the live PO chart in Phase 2 — if PO uses
 * previous-close as open, swap `open` accordingly.
 */

export interface Tick {
  symbol: string;
  /** Epoch seconds (may be fractional). */
  ts: number;
  price: number;
}

export interface Candle {
  symbol: string;
  /** Epoch seconds at the start of the bucket. */
  periodStart: number;
  timeframeSec: number;
  open: number;
  high: number;
  low: number;
  close: number;
  ticks: number;
}

interface Forming {
  bucket: number;
  open: number;
  high: number;
  low: number;
  close: number;
  ticks: number;
}

export class CandleBuilder {
  private readonly forming = new Map<string, Forming>();

  constructor(
    private readonly timeframeSec = 60,
    private readonly graceSec = 1.5,
  ) {}

  private bucketOf(ts: number): number {
    return Math.floor(ts / this.timeframeSec) * this.timeframeSec;
  }

  /**
   * Feed one tick. Returns any candles that closed as a result (when the tick
   * advances into a later bucket). Ticks for an already-closed bucket are
   * dropped and reported via the return being empty.
   */
  addTick(tick: Tick): Candle[] {
    const bucket = this.bucketOf(tick.ts);
    const cur = this.forming.get(tick.symbol);

    if (!cur) {
      this.forming.set(tick.symbol, this.start(bucket, tick.price));
      return [];
    }

    if (bucket === cur.bucket) {
      cur.high = Math.max(cur.high, tick.price);
      cur.low = Math.min(cur.low, tick.price);
      cur.close = tick.price;
      cur.ticks++;
      return [];
    }

    if (bucket > cur.bucket) {
      // New bucket started → the previous one is closed.
      const closed = this.toCandle(tick.symbol, cur);
      this.forming.set(tick.symbol, this.start(bucket, tick.price));
      return [closed];
    }

    // bucket < cur.bucket: a late tick for a bucket we've already moved past.
    return [];
  }

  /**
   * Time-based close: emit candles whose bucket ended more than `grace` ago,
   * for pairs that have gone quiet (no newer tick to trigger addTick's close).
   * Call periodically (e.g. once a second) with the current epoch seconds.
   */
  flush(nowSec: number): Candle[] {
    const out: Candle[] = [];
    for (const [symbol, cur] of this.forming) {
      const bucketEnd = cur.bucket + this.timeframeSec;
      if (nowSec >= bucketEnd + this.graceSec) {
        out.push(this.toCandle(symbol, cur));
        this.forming.delete(symbol);
      }
    }
    return out;
  }

  private start(bucket: number, price: number): Forming {
    return { bucket, open: price, high: price, low: price, close: price, ticks: 1 };
  }

  private toCandle(symbol: string, f: Forming): Candle {
    return {
      symbol,
      periodStart: f.bucket,
      timeframeSec: this.timeframeSec,
      open: f.open,
      high: f.high,
      low: f.low,
      close: f.close,
      ticks: f.ticks,
    };
  }
}
