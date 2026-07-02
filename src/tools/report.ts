/**
 * Outcome report — answers "does the streak signal actually win?" from the
 * JSONL log the scanner writes (logs/outcomes.jsonl).
 *
 * "Win" here = REVERSAL: the candle after the alert closed against the streak
 * (the strategy the alerts imply — trade against streak exhaustion). The
 * continuation rate is simply the complement. Doji/void records are shown but
 * excluded from win-rate math. Break-even win rate for a payout P% is
 * 100/(100+P) — e.g. 92% payout → 52.1%.
 *
 * Run:  npm run report
 */
import fs from 'node:fs';
import { paths } from '../config.js';
import type { OutcomeRecord } from '../scanner/outcomes.js';

function pct(n: number, d: number): string {
  return d > 0 ? `${((n / d) * 100).toFixed(1)}%` : '—';
}

interface Bucket { reversal: number; continuation: number; doji: number; void: number }
const newBucket = (): Bucket => ({ reversal: 0, continuation: 0, doji: 0, void: 0 });

function addTo(map: Map<string, Bucket>, key: string, outcome: OutcomeRecord['outcome']): void {
  const b = map.get(key) ?? newBucket();
  b[outcome]++;
  map.set(key, b);
}

function printTable(title: string, map: Map<string, Bucket>): void {
  console.log(`\n${title}`);
  console.log('  key                     n    rev  cont  doji  gap   rev-rate');
  const rows = [...map.entries()].sort((a, b) => {
    const na = a[1].reversal + a[1].continuation;
    const nb = b[1].reversal + b[1].continuation;
    return nb - na;
  });
  for (const [key, b] of rows) {
    const decided = b.reversal + b.continuation;
    console.log(
      `  ${key.padEnd(22)}${String(decided + b.doji + b.void).padStart(4)}  ${String(b.reversal).padStart(5)} ${String(b.continuation).padStart(5)} ${String(b.doji).padStart(5)} ${String(b.void).padStart(4)}   ${pct(b.reversal, decided).padStart(6)}`,
    );
  }
}

function main(): void {
  if (!fs.existsSync(paths.outcomesFile)) {
    console.log(`No outcome log yet at ${paths.outcomesFile} — run the scanner first (npm run scan).`);
    return;
  }
  const records: OutcomeRecord[] = fs
    .readFileSync(paths.outcomesFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as OutcomeRecord);

  if (records.length === 0) {
    console.log('Outcome log is empty — no resolved alerts yet.');
    return;
  }

  const total = newBucket();
  const bySymbol = new Map<string, Bucket>();
  const byStreak = new Map<string, Bucket>();
  const byHour = new Map<string, Bucket>();
  for (const r of records) {
    total[r.outcome]++;
    addTo(bySymbol, r.label ?? r.symbol, r.outcome);
    addTo(byStreak, `streak ${r.streak}`, r.outcome);
    addTo(byHour, `${String(new Date(r.alertPeriodStart * 1000).getUTCHours()).padStart(2, '0')}:00 UTC`, r.outcome);
  }

  const decided = total.reversal + total.continuation;
  const first = records[0]!.at.slice(0, 10);
  const last = records[records.length - 1]!.at.slice(0, 10);
  console.log('─────────────────────────────────────────────────────');
  console.log('  ALERT OUTCOME REPORT');
  console.log(`  ${records.length} resolved alerts, ${first} → ${last}`);
  console.log('─────────────────────────────────────────────────────');
  console.log(`  Reversal (win):      ${total.reversal}  (${pct(total.reversal, decided)})`);
  console.log(`  Continuation (loss): ${total.continuation}  (${pct(total.continuation, decided)})`);
  console.log(`  Doji (refund):       ${total.doji}`);
  console.log(`  Void (feed gap):     ${total.void}`);
  console.log('  Break-even at 92% payout is 52.1% — below that, the signal loses money.');
  if (decided < 100) console.log(`  ⚠ Only ${decided} decided outcomes — treat every rate below as noise until ~100+.`);

  printTable('BY ASSET (most data first)', bySymbol);
  printTable('BY STREAK LENGTH', byStreak);
  printTable('BY HOUR OF ALERT (UTC)', byHour);
  console.log();
}

main();
