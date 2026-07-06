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
import type { OutcomeRecord } from '../scanner/outcomes.js';
import { classifyAsset, edgeStats, loadOutcomes, rideAt, type EdgeStats } from '../scanner/edge.js';

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

  // The punchline: everything currently worth acting on.
  console.log('\n─────────────────────────────────────────────────────');
  console.log('  VERDICTS');
  const buckets: [string, Tally][] = [
    ['ride forex (1-candle)', score(ofClass('forex'), 'ride', 1)],
    ['ride crypto (1-candle)', score(ofClass('crypto'), 'ride', 1)],
    ['ride stock/index (1-candle)', score(ofClass('stock/index'), 'ride', 1)],
    ['fade crypto (1-candle)', score(ofClass('crypto'), 'fade', 1)],
  ];
  let anyTradeable = false;
  for (const [name, t] of buckets) {
    const st = statsOf(t);
    if (st.status === 'GRADUATED') { console.log(`  ✅ ${name}: VALIDATED — EV ${pf(st.ev)} even at CI floor (${pf(st.evLo)}). Tradeable at flat 1% stakes.`); anyTradeable = true; }
    else if (st.status === 'candidate') console.log(`  🟡 ${name}: promising (EV ${(st.ev >= 0 ? '+' : '') + pf(st.ev)}, n=${st.n}) but NOT validated — paper trade only, need n≥200 with CI floor > 0.`);
  }
  if (!anyTradeable) console.log('  ⛔ Nothing has graduated yet — no real-money trades. Keep collecting.');
  console.log('─────────────────────────────────────────────────────\n');
}

main();
