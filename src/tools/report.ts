/**
 * Edge dashboard — answers "where is the money?" from logs/outcomes.jsonl.
 *
 * For every setup bucket it prints the win rate with a Wilson 95% CI and the
 * expected value per unit staked at the bucket's real average payout, in BOTH
 * directions (RIDE = bet continuation, FADE = bet reversal), plus multi-expiry
 * results for records captured by the v2 tracker.
 *
 * Status column:
 *   GRADUATED    — even the CI lower bound is profitable on n ≥ 200: tradeable
 *   candidate    — positive EV but the CI still spans break-even: PAPER ONLY
 *   negative     — losing at the observed rate
 *   insufficient — n < 30, ignore the numbers
 *
 * Run:  npm run report
 */
import fs from 'node:fs';
import { paths } from '../config.js';
import type { OutcomeRecord, RideOutcome } from '../scanner/outcomes.js';
import { classifyAsset, edgeStats, loadOutcomes, rideAt, splitHoldout, type EdgeStats } from '../scanner/edge.js';
import { portfolioSection } from './portfolio.js';

const pf = (x: number) => `${(x * 100).toFixed(1)}%`;

interface Tally { wins: number; losses: number; flats: number; voids: number; payoutSum: number }
const tally = (): Tally => ({ wins: 0, losses: 0, flats: 0, voids: 0, payoutSum: 0 });

/** Score `recs` in one direction ('ride' wins on continuation) at an expiry. */
function score(recs: OutcomeRecord[], dir: 'ride' | 'fade', expiry: number): Tally {
  const t = tally();
  for (const r of recs) {
    const ride = rideAt(r, expiry);
    if (ride === undefined) continue; // old record, no data at this expiry
    const res = dir === 'ride' ? ride : ride === 'win' ? 'loss' : ride === 'loss' ? 'win' : ride;
    if (res === 'win') { t.wins++; t.payoutSum += r.payout ?? 92; }
    else if (res === 'loss') { t.losses++; t.payoutSum += r.payout ?? 92; }
    else if (res === 'flat') t.flats++;
    else t.voids++;
  }
  return t;
}

function statsOf(t: Tally): EdgeStats {
  return edgeStats(t.wins, t.losses, t.payoutSum);
}

function row(name: string, t: Tally): void {
  const s = statsOf(t);
  if (s.n === 0) { console.log(`  ${name.padEnd(38)} n=0`); return; }
  console.log(
    `  ${name.padEnd(38)} n=${String(s.n).padStart(4)}  win=${pf(s.winRate).padStart(6)}  ` +
    `CI=[${pf(s.ci[0])},${pf(s.ci[1])}]  EV=${(s.ev >= 0 ? '+' : '') + pf(s.ev).padStart(5)}  ${s.status}`,
  );
}

