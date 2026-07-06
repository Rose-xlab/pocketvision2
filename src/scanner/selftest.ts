/**
 * Deterministic self-test for the Phase 2 core (candles + streaks).
 * No browser, no network, no credentials. Run: npm run test:core
 */
import { CandleBuilder, type Candle } from './candles.js';
import { StreakEngine, type StreakAlert } from './streaks.js';
import { OutcomeTracker, type OutcomeRecord } from './outcomes.js';
import { classifyAsset, edgeStats, rideAt, wilson, splitHoldout, EdgeBook, ROLLING_MIN_N } from './edge.js';
import { kellyFraction, RiskManager } from '../risk/manager.js';
import { FundingHarvester, type FundingRate } from '../strategies/funding.js';

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
const alertFrom = (c: Candle, colour: 'green' | 'red', count = 7): StreakAlert =>
  ({ symbol: c.symbol, colour, count, candle: c });
{
  const t = new OutcomeTracker(); // in-memory (no file)

  assert(t.onCandle(greenCandle(1)).length === 0, 'candle with no pending alert resolves nothing');

  // Reversal: 7 reds alerted at minute 6, minute 7 closes green.
  t.register(alertFrom(redCandle(6), 'red'));
  assert(t.onCandle(redCandle(5)).length === 0, 'stale candle (before expected) is ignored');
  const rev = t.onCandle(greenCandle(7));
  assert(rev[0]?.outcome === 'reversal', 'next candle against the streak → reversal');
  assert(rev[0]?.entry === 1.0, 'entry (strike) = open of the next candle');

  // Continuation: next candle extends the streak.
  t.register(alertFrom(redCandle(7), 'red', 8));
  assert(t.onCandle(redCandle(8))[0]?.outcome === 'continuation', 'next candle with the streak → continuation');

  // Doji: exactly flat next candle.
  t.register(alertFrom(redCandle(8), 'red', 9));
  assert(t.onCandle(dojiCandle(9))[0]?.outcome === 'doji', 'flat next candle → doji (refund)');

  // Void: the expected candle never arrived (feed gap).
  t.register(alertFrom(redCandle(9), 'red', 10));
  assert(t.onCandle(redCandle(12))[0]?.outcome === 'void', 'gap over the expected candle → void');

  assert(t.summary().includes('1W/1L'), `summary counts wins/losses: "${t.summary()}"`);
}

// Multi-expiry: one alert scored at 1-, 2- and 3-candle expiries vs. entry.
{
  const mkC = (i: number, open: number, close: number): Candle =>
    ({ symbol: 'X', periodStart: i * 60, timeframeSec: 60, open, high: Math.max(open, close) + 0.1, low: Math.min(open, close) - 0.1, close, ticks: 5 });
  const finals: OutcomeRecord[] = [];
  const t = new OutcomeTracker(undefined, (r) => finals.push(r));

  // Green streak alerted at candle 6; entry = open of candle 7 = 2.0.
  t.register(alertFrom(mkC(6, 1.8, 2.0), 'green'));
  const first = t.onCandle(mkC(7, 2.0, 2.5));
  assert(first[0]?.outcome === 'continuation' && first[0]?.entry === 2.0, 'expiry 1 resolves with entry=2.0');
  assert(finals.length === 0, 'record not finalized until all expiries resolve');
  t.onCandle(mkC(8, 2.5, 1.9)); // close 1.9 < entry → ride loss at expiry 2
  t.onCandle(mkC(9, 1.9, 2.0)); // close == entry → flat at expiry 3
  assert(finals.length === 1, 'record finalizes after the 3rd post-alert candle');
  assert(JSON.stringify(finals[0]?.ride) === '["win","loss","flat"]', `ride outcomes win/loss/flat: ${JSON.stringify(finals[0]?.ride)}`);
  assert(finals[0]?.lastBody !== undefined && Math.abs(finals[0].lastBody - 0.2) < 1e-9, 'lastBody feature recorded');

  // A skipped middle candle voids only that expiry; expiry 3 still scores.
  const t2 = new OutcomeTracker(undefined, (r) => finals.push(r));
  t2.register(alertFrom(mkC(0, 0.9, 1.0), 'green'));
  t2.onCandle(mkC(1, 1.0, 1.2)); // entry 1.0, expiry-1 win
  t2.onCandle(mkC(3, 1.1, 0.9)); // candle 2 missing → expiry-2 void; expiry-3: 0.9 < 1.0 → loss
  assert(JSON.stringify(finals[1]?.ride) === '["win","void","loss"]', `gap voids only the missed expiry: ${JSON.stringify(finals[1]?.ride)}`);

  // tick(): pendings whose candles never arrive time out as void.
  const t3 = new OutcomeTracker(undefined, (r) => finals.push(r));
  t3.register(alertFrom(mkC(0, 0.9, 1.0), 'green'));
  assert(t3.tick(100).length === 0, 'tick before the deadline resolves nothing');
  const timedOut = t3.tick(10_000);
  assert(timedOut[0]?.outcome === 'void', 'tick past the deadline voids the unresolved alert');
  assert(JSON.stringify(finals[2]?.ride) === '["void","void","void"]', 'timed-out record finalizes all-void');
}

