/**
 * Portfolio view (Phase 5) — the whole operation on one screen.
 *
 * Reads every stream's journal (PO streaks, crypto paper streaks, funding
 * harvester) and prints per-stream realized results at 1-unit stakes plus,
 * when two streams overlap long enough, the correlation of their daily PnL —
 * the number that says whether the edges actually diversify each other.
 * Capital follows the evidence: this table is what allocation decisions
 * are made from.
 */
import fs from 'node:fs';
import { paths } from '../config.js';
import { loadOutcomes, rideAt } from '../scanner/edge.js';
import type { FundingEvent } from '../strategies/funding.js';

interface StreamSummary {
  name: string;
  n: number;
  /** Cumulative PnL (unit stakes for streak streams; account units for funding). */
  pnl: number;
  maxDrawdown: number;
  /** Realized PnL per UTC day. */
  daily: Map<string, number>;
  note: string;
}

/** Streak outcome stream → unit-stake PnL series (ride @ 1-candle expiry). */
function streakStream(name: string, file: string): StreamSummary | null {
  if (!fs.existsSync(file)) return null;
  const records = loadOutcomes(file);
  if (records.length === 0) return null;
  const daily = new Map<string, number>();
  let pnl = 0, peak = 0, maxDD = 0, wins = 0, decided = 0;
  for (const r of records.sort((a, b) => a.at.localeCompare(b.at))) {
    const res = rideAt(r, 1);
    if (res !== 'win' && res !== 'loss') continue;
    decided++;
    const p = res === 'win' ? (wins++, (r.payout ?? 92) / 100) : -1;
    pnl += p;
    peak = Math.max(peak, pnl);
    maxDD = Math.max(maxDD, peak - pnl);
    const day = r.at.slice(0, 10);
    daily.set(day, (daily.get(day) ?? 0) + p);
  }
  if (decided === 0) return null;
  return {
    name, n: decided, pnl, maxDrawdown: maxDD, daily,
    note: `${((wins / decided) * 100).toFixed(1)}% win, ${(pnl / decided >= 0 ? '+' : '')}${((pnl / decided) * 100).toFixed(1)}% EV/trade`,
  };
}

/** Funding journal → realized (closes) + accrued-on-open (latest marks). */
function fundingStream(file: string): StreamSummary | null {
  if (!fs.existsSync(file)) return null;
  const daily = new Map<string, number>();
  let realized = 0, closes = 0, peak = 0, maxDD = 0;
  const openAccrued = new Map<string, number>();
  for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    let e: FundingEvent;
    try { e = JSON.parse(line) as FundingEvent; } catch { continue; }
    const k = `${e.source}:${e.symbol}`;
    if (e.type === 'open') openAccrued.set(k, 0);
    else if (e.type === 'mark') { if (openAccrued.has(k)) openAccrued.set(k, e.accrued); }
    else if (e.type === 'close') {
      openAccrued.delete(k);
      realized += e.realized;
      closes++;
      peak = Math.max(peak, realized);
      maxDD = Math.max(maxDD, peak - realized);
      const day = e.at.slice(0, 10);
      daily.set(day, (daily.get(day) ?? 0) + e.realized);
    }
  }
  const accrued = [...openAccrued.values()].reduce((s, x) => s + x, 0);
  if (closes === 0 && openAccrued.size === 0) return null;
  return {
    name: 'funding harvest (paper)', n: closes, pnl: realized, maxDrawdown: maxDD, daily,
    note: `${closes} closed, ${openAccrued.size} open (+${accrued.toFixed(2)} accruing)`,
  };
}

/** Pearson correlation of two daily-PnL series over their shared days. */
export function dailyCorrelation(a: Map<string, number>, b: Map<string, number>): { r: number; days: number } | null {
  const days = [...a.keys()].filter((d) => b.has(d));
  if (days.length < 10) return null;
  const xs = days.map((d) => a.get(d)!);
  const ys = days.map((d) => b.get(d)!);
  const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
  const mx = mean(xs), my = mean(ys);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < days.length; i++) {
    num += (xs[i]! - mx) * (ys[i]! - my);
    dx += (xs[i]! - mx) ** 2;
    dy += (ys[i]! - my) ** 2;
  }
  if (dx === 0 || dy === 0) return null;
  return { r: num / Math.sqrt(dx * dy), days: days.length };
}

export function portfolioSection(): void {
  const streams = [
    streakStream('PO streak ride (1u stakes)', paths.outcomesFile),
    streakStream('crypto streak ride (paper, 1u)', paths.outcomesCryptoFile),
    fundingStream(paths.fundingFile),
  ].filter((s): s is StreamSummary => s !== null);

  console.log('═════════════════════════════════════════════════════');
  console.log('  PORTFOLIO — all streams, capital follows the evidence');
  console.log('═════════════════════════════════════════════════════');
  if (streams.length === 0) {
    console.log('  No streams have data yet. PO: npm run scan | crypto: npm run scan:crypto | funding: npm run funding\n');
    return;
  }
  for (const s of streams) {
    console.log(
      `  ${s.name.padEnd(32)} n=${String(s.n).padStart(4)}  PnL ${(s.pnl >= 0 ? '+' : '') + s.pnl.toFixed(2).padStart(8)}  ` +
      `maxDD ${s.maxDrawdown.toFixed(2).padStart(7)}  ${s.note}`,
    );
  }
  for (let i = 0; i < streams.length; i++) {
    for (let j = i + 1; j < streams.length; j++) {
      const c = dailyCorrelation(streams[i]!.daily, streams[j]!.daily);
      if (c) {
        const verdict = Math.abs(c.r) < 0.3 ? 'good diversification' : c.r > 0.6 ? '⚠️ effectively the same bet' : 'some overlap';
        console.log(`  corr(${streams[i]!.name.split(' ')[0]}, ${streams[j]!.name.split(' ')[0]}) = ${c.r.toFixed(2)} over ${c.days} shared days — ${verdict}`);
      }
    }
  }
  console.log('');
}
