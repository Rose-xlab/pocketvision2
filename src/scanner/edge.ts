/**
 * Edge measurement — the maths that decides whether a setup is tradeable.
 *
 * Reads outcomes.jsonl (old and new format records) and computes, per bucket,
 * the win rate with a Wilson 95% confidence interval and the expected value
 * per unit staked at the bucket's real average payout. A bucket GRADUATES
 * only when even the CI's lower bound is profitable on a decent sample —
 * that's the bar for risking money, everything else is paper.
 *
 * Directions: RIDE = bet the streak continues (the direction the data
 * supports); FADE = bet reversal (the original hypothesis — proven loser).
 * "Win" for ride = continuation; for fade = reversal. Flat/void excluded.
 */
import fs from 'node:fs';
import type { OutcomeRecord, RideOutcome } from './outcomes.js';

export type AssetClass = 'forex' | 'crypto' | 'stock/index';

/** Classify from the PO catalog type when present, else legacy heuristics. */
export function classifyAsset(assetType?: string, label?: string, symbol?: string): AssetClass {
  const t = (assetType ?? '').toLowerCase();
  if (t.includes('crypto')) return 'crypto'; // before 'curren' — "cryptocurrency" contains both
  if (t.includes('curren')) return 'forex';
  if (t) return 'stock/index';
  if ((label ?? '').includes('/')) return 'forex';
  if (/-USD|bitcoin|ethereum|coin|solana|cardano|polkadot|polygon|tron|chainlink|\bbnb\b|ripple|doge|litecoin|matic/i.test(`${symbol ?? ''} ${label ?? ''}`)) return 'crypto';
  return 'stock/index';
}

/** Wilson 95% CI for w wins in n trials. */
export function wilson(w: number, n: number): [number, number] {
  if (n === 0) return [0, 1];
  const z = 1.96;
  const p = w / n;
  const d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const margin = (z / d) * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, centre - margin), Math.min(1, centre + margin)];
}

export interface EdgeStats {
  n: number;
  wins: number;
  winRate: number;
  ci: [number, number];
  /** Average payout fraction (0.92 = 92%) across the bucket's trades. */
  avgPayout: number;
  /** Break-even win rate at that payout. */
  breakEven: number;
  /** Expected value per unit staked, at the observed win rate. */
  ev: number;
  /** EV at the CI lower bound — the pessimistic-but-plausible case. */
  evLo: number;
  status: 'GRADUATED' | 'candidate' | 'negative' | 'insufficient';
  /** True when the rolling window has dropped below break-even while the
   *  all-time stats still look fine — edge is dying, GRADUATED is demoted. */
  decayed?: boolean;
  /** Rolling last-`ROLLING_WINDOW` view behind the decay verdict. */
  rolling?: { n: number; winRate: number; breakEven: number };
}

/** Sample size before a positive EV can graduate to real-money status. */
export const GRADUATE_MIN_N = 200;
const MIN_N = 30;

export function edgeStats(wins: number, losses: number, payoutSum: number): EdgeStats {
  const n = wins + losses;
  const avgPayout = n > 0 ? payoutSum / n / 100 : 0.92;
  const winRate = n > 0 ? wins / n : 0;
  const ci = wilson(wins, n);
  const breakEven = 1 / (1 + avgPayout);
  const ev = winRate * avgPayout - (1 - winRate);
  const evLo = ci[0] * avgPayout - (1 - ci[0]);
  const status: EdgeStats['status'] =
    n < MIN_N ? 'insufficient'
    : evLo > 0 && n >= GRADUATE_MIN_N ? 'GRADUATED'
    : ev > 0 ? 'candidate'
    : 'negative';
  return { n, wins, winRate, ci, avgPayout, breakEven, ev, evLo, status };
}

/** Ride result at 1-based expiry i, for old- and new-format records alike. */
export function rideAt(rec: OutcomeRecord, i: number): RideOutcome | undefined {
  if (rec.ride && rec.ride.length >= i) return rec.ride[i - 1];
  if (i !== 1) return undefined; // old records only scored one candle
  switch (rec.outcome) {
    case 'continuation': return 'win';
    case 'reversal': return 'loss';
    case 'doji': return 'flat';
    default: return 'void';
  }
}

/**
 * Holdout split — the multiple-comparisons killer. Chronological halves:
 * a bucket found by scanning many slices will look good on the whole sample
 * by luck alone; a REAL edge is positive in the first half AND the second.
 */
export function splitHoldout(records: OutcomeRecord[]): [OutcomeRecord[], OutcomeRecord[]] {
  const sorted = [...records].sort((a, b) => a.at.localeCompare(b.at));
  const mid = Math.floor(sorted.length / 2);
  return [sorted.slice(0, mid), sorted.slice(mid)];
}

