/**
 * Deterministic self-test for the Phase 2 core (candles + streaks).
 * No browser, no network, no credentials. Run: npm run test:core
 */
import { CandleBuilder, type Candle } from './candles.js';
import { StreakEngine, type StreakAlert } from './streaks.js';
import { OutcomeTracker } from './outcomes.js';

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) { console.log(`  ✓ ${msg}`); }
  else { console.log(`  ✗ ${msg}`); failures++; }
}

// ── CandleBuilder ────────────────────────────────────────────
console.log('CandleBuilder');
{
  const b = new CandleBuilder(60, 1.5);
  const S = 'TEST';
  // Bucket [0,60): ticks 1.0, 1.5, 0.8, 1.2
  for (const [ts, price] of [[1, 1.0], [20, 1.5], [40, 0.8], [59, 1.2]] as const) {
    assert(b.addTick({ symbol: S, ts, price }).length === 0, `tick ${ts} keeps bucket open`);
  }
  // First tick of next bucket closes bucket 0.
  const closed = b.addTick({ symbol: S, ts: 61, price: 2.0 });
  assert(closed.length === 1, 'crossing into bucket 60 closes bucket 0');
  const c = closed[0]!;
  assert(c.open === 1.0 && c.high === 1.5 && c.low === 0.8 && c.close === 1.2 && c.ticks === 4,
    `OHLC correct: O${c.open} H${c.high} L${c.low} C${c.close} n${c.ticks}`);
  assert(c.periodStart === 0, 'periodStart aligned to bucket');

  // Late tick for the already-closed bucket 0 is dropped.
  assert(b.addTick({ symbol: S, ts: 30, price: 99 }).length === 0, 'late tick for closed bucket dropped');

  // Time-based flush closes the quiet bucket 60 after grace.
  assert(b.flush(60 + 60 + 1).length === 0, 'flush before grace does nothing');
  const flushed = b.flush(60 + 60 + 2);
  assert(flushed.length === 1 && flushed[0]!.periodStart === 60, 'flush after grace closes bucket 60');
}

// ── StreakEngine ─────────────────────────────────────────────
console.log('\nStreakEngine');
const redCandle = (i: number): Candle => ({ symbol: 'EURUSD_otc', periodStart: i * 60, timeframeSec: 60, open: 1.1, high: 1.1, low: 1.0, close: 1.0, ticks: 10 });
const greenCandle = (i: number): Candle => ({ symbol: 'EURUSD_otc', periodStart: i * 60, timeframeSec: 60, open: 1.0, high: 1.1, low: 1.0, close: 1.1, ticks: 10 });
const dojiCandle = (i: number): Candle => ({ symbol: 'EURUSD_otc', periodStart: i * 60, timeframeSec: 60, open: 1.05, high: 1.1, low: 1.0, close: 1.05, ticks: 10 });

{
  const eng = new StreakEngine({ threshold: 7, breakOnDoji: true });
  const alerts: StreakAlert[] = [];
  for (let i = 0; i < 6; i++) { const a = eng.onCandle(redCandle(i)); if (a) alerts.push(a); }
  assert(alerts.length === 0, 'no alert before threshold (6 reds)');

  const a7 = eng.onCandle(redCandle(6));
  assert(a7?.count === 7 && a7.colour === 'red', 'alert fires at exactly 7 red');

  const a8 = eng.onCandle(redCandle(7));
  assert(a8?.count === 8, 'alert fires again when streak extends to 8');

  // Feeding nothing new / same count must not duplicate — simulate by peeking.
  assert(eng.peek('EURUSD_otc')?.lastAlerted === 8, 'lastAlerted tracks 8 (dedup guard)');

  const broken = eng.onCandle(greenCandle(8));
  assert(broken === null && eng.peek('EURUSD_otc')?.count === 1, 'opposite colour resets run to 1');
}

// Restart safety: snapshot at 8, restore into a fresh engine, extend to 9.
{
  const eng1 = new StreakEngine({ threshold: 7, breakOnDoji: true });
  for (let i = 0; i < 8; i++) eng1.onCandle(redCandle(i)); // alerts at 7 and 8
  const snap = eng1.snapshot();

  assert(snap['EURUSD_otc']?.count === 8 && snap['EURUSD_otc']?.lastAlerted === 8,
    'snapshot captures count=8 and lastAlerted=8');

  const eng2 = new StreakEngine({ threshold: 7, breakOnDoji: true });
  eng2.restore(snap);
  const a9 = eng2.onCandle(redCandle(8));
  assert(a9?.count === 9, 'after restart, the next candle alerts 9 (not a re-alert of 7/8)');
}

// Doji handling.
{
  const brk = new StreakEngine({ threshold: 3, breakOnDoji: true });
  for (let i = 0; i < 3; i++) brk.onCandle(redCandle(i));
  brk.onCandle(dojiCandle(3));
  assert(brk.peek('EURUSD_otc')?.count === 0, 'breakOnDoji resets the run');

  const ign = new StreakEngine({ threshold: 3, breakOnDoji: false });
  for (let i = 0; i < 3; i++) ign.onCandle(redCandle(i));
  ign.onCandle(dojiCandle(3));
  assert(ign.peek('EURUSD_otc')?.count === 3, 'ignore-doji leaves the run untouched');
}