function main(): void {
  if (!fs.existsSync(paths.outcomesFile)) {
    console.log(`No outcome log yet at ${paths.outcomesFile} — run the scanner first (npm run scan).`);
    return;
  }
  const records = loadOutcomes(paths.outcomesFile);
  if (records.length === 0) {
    console.log('Outcome log is empty — no resolved alerts yet.');
    return;
  }

  const v2 = records.filter((r) => r.ride && r.ride.length > 0).length;
  const first = records[0]!.at.slice(0, 10);
  const last = records[records.length - 1]!.at.slice(0, 10);
  const overallRide = score(records, 'ride', 1);
  const s = statsOf(overallRide);

  console.log('═════════════════════════════════════════════════════');
  console.log('  EDGE DASHBOARD');
  console.log(`  ${records.length} resolved alerts (${v2} multi-expiry), ${first} → ${last}`);
  console.log('═════════════════════════════════════════════════════');
  console.log(`  Ride wins ${overallRide.wins} / losses ${overallRide.losses} / flat ${overallRide.flats} / void ${overallRide.voids}`);
  console.log(`  Break-even at avg payout ${pf(s.avgPayout)} is ${pf(s.breakEven)} win rate.`);
  console.log('  GRADUATED = tradeable | candidate = PAPER ONLY | rest = do not trade.');

  console.log('\nDIRECTION × ASSET CLASS (1-candle expiry)');
  const classes = ['forex', 'crypto', 'stock/index'] as const;
  const ofClass = (c: string) => records.filter((r) => classifyAsset(r.assetType, r.label, r.symbol) === c);
  row('RIDE: all', score(records, 'ride', 1));
  for (const c of classes) row(`RIDE: ${c}`, score(ofClass(c), 'ride', 1));
  row('FADE: all', score(records, 'fade', 1));
  for (const c of classes) row(`FADE: ${c}`, score(ofClass(c), 'fade', 1));

  console.log('\nRIDE BY MINIMUM STREAK (1-candle expiry)');
  for (const t of [7, 8, 9, 10, 11]) row(`ride: streak >= ${t}`, score(records.filter((r) => r.streak >= t), 'ride', 1));

  console.log('\nRIDE BY EXPIRY (v2 records only — grows as new data arrives)');
  for (let e = 1; e <= 3; e++) {
    const v2recs = records.filter((r) => r.ride && r.ride.length >= e);
    row(`ride: all @ ${e}-candle expiry`, score(v2recs, 'ride', e));
    row(`ride: forex @ ${e}-candle expiry`, score(v2recs.filter((r) => classifyAsset(r.assetType, r.label, r.symbol) === 'forex'), 'ride', e));
  }

  console.log('\nRIDE BY 4-HOUR BLOCK (UTC, 1-candle expiry)');
  for (let b = 0; b < 24; b += 4) {
    const sel = records.filter((r) => { const h = new Date(r.alertPeriodStart * 1000).getUTCHours(); return h >= b && h < b + 4; });
    row(`ride: ${String(b).padStart(2, '0')}–${String(b + 3).padStart(2, '0')}h UTC`, score(sel, 'ride', 1));
  }

  // ── Realistic entry: the edge at the price you actually get. ──
  const realRecs = records.filter((r) => r.rideReal && r.rideReal.length > 0);
  if (realRecs.length > 0) {
    console.log(`\nREALISTIC ENTRY (+${realRecs[0]!.entryRealDelaySec ?? 10}s slippage, ${realRecs.length} records, 1-candle expiry)`);
    const scoreReal = (recs: OutcomeRecord[]): Tally => {
      const t = tally();
      for (const r of recs) {
        const res = r.rideReal?.[0] as RideOutcome | undefined;
        if (res === 'win') { t.wins++; t.payoutSum += r.payout ?? 92; }
        else if (res === 'loss') { t.losses++; t.payoutSum += r.payout ?? 92; }
        else if (res === 'flat') t.flats++;
        else t.voids++;
      }
      return t;
    };
    row('ride @ next-open (same records)', score(realRecs, 'ride', 1));
    row('ride @ realistic entry', scoreReal(realRecs));
    const ideal = statsOf(score(realRecs, 'ride', 1));
    const real = statsOf(scoreReal(realRecs));
    if (ideal.n >= 30 && real.n >= 30) {
      const gap = ideal.winRate - real.winRate;
      console.log(`  → slippage costs ${pf(Math.abs(gap))} win rate ${gap > 0 ? '(entry delay HURTS — automate execution)' : '(no measurable cost yet)'}`);
    }
  }

  console.log('\nRIDE BY ASSET (top 15 by sample size, 1-candle expiry)');
  const bySym = new Map<string, OutcomeRecord[]>();
  for (const r of records) {
    const k = r.label ?? r.symbol;
    (bySym.get(k) ?? bySym.set(k, []).get(k)!).push(r);
  }
  [...bySym.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 15)
    .forEach(([k, rs]) => row(`ride: ${k}`, score(rs, 'ride', 1)));

  // ── Holdout validation: an edge is only real if it shows up in BOTH
  // chronological halves. Kills buckets that only look good because we
  // scanned dozens of slices (multiple-comparisons trap). ──
  const [halfA, halfB] = splitHoldout(records);
  const holdout = (recs: OutcomeRecord[], dir: 'ride' | 'fade'): { full: EdgeStats; a: EdgeStats; b: EdgeStats; pass: boolean } => {
    const inHalf = (half: OutcomeRecord[]) => {
      const keys = new Set(half.map((r) => `${r.symbol}|${r.alertPeriodStart}`));
      return recs.filter((r) => keys.has(`${r.symbol}|${r.alertPeriodStart}`));
    };
    const full = statsOf(score(recs, dir, 1));
    const a = statsOf(score(inHalf(halfA), dir, 1));
    const b = statsOf(score(inHalf(halfB), dir, 1));
    // Pass = positive EV in both halves with a workable sample in each.
    const pass = a.n >= 20 && b.n >= 20 && a.ev > 0 && b.ev > 0;
    return { full, a, b, pass };
  };

  console.log(`\nHOLDOUT VALIDATION (chronological halves: ${halfA.length} + ${halfB.length} records)`);
  const holdoutBuckets: [string, OutcomeRecord[], 'ride' | 'fade'][] = [
    ['ride forex', ofClass('forex'), 'ride'],
    ['ride crypto', ofClass('crypto'), 'ride'],
    ['ride stock/index', ofClass('stock/index'), 'ride'],
  ];
  const holdoutResult = new Map<string, boolean>();
  for (const [name, recs, dir] of holdoutBuckets) {
    const h = holdout(recs, dir);
    holdoutResult.set(name, h.pass);
    const half = (s: EdgeStats) => s.n === 0 ? 'n=0' : `EV ${(s.ev >= 0 ? '+' : '') + pf(s.ev)} (n=${s.n})`;
    console.log(`  ${name.padEnd(20)} 1st half: ${half(h.a).padEnd(20)} 2nd half: ${half(h.b).padEnd(20)} → ${h.pass ? 'PASS ✅' : h.a.n < 20 || h.b.n < 20 ? 'insufficient' : 'FAIL ❌'}`);
  }

  // The punchline: everything currently worth acting on.
  console.log('\n─────────────────────────────────────────────────────');
  console.log('  VERDICTS  (GRADUATED stats + holdout pass = tradeable)');
  const buckets: [string, Tally, string | null][] = [
    ['ride forex (1-candle)', score(ofClass('forex'), 'ride', 1), 'ride forex'],
    ['ride crypto (1-candle)', score(ofClass('crypto'), 'ride', 1), 'ride crypto'],
    ['ride stock/index (1-candle)', score(ofClass('stock/index'), 'ride', 1), 'ride stock/index'],
    ['fade crypto (1-candle)', score(ofClass('crypto'), 'fade', 1), null],
  ];
  let anyTradeable = false;
  for (const [name, t, holdoutKey] of buckets) {
    const st = statsOf(t);
    const hPass = holdoutKey ? holdoutResult.get(holdoutKey) ?? false : false;
    if (st.status === 'GRADUATED' && hPass) {
      console.log(`  ✅ ${name}: VALIDATED — EV ${pf(st.ev)} at CI floor ${pf(st.evLo)}, positive in both holdout halves. Tradeable (size via risk manager).`);
      anyTradeable = true;
    } else if (st.status === 'GRADUATED' && !hPass) {
      console.log(`  ⚠️ ${name}: graduated on the full sample but FAILED holdout — likely luck from slicing. PAPER ONLY until both halves are positive.`);
    } else if (st.status === 'candidate') {
      console.log(`  🟡 ${name}: promising (EV ${(st.ev >= 0 ? '+' : '') + pf(st.ev)}, n=${st.n}) but NOT validated — paper trade only, need n≥200, CI floor > 0, holdout pass.`);
    }
  }
  if (!anyTradeable) console.log('  ⛔ Nothing has fully validated yet — no real-money trades. Keep collecting.');
  console.log('─────────────────────────────────────────────────────\n');

  // ── Phase 5: the whole operation at a glance. ──
  portfolioSection();
}

main();