export function loadOutcomes(file: string): OutcomeRecord[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l) as OutcomeRecord; } catch { return null; } })
    .filter((r): r is OutcomeRecord => r !== null);
}

/** Rolling decay window: the last N decided trades per class. */
export const ROLLING_WINDOW = 100;
/** Minimum rolling sample before a decay verdict is meaningful. */
export const ROLLING_MIN_N = 40;

interface Bucket {
  wins: number;
  losses: number;
  payoutSum: number;
  /** Last `ROLLING_WINDOW` decided results, oldest first. */
  recent: { win: boolean; payout: number }[];
}
const newBucket = (): Bucket => ({ wins: 0, losses: 0, payoutSum: 0, recent: [] });

/**
 * Live per-asset-class ride edge, kept current as outcomes resolve.
 * The scanner uses it to stamp every alert with the measured edge for that
 * setup — the alert carries its own evidence.
 *
 * Decay monitor: alongside the all-time tally, each class keeps a rolling
 * window of its last `ROLLING_WINDOW` decided trades. If the rolling win rate
 * falls below the rolling break-even while the all-time stats still say
 * GRADUATED/candidate, the edge is treated as DECAYED: `rideStats` demotes
 * GRADUATED → candidate (paper) automatically, and `decayAlarm` returns a
 * one-shot message on each ok→decayed / decayed→ok transition so the scanner
 * can notify Telegram without spamming it.
 */
export class EdgeBook {
  private readonly byClass = new Map<AssetClass, Bucket>();
  /** Last decay state per class, for transition-only alarms. */
  private readonly alarmState = new Map<AssetClass, boolean>();

  constructor(file?: string) {
    if (file) for (const rec of loadOutcomes(file)) this.add(rec);
  }

  /** Ingest one resolved record (expiry-1 result is enough). */
  add(rec: OutcomeRecord): void {
    const r1 = rideAt(rec, 1);
    if (r1 !== 'win' && r1 !== 'loss') return;
    const cls = classifyAsset(rec.assetType, rec.label, rec.symbol);
    const b = this.byClass.get(cls) ?? newBucket();
    if (r1 === 'win') b.wins++; else b.losses++;
    b.payoutSum += rec.payout ?? 92;
    b.recent.push({ win: r1 === 'win', payout: rec.payout ?? 92 });
    if (b.recent.length > ROLLING_WINDOW) b.recent.shift();
    this.byClass.set(cls, b);
  }

  /** Rolling-window stats only (the decay monitor's view). */
  rollingStats(cls: AssetClass): EdgeStats {
    const b = this.byClass.get(cls) ?? newBucket();
    const wins = b.recent.filter((r) => r.win).length;
    const losses = b.recent.length - wins;
    return edgeStats(wins, losses, b.recent.reduce((s, r) => s + r.payout, 0));
  }

  /** True when the recent window is losing while all-time still looks fine. */
  isDecayed(cls: AssetClass): boolean {
    const b = this.byClass.get(cls) ?? newBucket();
    if (b.recent.length < ROLLING_MIN_N) return false;
    const all = edgeStats(b.wins, b.losses, b.payoutSum);
    if (all.status !== 'GRADUATED' && all.status !== 'candidate') return false; // nothing to protect
    const roll = this.rollingStats(cls);
    return roll.winRate < roll.breakEven;
  }

  /** All-time stats with the decay demotion applied (GRADUATED → candidate). */
  rideStats(cls: AssetClass): EdgeStats {
    const b = this.byClass.get(cls) ?? newBucket();
    const s = edgeStats(b.wins, b.losses, b.payoutSum);
    const roll = this.rollingStats(cls);
    s.rolling = { n: roll.n, winRate: roll.winRate, breakEven: roll.breakEven };
    if (this.isDecayed(cls)) {
      s.decayed = true;
      if (s.status === 'GRADUATED') s.status = 'candidate'; // back to paper
    }
    return s;
  }

  /**
   * One-shot transition alarm. Call after every `add`; returns a message the
   * first time a class flips ok→decayed (or recovers), null otherwise.
   */
  decayAlarm(cls: AssetClass): string | null {
    const now = this.isDecayed(cls);
    const before = this.alarmState.get(cls) ?? false;
    if (now === before) return null;
    this.alarmState.set(cls, now);
    const roll = this.rollingStats(cls);
    const pf = (x: number) => `${(x * 100).toFixed(1)}%`;
    return now
      ? `🚨 EDGE DECAY: ${cls} ride — rolling last ${roll.n} trades at ${pf(roll.winRate)} win, below break-even ${pf(roll.breakEven)}. ` +
        `Auto-demoted to PAPER ONLY until the rolling window recovers.`
      : `✅ EDGE RECOVERED: ${cls} ride — rolling window back above break-even (${pf(roll.winRate)} on last ${roll.n}).`;
  }
}
