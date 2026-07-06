/**
 * Alert outcome tracking (#1 on the hardening list) — v2, multi-expiry.
 *
 * Every sent alert is registered here and scored against the candles that
 * follow it, exactly the way a binary trade placed at the alert would resolve:
 * entry (strike) = open of the NEXT candle, then win/loss at 1-, 2- and
 * 3-candle expiries by comparing that candle's close to the strike.
 *
 * The legacy `outcome` field keeps its original meaning (next candle's colour
 * vs. the streak):
 *
 *   reversal      — the next candle closed against the streak direction
 *   continuation  — the next candle extended the streak
 *   doji          — the next candle closed exactly flat (broker refund case)
 *   void          — the next candle was never seen (feed gap) → not scoreable
 *
 * v2 adds per-record features (asset class, last-candle body/range, entry
 * price) and `ride[]` — the RIDE-the-streak result at each expiry — so the
 * report can measure both directions at three expiries from one log.
 *
 * A record is appended to the JSONL only when fully resolved (all three
 * expiries scored or voided); the record object is RETURNED to the caller at
 * first resolution so console/Supabase behaviour is unchanged. Call `tick()`
 * periodically to time out pendings whose candles never arrive.
 *
 * Analyse with:  npm run report
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Candle } from './candles.js';
import { colourOf, type StreakAlert } from './streaks.js';

export const EXPIRIES = 3;
/** Give rotation/backfill this long to deliver the post-alert candles. */
const FINALIZE_TIMEOUT_SEC = 15 * 60;
/**
 * Realistic-entry delay: a human reading a Telegram alert (or a delayed
 * executor) enters ~this many seconds AFTER the entry candle opens. We record
 * the first tick at/after that moment as `entryReal`, so the report can show
 * the edge at the entry you actually get — not just the ideal next-open.
 */
export const REAL_ENTRY_DELAY_SEC = 10;

export type RideOutcome = 'win' | 'loss' | 'flat' | 'void';

interface NextCandle { periodStart: number; open: number; high: number; low: number; close: number }

export interface OutcomeRecord {
  /** ISO timestamp when the outcome was first resolved. */
  at: string;
  symbol: string;
  label?: string;
  payout?: number;
  /** PO catalog class of the asset (currency/cryptocurrency/stock/…). */
  assetType?: string;
  /** Streak length and colour that triggered the alert. */
  streak: number;
  colour: 'green' | 'red';
  timeframeSec: number;
  /** periodStart (epoch sec) of the streak's last candle. */
  alertPeriodStart: number;
  /** Final streak candle's body and range — trend strength at alert time. */
  lastBody?: number;
  lastRange?: number;
  /** Simulated strike: open of the first post-alert candle. */
  entry?: number;
  /** Realistic strike: first tick ≥ `entryRealDelaySec` into the entry candle
   *  (what a human/delayed executor actually gets). Absent when no live tick
   *  arrived inside the entry candle (rotated/backfilled pairs). */
  entryReal?: number;
  entryRealDelaySec?: number;
  /** RIDE result at expiry 1..3 scored against `entryReal` instead of `entry`. */
  rideReal?: RideOutcome[];
  /** Legacy 1-candle result (next candle's colour vs. the streak). */
  outcome: 'reversal' | 'continuation' | 'doji' | 'void';
  /** The candle that resolved expiry 1 (absent for void). */
  next?: NextCandle;
  /** RIDE-the-streak result at expiry 1..3 (close vs. entry). */
  ride?: RideOutcome[];
  /** Post-alert candles 1..3 (null where that minute never arrived). */
  nexts?: (NextCandle | null)[];
}

interface Pending {
  alert: StreakAlert;
  payout?: number;
  label?: string;
  assetType?: string;
  /** Next expiry to resolve (1-based). */
  expiry: number;
  entry?: number;
  /** First tick price at/after the realistic-entry moment (see onTick). */
  entryReal?: number;
  ride: RideOutcome[];
  nexts: (NextCandle | null)[];
  record?: OutcomeRecord;
  /** Epoch sec after which unresolved expiries are declared void. */
  deadline: number;
}

