/**
 * Funding-rate harvester (Phase 4) — the structural-yield stream, PAPER MODE.
 *
 * The trade (when it goes live): long spot + short perp, delta-neutral, and
 * collect the periodic funding payments longs pay shorts while funding is
 * positive. Income by market structure, not prediction — the retail-scale
 * version of "be the house".
 *
 * This module is the measurement layer first, in keeping with the whole
 * project: paper positions open when annualized funding clears `enterApr`,
 * close when it decays below `exitApr`, accrue funding continuously at the
 * live rate, pay the configured round-trip fee, and journal every event to
 * JSONL so `npm run report` can show REALIZED paper APY with the same honesty
 * as the streak logs. Rates come from public endpoints — no API keys.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface FundingRate {
  source: 'binance' | 'bybit';
  symbol: string;
  /** Funding rate per 8h period, as a fraction (0.0001 = 0.01%). */
  rate8h: number;
  /** Annualized %, assuming the current rate persists (3 payments/day). */
  apr: number;
}

const aprOf = (rate8h: number) => rate8h * 3 * 365 * 100;

/** All USDT-perp funding rates on Binance futures (public, no key). */
export async function fetchBinanceFunding(): Promise<FundingRate[]> {
  const res = await fetch('https://fapi.binance.com/fapi/v1/premiumIndex');
  if (!res.ok) throw new Error(`Binance premiumIndex failed: ${res.status}`);
  const rows = (await res.json()) as { symbol: string; lastFundingRate: string }[];
  return rows
    .filter((r) => r.symbol.endsWith('USDT'))
    .map((r) => ({ source: 'binance' as const, symbol: r.symbol, rate8h: Number(r.lastFundingRate), apr: aprOf(Number(r.lastFundingRate)) }));
}

/** All linear-perp funding rates on Bybit (public, no key). */
export async function fetchBybitFunding(): Promise<FundingRate[]> {
  const res = await fetch('https://api.bybit.com/v5/market/tickers?category=linear');
  if (!res.ok) throw new Error(`Bybit tickers failed: ${res.status}`);
  const body = (await res.json()) as { result?: { list?: { symbol: string; fundingRate: string }[] } };
  return (body.result?.list ?? [])
    .filter((r) => r.symbol.endsWith('USDT') && r.fundingRate !== '')
    .map((r) => ({ source: 'bybit' as const, symbol: r.symbol, rate8h: Number(r.fundingRate), apr: aprOf(Number(r.fundingRate)) }));
}

export interface FundingConfig {
  enterApr: number;
  exitApr: number;
  /** Round-trip cost (open+close, spot+perp legs) as % of notional. */
  feeRoundTripPct: number;
  maxPositions: number;
  /** Paper notional per position. */
  notional: number;
}

export interface PaperPosition {
  source: string;
  symbol: string;
  openedAt: string;
  notional: number;
  aprAtOpen: number;
  /** Funding accrued so far (account currency). */
  accrued: number;
  /** Epoch ms of the last accrual. */
  lastAccrualMs: number;
}

export type FundingEvent =
  | { type: 'open'; at: string; source: string; symbol: string; notional: number; apr: number }
  | { type: 'mark'; at: string; source: string; symbol: string; accrued: number; apr: number }
  | { type: 'close'; at: string; source: string; symbol: string; notional: number; aprAtOpen: number; aprAtClose: number; accrued: number; fees: number; realized: number; holdHours: number };

const EIGHT_H_MS = 8 * 3600 * 1000;
const key = (source: string, symbol: string) => `${source}:${symbol}`;

export class FundingHarvester {
  readonly positions = new Map<string, PaperPosition>();