// ── Edge maths (Wilson CI, EV, graduation, classification) ──
console.log('\nEdge maths');
{
  const [lo, hi] = wilson(50, 100);
  assert(lo > 0.39 && lo < 0.41 && hi > 0.59 && hi < 0.61, `wilson(50,100) ≈ [40%,60%]: [${(lo * 100).toFixed(1)},${(hi * 100).toFixed(1)}]`);

  assert(edgeStats(5, 5, 10 * 92).status === 'insufficient', 'n<30 → insufficient');
  assert(edgeStats(40, 60, 100 * 92).status === 'negative', '40% win rate → negative');
  assert(edgeStats(60, 40, 100 * 92).status === 'candidate', '60% on n=100 → candidate (CI spans break-even)');
  const grad = edgeStats(150, 50, 200 * 92);
  assert(grad.status === 'GRADUATED' && grad.evLo > 0, '75% on n=200 → GRADUATED (CI floor profitable)');

  assert(rideAt({ outcome: 'continuation' } as OutcomeRecord, 1) === 'win', 'legacy record: continuation = ride win');
  assert(rideAt({ outcome: 'reversal' } as OutcomeRecord, 1) === 'loss', 'legacy record: reversal = ride loss');
  assert(rideAt({ outcome: 'continuation' } as OutcomeRecord, 2) === undefined, 'legacy record has no expiry-2 data');

  assert(classifyAsset('currency') === 'forex', 'catalog type currency → forex');
  assert(classifyAsset('cryptocurrency') === 'crypto', 'catalog type cryptocurrency → crypto');
  assert(classifyAsset(undefined, 'EUR/USD OTC', 'EURUSD_otc') === 'forex', 'legacy label with slash → forex');
  assert(classifyAsset(undefined, 'Tesla OTC', '#TSLA_otc') === 'stock/index', 'legacy stock label → stock/index');

  const book = new EdgeBook();
  for (let i = 0; i < 3; i++) book.add({ outcome: 'continuation', label: 'EUR/USD OTC', payout: 92 } as OutcomeRecord);
  book.add({ outcome: 'reversal', label: 'EUR/USD OTC', payout: 92 } as OutcomeRecord);
  const st = book.rideStats('forex');
  assert(st.n === 4 && st.wins === 3, `EdgeBook tallies per class: ${st.wins}/${st.n}`);
}