export class OutcomeTracker {
  private readonly pending = new Map<string, Pending[]>();
  private readonly counts = { reversal: 0, continuation: 0, doji: 0, void: 0 };

  /** `file` optional so the tracker can run in-memory (tests); `onFinal`
   *  fires when a record is fully resolved (all expiries) — tests/EdgeBook. */
  constructor(
    private readonly file?: string,
    private readonly onFinal?: (rec: OutcomeRecord) => void,
    private readonly realEntryDelaySec = REAL_ENTRY_DELAY_SEC,
  ) {
    if (file) fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  /**
   * Feed raw ticks (live stream only is fine). Captures `entryReal` — the
   * first tick at/after `realEntryDelaySec` into the entry candle — for every
   * pending alert on that symbol. Ticks after the entry candle ends are
   * ignored: a 1-minute trade entered a minute late is a different trade.
   */
  onTick(symbol: string, ts: number, price: number): void {
    const list = this.pending.get(symbol);
    if (!list) return;
    for (const p of list) {
      if (p.entryReal !== undefined) continue;
      const tf = p.alert.candle.timeframeSec;
      const entryOpen = p.alert.candle.periodStart + tf;
      if (ts >= entryOpen + this.realEntryDelaySec && ts < entryOpen + tf) p.entryReal = price;
    }
  }

  /** Call when an alert is actually sent. */
  register(alert: StreakAlert, meta: { payout?: number; label?: string; assetType?: string } = {}): void {
    const list = this.pending.get(alert.symbol) ?? [];
    list.push({
      alert,
      ...meta,
      expiry: 1,
      ride: [],
      nexts: [],
      deadline: alert.candle.periodStart + (EXPIRIES + 1) * alert.candle.timeframeSec + FINALIZE_TIMEOUT_SEC,
    });
    this.pending.set(alert.symbol, list);
  }

  /**
   * Feed EVERY closed candle (before the streak engine, so an alert fired by
   * this same candle registers fresh afterwards). Returns records that just
   * got their FIRST (expiry-1) resolution — print/persist those as before.
   */
  onCandle(candle: Candle): OutcomeRecord[] {
    const list = this.pending.get(candle.symbol);
    if (!list || list.length === 0) return [];
    const resolved: OutcomeRecord[] = [];
    for (const p of [...list]) {
      const rec = this.advance(p, candle);
      if (rec) resolved.push(rec);
      if (p.expiry > EXPIRIES) this.finalize(candle.symbol, p);
    }
    return resolved;
  }

  /** Time out pendings whose candles never arrived. Call ~once a second. */
  tick(nowSec: number): OutcomeRecord[] {
    const resolved: OutcomeRecord[] = [];
    for (const [symbol, list] of this.pending) {
      for (const p of [...list]) {
        if (nowSec < p.deadline) continue;
        if (p.expiry === 1) {
          resolved.push(this.firstResolve(p, null));
        }
        while (p.expiry <= EXPIRIES) { p.ride.push('void'); p.nexts.push(null); p.expiry++; }
        this.finalize(symbol, p);
      }
    }
    return resolved;
  }

  /** Apply one candle to one pending; returns the record on first resolution. */
  private advance(p: Pending, candle: Candle): OutcomeRecord | null {
    const tf = p.alert.candle.timeframeSec;
    let first: OutcomeRecord | null = null;
    while (p.expiry <= EXPIRIES) {
      const expected = p.alert.candle.periodStart + p.expiry * tf;
      if (candle.periodStart < expected) break; // not there yet
      if (candle.periodStart > expected) {
        // That minute never arrived (feed gap): void this expiry, keep going —
        // a later expiry can still score off the same entry price.
        if (p.expiry === 1) {
          // Entry price unknown → nothing is scoreable. Void the whole trade.
          first = this.firstResolve(p, null);
          while (p.expiry <= EXPIRIES) { p.ride.push('void'); p.nexts.push(null); p.expiry++; }
          return first;
        }
        p.ride.push('void');
        p.nexts.push(null);
        p.expiry++;
        continue;
      }
      // candle.periodStart === expected → score this expiry.
      const nc: NextCandle = { periodStart: candle.periodStart, open: candle.open, high: candle.high, low: candle.low, close: candle.close };
      if (p.expiry === 1) {
        p.entry = candle.open;
        first = this.firstResolve(p, nc);
      }
      const entry = p.entry!;
      const ride: RideOutcome =
        candle.close === entry ? 'flat'
        : (p.alert.colour === 'green' ? candle.close > entry : candle.close < entry) ? 'win'
        : 'loss';
      p.ride.push(ride);
      p.nexts.push(nc);
      p.expiry++;
      break; // one candle scores at most one expiry
    }
    return first;
  }

  /** Build the record at expiry-1 resolution (candle, or null = void). */
  private firstResolve(p: Pending, next: NextCandle | null): OutcomeRecord {
    const nextColour = next ? colourOf({ ...next, symbol: p.alert.symbol, timeframeSec: p.alert.candle.timeframeSec, ticks: 0 }) : null;
    const outcome: OutcomeRecord['outcome'] =
      next === null ? 'void'
      : nextColour === 'doji' ? 'doji'
      : nextColour === p.alert.colour ? 'continuation'
      : 'reversal';
    this.counts[outcome]++;
    const c = p.alert.candle;
    p.record = {
      at: new Date().toISOString(),
      symbol: p.alert.symbol,
      label: p.label,
      payout: p.payout,
      assetType: p.assetType,
      streak: p.alert.count,
      colour: p.alert.colour,
      timeframeSec: c.timeframeSec,
      alertPeriodStart: c.periodStart,
      lastBody: Math.abs(c.close - c.open),
      lastRange: c.high - c.low,
      ...(next ? { entry: next.open } : {}),
      outcome,
      ...(next ? { next } : {}),
    };
    return p.record;
  }

  /** All expiries resolved/voided: attach arrays, write to disk, drop pending. */
  private finalize(symbol: string, p: Pending): void {
    const list = this.pending.get(symbol);
    if (list) {
      const i = list.indexOf(p);
      if (i >= 0) list.splice(i, 1);
      if (list.length === 0) this.pending.delete(symbol);
    }
    const rec = p.record;
    if (!rec) return;
    rec.ride = p.ride;
    rec.nexts = p.nexts;
    // Score the realistic entry against the same post-alert closes, so the
    // report can put the ideal and achievable edges side by side.
    if (p.entryReal !== undefined) {
      rec.entryReal = p.entryReal;
      rec.entryRealDelaySec = this.realEntryDelaySec;
      const dir = p.alert.colour;
      rec.rideReal = p.nexts.map((nc): RideOutcome => {
        if (!nc) return 'void';
        if (nc.close === p.entryReal) return 'flat';
        return (dir === 'green' ? nc.close > p.entryReal! : nc.close < p.entryReal!) ? 'win' : 'loss';
      });
    }
    if (this.file) fs.appendFileSync(this.file, `${JSON.stringify(rec)}\n`);
    this.onFinal?.(rec);
  }

  /** One-line session summary for status lines / heartbeats. */
  summary(): string {
    const { reversal, continuation, doji, void: v } = this.counts;
    const decided = reversal + continuation;
    // W/L from the RIDE perspective now: continuation = the ride trade won.
    const rate = decided > 0 ? `${((continuation / decided) * 100).toFixed(1)}%` : '—';
    return `outcomes: ${continuation}W/${reversal}L ride-rate ${rate}${doji ? ` doji ${doji}` : ''}${v ? ` gap ${v}` : ''}`;
  }
}