  constructor(
    private readonly cfg: FundingConfig,
    private readonly journalFile?: string,
    private readonly onEvent?: (e: FundingEvent) => void,
  ) {
    // Rebuild open positions by replaying the journal: open minus close.
    if (journalFile && fs.existsSync(journalFile)) {
      for (const line of fs.readFileSync(journalFile, 'utf8').split('\n').filter(Boolean)) {
        let e: FundingEvent;
        try { e = JSON.parse(line) as FundingEvent; } catch { continue; }
        if (e.type === 'open') {
          this.positions.set(key(e.source, e.symbol), {
            source: e.source, symbol: e.symbol, openedAt: e.at, notional: e.notional,
            aprAtOpen: e.apr, accrued: 0, lastAccrualMs: Date.parse(e.at),
          });
        } else if (e.type === 'mark') {
          const p = this.positions.get(key(e.source, e.symbol));
          if (p) { p.accrued = e.accrued; p.lastAccrualMs = Date.parse(e.at); }
        } else if (e.type === 'close') {
          this.positions.delete(key(e.source, e.symbol));
        }
      }
    }
  }

  private emit(e: FundingEvent): void {
    if (this.journalFile) {
      fs.mkdirSync(path.dirname(this.journalFile), { recursive: true });
      fs.appendFileSync(this.journalFile, `${JSON.stringify(e)}\n`);
    }
    this.onEvent?.(e);
  }

  /**
   * One poll cycle: accrue funding on open positions at the live rate, close
   * what has decayed, open the best new candidates. Returns the events.
   */
  step(rates: FundingRate[], nowMs = Date.now()): FundingEvent[] {
    const events: FundingEvent[] = [];
    const at = new Date(nowMs).toISOString();
    const bySymbol = new Map(rates.map((r) => [key(r.source, r.symbol), r]));

    // 1) Accrue + close decayed positions.
    for (const p of [...this.positions.values()]) {
      const r = bySymbol.get(key(p.source, p.symbol));
      if (r) {
        p.accrued += p.notional * r.rate8h * ((nowMs - p.lastAccrualMs) / EIGHT_H_MS);
        p.lastAccrualMs = nowMs;
      }
      const aprNow = r?.apr ?? 0;
      if (aprNow < this.cfg.exitApr) {
        const fees = p.notional * (this.cfg.feeRoundTripPct / 100);
        const e: FundingEvent = {
          type: 'close', at, source: p.source, symbol: p.symbol, notional: p.notional,
          aprAtOpen: p.aprAtOpen, aprAtClose: aprNow,
          accrued: round(p.accrued), fees: round(fees), realized: round(p.accrued - fees),
          holdHours: round((nowMs - Date.parse(p.openedAt)) / 3_600_000),
        };
        this.positions.delete(key(p.source, p.symbol));
        this.emit(e);
        events.push(e);
      }
    }

    // 2) Open the best candidates above the entry bar (one position per
    //    base asset — the same coin on two venues is one crowded trade).
    const heldBases = new Set([...this.positions.values()].map((p) => p.symbol));
    const candidates = rates
      .filter((r) => r.apr >= this.cfg.enterApr && !heldBases.has(r.symbol) && !this.positions.has(key(r.source, r.symbol)))
      .sort((a, b) => b.apr - a.apr);
    for (const r of candidates) {
      if (this.positions.size >= this.cfg.maxPositions) break;
      if (heldBases.has(r.symbol)) continue;
      heldBases.add(r.symbol);
      this.positions.set(key(r.source, r.symbol), {
        source: r.source, symbol: r.symbol, openedAt: at, notional: this.cfg.notional,
        aprAtOpen: r.apr, accrued: 0, lastAccrualMs: nowMs,
      });
      const e: FundingEvent = { type: 'open', at, source: r.source, symbol: r.symbol, notional: this.cfg.notional, apr: round(r.apr) };
      this.emit(e);
      events.push(e);
    }
    return events;
  }

  /** Persist a mark for every open position (call ~hourly, keeps journal current). */
  mark(rates: FundingRate[], nowMs = Date.now()): void {
    const at = new Date(nowMs).toISOString();
    const bySymbol = new Map(rates.map((r) => [key(r.source, r.symbol), r]));
    for (const p of this.positions.values()) {
      const r = bySymbol.get(key(p.source, p.symbol));
      this.emit({ type: 'mark', at, source: p.source, symbol: p.symbol, accrued: round(p.accrued), apr: round(r?.apr ?? 0) });
    }
  }
}

const round = (x: number) => Math.round(x * 10000) / 10000;