// ── Realistic entry (entryReal at alert + delay, rideReal scoring) ──
console.log('\nRealistic entry');
{
  const mkC = (i: number, open: number, close: number): Candle =>
    ({ symbol: 'X', periodStart: i * 60, timeframeSec: 60, open, high: Math.max(open, close) + 0.1, low: Math.min(open, close) - 0.1, close, ticks: 5 });
  const finals: OutcomeRecord[] = [];
  const t = new OutcomeTracker(undefined, (r) => finals.push(r), 10);

  // Alert on candle 6 (green). Entry candle = [420, 480).
  t.register(alertFrom(mkC(6, 1.8, 2.0), 'green'));
  t.onTick('X', 425, 2.05);            // only 5s in — too early
  t.onTick('X', 431, 2.10);            // 11s in → entryReal = 2.10
  t.onTick('X', 440, 2.20);            // already captured, must not overwrite
  t.onCandle(mkC(7, 2.0, 2.15));       // expiry 1: ideal entry 2.0 → win; real 2.10 → win
  t.onCandle(mkC(8, 2.15, 2.05));      // expiry 2: ideal win (2.05 > 2.0), real LOSS (2.05 < 2.10)
  t.onCandle(mkC(9, 2.05, 2.10));      // expiry 3: ideal win, real flat (2.10 == 2.10)
  assert(finals.length === 1, 'record finalizes with realistic entry attached');
  assert(finals[0]?.entryReal === 2.10, `entryReal = first tick ≥ delay (got ${finals[0]?.entryReal})`);
  assert(JSON.stringify(finals[0]?.ride) === '["win","win","win"]', `ideal ride all wins: ${JSON.stringify(finals[0]?.ride)}`);
  assert(JSON.stringify(finals[0]?.rideReal) === '["win","loss","flat"]', `realistic ride shows the slippage cost: ${JSON.stringify(finals[0]?.rideReal)}`);

  // Tick after the entry candle ends must NOT become entryReal.
  const t2 = new OutcomeTracker(undefined, (r) => finals.push(r), 10);
  t2.register(alertFrom(mkC(6, 1.8, 2.0), 'green'));
  t2.onTick('X', 485, 9.99); // entry candle already over
  t2.onCandle(mkC(7, 2.0, 2.15));
  t2.onCandle(mkC(8, 2.15, 2.2));
  t2.onCandle(mkC(9, 2.2, 2.3));
  assert(finals[1]?.entryReal === undefined, 'tick after the entry candle is not a realistic entry');
}

// ── Decay monitor (rolling window demotes a dying edge) ──
console.log('\nDecay monitor');
{
  const rec = (win: boolean): OutcomeRecord =>
    ({ outcome: win ? 'continuation' : 'reversal', assetType: 'currency', payout: 92 } as OutcomeRecord);
  const book = new EdgeBook();
  // 260 strong wins: all-time GRADUATED (75%+ win rate).
  for (let i = 0; i < 260; i++) book.add(rec(i % 4 !== 0)); // 75% win
  assert(book.rideStats('forex').status === 'GRADUATED', 'strong history graduates');
  assert(book.decayAlarm('forex') === null, 'healthy edge raises no alarm');

  // Then the edge dies: 100 straight results at 30% win.
  let alarm: string | null = null;
  for (let i = 0; i < 100; i++) {
    book.add(rec(i % 10 < 3));
    alarm = alarm ?? book.decayAlarm('forex');
  }
  const s = book.rideStats('forex');
  assert(s.decayed === true, 'rolling window below break-even flags decay');
  assert(s.status === 'candidate', 'GRADUATED auto-demotes to candidate (paper)');
  assert(alarm !== null && alarm.includes('EDGE DECAY'), 'one-shot decay alarm fires on the transition');
  assert(book.decayAlarm('forex') === null, 'alarm does not repeat while still decayed');

  // Small samples never flag decay.
  const young = new EdgeBook();
  for (let i = 0; i < ROLLING_MIN_N - 1; i++) young.add(rec(false));
  assert(young.rideStats('forex').decayed !== true, 'decay needs a minimum rolling sample');
}

// ── Holdout split ──
console.log('\nHoldout split');
{
  const recs = Array.from({ length: 10 }, (_, i) =>
    ({ at: `2026-07-0${Math.min(9, i + 1)}T0${i % 10}:00:00Z`, symbol: 'S', alertPeriodStart: i } as OutcomeRecord));
  const [a, b] = splitHoldout(recs);
  assert(a.length === 5 && b.length === 5, 'splits into equal chronological halves');
  assert(a.every((r) => r.at <= b[0]!.at), 'first half is strictly earlier');
}

