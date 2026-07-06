/**
 * Risk manager (Phase 2) — the gate every real-money stake must pass.
 *
 * What the top shops actually get right isn't prediction, it's survival:
 * a strategy is allowed to be wrong many times in a row without ending the
 * account. This module enforces that:
 *
 *   • Quarter-Kelly sizing from the bucket's LIVE EdgeStats, using the CI
 *     LOWER bound as the win probability — stakes start tiny when an edge has
 *     barely graduated and grow only as the evidence hardens.
 *   • Only GRADUATED, non-decayed buckets may stake at all.
 *   • Per-day loss stop: lose `dailyStopPct` of bankroll in a (UTC) day → no
 *     more stakes until tomorrow.
 *   • Kill switch: drawdown from the equity peak beyond `maxDrawdownPct` →
 *     ALL staking blocked until a human calls `resetKill()` (re-validation).
 *
 * State (equity, peak, day PnL, kill flag) persists to a JSON file so a
 * restart can't forget that the day was already lost.
 *
 * Kelly for a binary payout b (win +b, lose −1):  f* = (p·(1+b) − 1) / b.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { EdgeStats } from '../scanner/edge.js';

export interface RiskConfig {
  /** Total bankroll, account currency. 0 = paper mode (stakes reported as % only). */
  bankroll: number;
  /** Fraction of full Kelly (0.25 = quarter-Kelly). */
  kellyFraction: number;
  /** Hard ceiling on any single stake, % of bankroll. */
  maxStakePct: number;
  /** Daily loss stop, % of bankroll. */
  dailyStopPct: number;
  /** Max drawdown from equity peak before the kill switch trips, %. */
  maxDrawdownPct: number;
}

export interface StakeDecision {
  allowed: boolean;
  /** Stake in account currency (0 in paper mode — use stakePct). */
  stake: number;
  /** Stake as % of bankroll. */
  stakePct: number;
  reason: string;
}

interface RiskState {
  /** Cumulative realized PnL across all strategies (account currency units). */
  equity: number;
  /** Highest equity seen. */
  peak: number;
  /** UTC date (YYYY-MM-DD) the day tallies belong to. */
  day: string;
  /** Realized PnL per strategy for `day`. */
  dayPnl: Record<string, number>;
  killed: boolean;
  killedReason?: string;
}

const freshState = (): RiskState => ({ equity: 0, peak: 0, day: '', dayPnl: {}, killed: false });

/** Full-Kelly fraction for win prob `p` at payout `b` (win +b, lose −1). */
export function kellyFraction(p: number, b: number): number {
  if (b <= 0) return 0;
  return Math.max(0, (p * (1 + b) - 1) / b);
}

export class RiskManager {
  private state: RiskState;

  constructor(
    private readonly cfg: RiskConfig,
    private readonly stateFile?: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.state = freshState();
    if (stateFile && fs.existsSync(stateFile)) {
      try { this.state = { ...freshState(), ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) as RiskState }; }
      catch { /* corrupt state file → start fresh rather than crash the scanner */ }
    }
  }

  private persist(): void {
    if (!this.stateFile) return;
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2));
  }

  private today(): string { return this.now().toISOString().slice(0, 10); }

  /** Roll the day tallies when the UTC date changes. */
  private rollDay(): void {
    const d = this.today();
    if (this.state.day !== d) { this.state.day = d; this.state.dayPnl = {}; }
  }

  private dayLoss(): number {
    return Object.values(this.state.dayPnl).reduce((s, x) => s + Math.min(0, x), 0);
  }

  /**
   * Size a stake for one trade of `strategy` given the bucket's live stats.
   * Conservative by design: p = CI lower bound, quarter-Kelly, hard cap.
   */
  stakeFor(strategy: string, stats: EdgeStats): StakeDecision {
    this.rollDay();
    const no = (reason: string): StakeDecision => ({ allowed: false, stake: 0, stakePct: 0, reason });

    if (this.state.killed) return no(`kill switch tripped (${this.state.killedReason ?? 'drawdown'}) — paper only until resetKill()`);
    if (stats.status !== 'GRADUATED') return no(`bucket not GRADUATED (${stats.status}${stats.decayed ? ', decayed' : ''})`);
    if (stats.decayed) return no('edge decayed — rolling window below break-even');

    const stopLimit = -(this.cfg.dailyStopPct / 100) * Math.max(this.cfg.bankroll, 1);
    if (this.cfg.bankroll > 0 && this.dayLoss() <= stopLimit) {
      return no(`daily stop hit (${this.dayLoss().toFixed(2)} ≤ ${stopLimit.toFixed(2)}) — done for today`);
    }

    const f = this.cfg.kellyFraction * kellyFraction(stats.ci[0], stats.avgPayout);
    if (f <= 0) return no('Kelly at CI floor is zero — edge too thin to size');
    const pct = Math.min(f * 100, this.cfg.maxStakePct);
    const stake = this.cfg.bankroll > 0 ? (pct / 100) * this.cfg.bankroll : 0;
    return {
      allowed: true,
      stake: Math.round(stake * 100) / 100,
      stakePct: Math.round(pct * 100) / 100,
      reason: `quarter-Kelly at CI floor ${(stats.ci[0] * 100).toFixed(1)}% / payout ${(stats.avgPayout * 100).toFixed(0)}%`,
    };
  }

  /** Record one realized result (account currency; negative = loss). */
  recordResult(strategy: string, pnl: number): void {
    this.rollDay();
    this.state.dayPnl[strategy] = (this.state.dayPnl[strategy] ?? 0) + pnl;
    this.state.equity += pnl;
    this.state.peak = Math.max(this.state.peak, this.state.equity);
    const ddLimit = (this.cfg.maxDrawdownPct / 100) * Math.max(this.cfg.bankroll, 1);
    if (this.cfg.bankroll > 0 && this.state.peak - this.state.equity >= ddLimit && !this.state.killed) {
      this.state.killed = true;
      this.state.killedReason = `drawdown ${(this.state.peak - this.state.equity).toFixed(2)} ≥ ${ddLimit.toFixed(2)} from peak`;
    }
    this.persist();
  }

  /** Manual reset after re-validation — deliberate human action, never automatic. */
  resetKill(): void {
    this.state.killed = false;
    delete this.state.killedReason;
    this.persist();
  }

  status(): { equity: number; peak: number; drawdown: number; dayPnl: number; killed: boolean; killedReason?: string } {
    this.rollDay();
    return {
      equity: this.state.equity,
      peak: this.state.peak,
      drawdown: this.state.peak - this.state.equity,
      dayPnl: Object.values(this.state.dayPnl).reduce((s, x) => s + x, 0),
      killed: this.state.killed,
      ...(this.state.killedReason ? { killedReason: this.state.killedReason } : {}),
    };
  }
}
