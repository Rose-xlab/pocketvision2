/**
 * Alert outcome tracking (#1 on the hardening list).
 *
 * Every sent alert is registered here; when the NEXT candle for that symbol
 * closes, the outcome is resolved and appended to a JSONL log:
 *
 *   reversal      — the next candle closed against the streak direction
 *                   (the "streak exhaustion" hypothesis won)
 *   continuation  — the next candle extended the streak (hypothesis lost)
 *   doji          — the next candle closed exactly flat (broker refund case)
 *   void          — the next candle was never seen (feed gap) → not scoreable
 *
 * The next candle's RAW colour (exact open/close compare, no body filter) is
 * used because that is how a binary option actually pays out. Full OHLC is
 * recorded so stricter definitions can be analysed later from the log.
 *
 * Analyse with:  npm run report
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Candle } from './candles.js';
import { colourOf, type StreakAlert } from './streaks.js';

export interface OutcomeRecord {
  /** ISO timestamp when the outcome was resolved. */
  at: string;
  symbol: string;
  label?: string;
  payout?: number;
  /** Streak length and colour that triggered the alert. */
  streak: number;
  colour: 'green' | 'red';
  timeframeSec: number;
  /** periodStart (epoch sec) of the streak's last candle. */
  alertPeriodStart: number;
  outcome: 'reversal' | 'continuation' | 'doji' | 'void';
  /** The candle that resolved it (absent for void). */
  next?: { periodStart: number; open: number; high: number; low: number; close: number };
}

interface Pending {
  alert: StreakAlert;
  payout?: number;
  label?: string;
  /** periodStart the resolving candle must have. */
  expected: number;
}

export class OutcomeTracker {
  private readonly pending = new Map<string, Pending>();
  private readonly counts = { reversal: 0, continuation: 0, doji: 0, void: 0 };

  /** `file` optional so the tracker can run in-memory (tests). */
  constructor(private readonly file?: string) {
    if (file) fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  /** Call when an alert is actually sent. */
  register(alert: StreakAlert, meta: { payout?: number; label?: string } = {}): void {
    this.pending.set(alert.symbol, {
      alert,
      ...meta,
      expected: alert.candle.periodStart + alert.candle.timeframeSec,
    });
  }

  /**
   * Feed EVERY closed candle (before the streak engine, so an alert fired by
   * this same candle registers fresh afterwards). Returns the resolved
   * outcome, if this candle settled one.
   */
  onCandle(candle: Candle): OutcomeRecord | null {
    const p = this.pending.get(candle.symbol);
    if (!p || candle.periodStart < p.expected) return null;
    this.pending.delete(candle.symbol);

    const gap = candle.periodStart > p.expected;
    const nextColour = gap ? null : colourOf(candle); // raw colour = payout truth
    const outcome: OutcomeRecord['outcome'] =
      gap ? 'void'
      : nextColour === 'doji' ? 'doji'
      : nextColour === p.alert.colour ? 'continuation'
      : 'reversal';
    this.counts[outcome]++;

    const rec: OutcomeRecord = {
      at: new Date().toISOString(),
      symbol: p.alert.symbol,
      label: p.label,
      payout: p.payout,
      streak: p.alert.count,
      colour: p.alert.colour,
      timeframeSec: p.alert.candle.timeframeSec,
      alertPeriodStart: p.alert.candle.periodStart,
      outcome,
      ...(gap ? {} : { next: { periodStart: candle.periodStart, open: candle.open, high: candle.high, low: candle.low, close: candle.close } }),
    };
    if (this.file) fs.appendFileSync(this.file, `${JSON.stringify(rec)}\n`);
    return rec;
  }

  /** One-line session summary for status lines / heartbeats. */
  summary(): string {
    const { reversal, continuation, doji, void: v } = this.counts;
    const decided = reversal + continuation;
    const rate = decided > 0 ? `${((reversal / decided) * 100).toFixed(1)}%` : '—';
    return `outcomes: ${reversal}W/${continuation}L rev-rate ${rate}${doji ? ` doji ${doji}` : ''}${v ? ` gap ${v}` : ''}`;
  }
}