// Gap handling: a non-consecutive candle must reset the run (brief §6).
{
  const eng = new StreakEngine({ threshold: 7, breakOnDoji: true });
  for (let i = 0; i < 7; i++) eng.onCandle(redCandle(i)); // alert at 7
  assert(eng.peek('EURUSD_otc')?.count === 7, 'run at 7 before gap');
  // Skip minute 7 (i=8 is not adjacent to i=6's successor) → gap resets.
  const afterGap = eng.onCandle(redCandle(9));
  assert(afterGap === null && eng.peek('EURUSD_otc')?.count === 1, 'gap resets run to 1 (no false continuation)');

  // Adjacent candles after the reset resume counting normally.
  for (let i = 10; i < 15; i++) eng.onCandle(redCandle(i));
  assert(eng.peek('EURUSD_otc')?.count === 6, 'counting resumes after gap');
}

// ── Body-size filter (micro-candles are noise, not direction) ──
console.log('\nBody-size filter');
{
  // Every candle spans range 1.0 (high 1.5, low 0.5) around open 1.0.
  const mk = (i: number, body: number): Candle =>
    ({ symbol: 'BODY', periodStart: i * 60, timeframeSec: 60, open: 1.0, high: 1.5, low: 0.5, close: 1.0 + body, ticks: 10 });

  const eng = new StreakEngine({ threshold: 7, breakOnDoji: true, minBodyPct: 10 });
  // Warm-up: with fewer than 5 ranges observed, even tiny bodies count.
  for (let i = 0; i < 5; i++) eng.onCandle(mk(i, 0.001));
  assert(eng.peek('BODY')?.count === 5, 'before warm-up, tiny bodies still count (run 5)');

  // Filter engaged: avg range 1.0 → min body 0.1; a 0.001 body is now a doji.
  eng.onCandle(mk(5, 0.001));
  assert(eng.peek('BODY')?.count === 0, 'micro-body (0.1% of range) classified doji → breaks streak');

  // A real body still counts.
  eng.onCandle(mk(6, 0.5));
  assert(eng.peek('BODY')?.count === 1 && eng.peek('BODY')?.colour === 'green', 'normal body (50% of range) still green');

  // Just under the 10% threshold → doji; just over → counts.
  eng.onCandle(mk(7, 0.09));
  assert(eng.peek('BODY')?.count === 0, 'body just under threshold is doji');
  eng.onCandle(mk(8, 0.11));
  assert(eng.peek('BODY')?.count === 1, 'body just over threshold counts');

  // minBodyPct 0 (or omitted) keeps the legacy exact-equality behaviour.
  const legacy = new StreakEngine({ threshold: 7, breakOnDoji: true });
  for (let i = 0; i < 3; i++) legacy.onCandle(mk(i, 0.001));
  legacy.onCandle(mk(3, 0.001));
  assert(legacy.peek('BODY')?.count === 4, 'filter off → tiny bodies keep counting');
}

// ── OutcomeTracker (alert → next-candle scoring) ──
console.log('\nOutcomeTracker');
{
  const alertFrom = (c: Candle, colour: 'green' | 'red', count = 7): StreakAlert =>
    ({ symbol: c.symbol, colour, count, candle: c });
  const t = new OutcomeTracker(); // in-memory (no file)

  assert(t.onCandle(greenCandle(1)) === null, 'candle with no pending alert resolves nothing');

  // Reversal: 7 reds alerted at minute 6, minute 7 closes green.
  t.register(alertFrom(redCandle(6), 'red'));
  assert(t.onCandle(redCandle(5)) === null, 'stale candle (before expected) is ignored');
  const rev = t.onCandle(greenCandle(7));
  assert(rev?.outcome === 'reversal', 'next candle against the streak → reversal');

  // Continuation: next candle extends the streak.
  t.register(alertFrom(redCandle(7), 'red', 8));
  assert(t.onCandle(redCandle(8))?.outcome === 'continuation', 'next candle with the streak → continuation');

  // Doji: exactly flat next candle.
  t.register(alertFrom(redCandle(8), 'red', 9));
  assert(t.onCandle(dojiCandle(9))?.outcome === 'doji', 'flat next candle → doji (refund)');

  // Void: the expected candle never arrived (feed gap).
  t.register(alertFrom(redCandle(9), 'red', 10));
  assert(t.onCandle(redCandle(12))?.outcome === 'void', 'gap over the expected candle → void');

  assert(t.summary().includes('1W/1L'), `summary counts wins/losses: "${t.summary()}"`);
}

console.log(`\n${failures === 0 ? 'ALL PASSED ✓' : `${failures} FAILED ✗`}`);
process.exit(failures === 0 ? 0 : 1);