// ── Risk manager (Kelly, gates, stops, kill switch) ──
console.log('\nRisk manager');
{
  assert(Math.abs(kellyFraction(0.55, 0.92) - (0.55 * 1.92 - 1) / 0.92) < 1e-12, 'Kelly formula for binary payout');
  assert(kellyFraction(0.5, 0.92) === 0, 'no edge → zero Kelly');

  const cfg = { bankroll: 1000, kellyFraction: 0.25, maxStakePct: 2, dailyStopPct: 5, maxDrawdownPct: 20 };
  const graduated = edgeStats(150, 50, 200 * 92); // 75%, CI floor ~68% → GRADUATED
  const candidate = edgeStats(60, 40, 100 * 92);

  const rm = new RiskManager(cfg);
  const d = rm.stakeFor('po-ride-forex', graduated);
  assert(d.allowed && d.stake > 0, `graduated bucket gets a stake (${d.stakePct}% = ${d.stake})`);
  assert(d.stakePct <= 2, 'hard cap: never above maxStakePct');
  assert(!rm.stakeFor('x', candidate).allowed, 'candidate bucket gets NO stake');
  assert(!rm.stakeFor('x', { ...graduated, decayed: true }).allowed, 'decayed bucket gets NO stake');

  // Daily stop: lose 5% of bankroll → no more stakes today.
  rm.recordResult('po-ride-forex', -50);
  assert(!rm.stakeFor('po-ride-forex', graduated).allowed, 'daily stop blocks after -5% day');

  // Kill switch: drawdown ≥ 20% of bankroll → everything blocked until reset.
  const rm2 = new RiskManager(cfg);
  rm2.recordResult('s', +100);          // peak 100
  rm2.recordResult('s', -300);          // drawdown 300 ≥ 200 → killed
  assert(rm2.status().killed, 'kill switch trips at max drawdown from peak');
  assert(!rm2.stakeFor('s', graduated).allowed, 'killed manager refuses all stakes');
  rm2.resetKill();
  assert(rm2.status().killed === false, 'manual resetKill() re-arms (deliberate human act)');
}

// ── Funding harvester (paper simulator) ──
console.log('\nFunding harvester');
{
  const cfg = { enterApr: 15, exitApr: 5, feeRoundTripPct: 0.2, maxPositions: 2, notional: 1000 };
  const h = new FundingHarvester(cfg);
  const r = (symbol: string, apr: number, source: 'binance' | 'bybit' = 'binance'): FundingRate =>
    ({ source, symbol, rate8h: apr / 100 / 3 / 365, apr });

  const t0 = Date.parse('2026-07-06T00:00:00Z');
  const opened = h.step([r('AAAUSDT', 30), r('BBBUSDT', 20), r('CCCUSDT', 18), r('DDDUSDT', 3)], t0);
  assert(opened.filter((e) => e.type === 'open').length === 2, 'opens best candidates up to maxPositions');
  assert(h.positions.has('binance:AAAUSDT') && h.positions.has('binance:BBBUSDT'), 'highest APR first');

  // Same coin on a second venue must not double up.
  const h2 = new FundingHarvester(cfg);
  h2.step([r('AAAUSDT', 30, 'binance'), r('AAAUSDT', 28, 'bybit')], t0);
  assert(h2.positions.size === 1, 'one position per base asset across venues');

  // 8 hours later at 30% APR: accrual ≈ notional × rate8h.
  const t1 = t0 + 8 * 3600 * 1000;
  h.step([r('AAAUSDT', 30), r('BBBUSDT', 20)], t1);
  const accrued = h.positions.get('binance:AAAUSDT')!.accrued;
  const expected = 1000 * (30 / 100 / 3 / 365);
  assert(Math.abs(accrued - expected) < 1e-9, `8h accrual ≈ ${expected.toFixed(4)} (got ${accrued.toFixed(4)})`);

  // Rate decays below exit → close, fees charged.
  const events = h.step([r('AAAUSDT', 2), r('BBBUSDT', 20)], t1 + 1000);
  const close = events.find((e) => e.type === 'close');
  assert(close?.type === 'close' && close.symbol === 'AAAUSDT', 'decayed position closes');
  assert(close?.type === 'close' && Math.abs(close.fees - 2) < 1e-9, 'round-trip fee charged (0.2% of 1000)');
  assert(close?.type === 'close' && close.realized < close.accrued, 'realized = accrued − fees');
}

console.log(`\n${failures === 0 ? 'ALL PASSED ✓' : `${failures} FAILED ✗`}`);
process.exit(failures === 0 ? 0 : 1);
