/**
 * Streak detection engine (brief §6).
 *
 * For each symbol, tracks the current run of same-colour closed candles and
 * emits an alert when the run reaches the threshold — then again only when it
 * EXTENDS (7, then 8, then 9…), never duplicating the same count.
 *
 * Colour: close > open → green, close < open → red, close == open → doji.
 * Doji breaks the streak by default (configurable: break vs. ignore).
 *
 * Body-size filter: on 5-decimal feeds, open === close almost never happens,
 * so a candle whose body is a tiny fraction of the asset's typical range
 * (market noise, not direction) is ALSO classified doji. The threshold is
 * minBodyPct % of the asset's average range over its last `RANGE_WINDOW`
 * candles; it engages only after `RANGE_WARMUP` candles have been seen.
 *
 * Dedup/restart safety: `lastAlerted` per symbol is part of the serializable
 * state (snapshot/restore), so restarting the scanner does not re-alert a
 * streak that was already alerted (brief acceptance test §10).
 */
import type { Candle } from './candles.js';

export type Colour = 'green' | 'red' | 'doji';

export interface StreakConfig {
  /** Alert when the run reaches this length. Default 7. */
  threshold: number;
  /** true → doji resets the streak; false → doji is ignored (streak unchanged). */
  breakOnDoji: boolean;
  /**
   * Minimum candle body as a % of the asset's recent average range for the
   * candle to count as green/red; smaller bodies are treated as doji.
   * 0 (default) disables the filter — only open === close is doji.
   */
  minBodyPct?: number;
}

const RANGE_WINDOW = 20;
const RANGE_WARMUP = 5;

export interface SymbolState {
  colour: Exclude<Colour, 'doji'> | null;
  count: number;
  /** Highest count already alerted for the current run (0 = none). */
  lastAlerted: number;
  /** periodStart of the last candle processed — used for gap detection. */
  lastPeriodStart?: number;
}

export interface StreakAlert {
  symbol: string;
  colour: 'green' | 'red';
  count: number;
  candle: Candle;
}

export function colourOf(candle: Candle, minBody = 0): Colour {
  if (Math.abs(candle.close - candle.open) < minBody) return 'doji';
  if (candle.close > candle.open) return 'green';
  if (candle.close < candle.open) return 'red';
  return 'doji';
}

export class StreakEngine {
  private readonly state = new Map<string, SymbolState>();
  /** Rolling high-low ranges per symbol, for the body-size filter. */
  private readonly ranges = new Map<string, number[]>();

  constructor(private readonly config: StreakConfig) {}

  /** Absolute body threshold for this symbol, from its recent average range. */
  private minBodyFor(symbol: string): number {
    const pct = this.config.minBodyPct ?? 0;
    if (pct <= 0) return 0;
    const win = this.ranges.get(symbol);
    if (!win || win.length < RANGE_WARMUP) return 0;
    const avg = win.reduce((a, b) => a + b, 0) / win.length;
    return (pct / 100) * avg;
  }

  private pushRange(symbol: string, range: number): void {
    const win = this.ranges.get(symbol) ?? [];
    win.push(range);
    if (win.length > RANGE_WINDOW) win.shift();
    this.ranges.set(symbol, win);
  }

  /** Feed one CLOSED candle. Returns an alert if the run hit/extended threshold. */
  onCandle(candle: Candle): StreakAlert | null {
    // Classify against PRIOR candles' ranges, then record this candle's range.
    const colour = colourOf(candle, this.minBodyFor(candle.symbol));
    this.pushRange(candle.symbol, candle.high - candle.low);
    const st: SymbolState = this.state.get(candle.symbol) ?? { colour: null, count: 0, lastAlerted: 0 };

    // Gap detection (brief §6): if this candle isn't adjacent to the previous
    // one (a dropped connection, downtime, or a missed minute), the run cannot
    // be treated as continuous — reset before applying this candle.
    if (st.lastPeriodStart != null && candle.periodStart !== st.lastPeriodStart + candle.timeframeSec) {
      st.colour = null;
      st.count = 0;
      st.lastAlerted = 0;
    }
    st.lastPeriodStart = candle.periodStart;

    if (colour === 'doji') {
      if (this.config.breakOnDoji) { st.colour = null; st.count = 0; st.lastAlerted = 0; }
      // ignore: run untouched (but lastPeriodStart already advanced).
      this.state.set(candle.symbol, st);
      return null;
    }

    if (st.colour === colour) {
      st.count += 1;
    } else {
      st.colour = colour;
      st.count = 1;
      st.lastAlerted = 0;
    }

    let alert: StreakAlert | null = null;
    if (st.count >= this.config.threshold && st.count > st.lastAlerted) {
      st.lastAlerted = st.count;
      alert = { symbol: candle.symbol, colour, count: st.count, candle };
    }

    this.state.set(candle.symbol, st);
    return alert;
  }

  /** Current run for a symbol (for dashboards/status). */
  peek(symbol: string): SymbolState | undefined {
    return this.state.get(symbol);
  }

  /** Serializable snapshot of all streak state — persist this for restart safety. */
  snapshot(): Record<string, SymbolState> {
    return Object.fromEntries(this.state);
  }

  /** Restore a previously persisted snapshot (call before feeding candles). */
  restore(snap: Record<string, SymbolState>): void {
    this.state.clear();
    for (const [symbol, st] of Object.entries(snap)) this.state.set(symbol, { ...st });
  }
}
