/**
 * Phase 3 — crypto streak scanner on Binance (PAPER MODE).
 *
 * The exact same brain as the PO scanner — StreakEngine → OutcomeTracker →
 * EdgeBook, same graduation bar — pointed at an honest venue. Klines arrive
 * closed over one WebSocket, so there is no browser, no rotation pool, no
 * backfill dance.
 *
 * Scoring: crypto has no binary payout; a paper trade wins/loses 1:1 on the
 * close vs entry, so records carry payout=100 and break-even is 50% (before
 * fees — the report's job is to show whether the edge clears real costs).
 * NOTHING is executed. This exists to measure whether the streak edge is real
 * on crypto, with the same honesty as the PO log.
 *
 * Run:  npm run scan:crypto   (CRYPTO_PAIRS / CRYPTO_MAX_PAIRS / CRYPTO_TIMEFRAME_SEC in .env)
 */
import readline from 'node:readline';
import { config, paths } from '../config.js';
import type { Candle } from './candles.js';
import { StreakEngine } from './streaks.js';
import { OutcomeTracker, type OutcomeRecord } from './outcomes.js';
import { EdgeBook } from './edge.js';
import { TelegramSender, formatAlert, type TradeAdvice } from '../lib/telegram.js';
import { BinanceKlineFeed, recentCandles, topUsdtPairs } from '../venues/binance.js';

function waitForStop(): Promise<void> {
  if ((process.env.PV_SERVICE ?? '').trim() === '1') return new Promise(() => { /* run until killed */ });
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const done = () => { rl.close(); resolve(); };
    rl.question('', done);
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
  });
}

async function main() {
  const tf = config.crypto.timeframeSec;
  const engine = new StreakEngine({ threshold: config.streakThreshold, breakOnDoji: config.breakOnDoji, minBodyPct: config.minBodyPct });
  const tracker = new OutcomeTracker(paths.outcomesCryptoFile);
  const edgeBook = new EdgeBook(paths.outcomesCryptoFile);
  const telegram = new TelegramSender(config.telegram.token, config.telegram.chatId);
  let alertCount = 0;
  let candleCount = 0;
  let seeding = true;

  const adviceFor = (): TradeAdvice => {
    const s = edgeBook.rideStats('crypto');
    const pf = (x: number) => `${(x * 100).toFixed(1)}%`;
    const stats = `crypto ride (1:1): ${pf(s.winRate)} win (n=${s.n}, CI ${pf(s.ci[0])}–${pf(s.ci[1])})`;
    if (s.decayed) return { action: 'OBSERVE', note: `${stats} — ⚠️ DECAYED, paper only` };
    if (s.status === 'GRADUATED') return { action: 'RIDE', note: `${stats} — validated on paper; execution still manual` };
    if (s.status === 'candidate') return { action: 'RIDE', note: `${stats} — PAPER ONLY (not yet validated)` };
    return { action: 'OBSERVE', note: `${stats} — collecting data` };
  };

  const handleOutcome = (o: OutcomeRecord) => {
    const verdict = o.outcome === 'continuation' ? 'ride WIN ✅' : o.outcome === 'reversal' ? 'ride LOSS ❌' : o.outcome;
    console.log(`  📊 ${o.symbol}: ${verdict} after ${o.streak} ${o.colour} | ${tracker.summary()}`);
    edgeBook.add(o);
    const alarm = edgeBook.decayAlarm('crypto');
    if (alarm) { console.warn(`\n  ${alarm}\n`); void telegram.send(alarm); }
  };

  const onCandle = (candle: Candle) => {
    candleCount++;
    for (const o of tracker.onCandle(candle)) handleOutcome(o);
    const alert = engine.onCandle(candle);
    if (!alert || seeding) return; // seeded history warms state, never alerts
    alertCount++;
    const msg = `🧪 CRYPTO PAPER\n${formatAlert(alert, tf, alert.symbol, undefined, adviceFor())}`.replace('Source: Pocket Option live feed', 'Source: Binance klines');
    console.log('\n  ────────────────────────────────────────────');
    console.log(msg.split('\n').map((l) => `  🚨 ${l}`).join('\n'));
    console.log('  ────────────────────────────────────────────\n');
    telegram.enqueue(msg);
    tracker.register(alert, { payout: 100, label: alert.symbol, assetType: 'cryptocurrency' });
  };

  const watchlist = config.crypto.pairs !== 'auto'
    ? config.crypto.pairs.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
    : await topUsdtPairs(config.crypto.maxPairs);

  console.log('\n─────────────────────────────────────────────────────');
  console.log('  CRYPTO STREAK SCAN — BINANCE (paper mode, no orders)');
  console.log(`  • Threshold: ${config.streakThreshold} | timeframe: ${tf}s | doji: ${config.breakOnDoji ? 'break' : 'ignore'} | min body: ${config.minBodyPct}%`);
  console.log(`  • Watchlist: ${watchlist.length} USDT pairs (top by 24h volume)`);
  console.log(`  • Telegram: ${telegram.isEnabled ? 'ENABLED' : 'disabled (console only)'}`);
  console.log(`  • Outcomes → ${paths.outcomesCryptoFile}`);
  console.log('  • Press ENTER (or send SIGTERM) to stop.');
  console.log('─────────────────────────────────────────────────────\n');

  // Warm the streak engine with recent history so runs already in progress
  // are known — but never alert on the past.
  console.log('  Seeding recent history…');
  for (const sym of watchlist) {
    try { for (const c of await recentCandles(sym, tf, 15)) onCandle(c); }
    catch (e) { console.warn(`  (seed failed for ${sym}: ${(e as Error).message})`); }
  }
  seeding = false;
  console.log(`  Seeded ${candleCount} candles across ${watchlist.length} pairs. Live from here.\n`);

  const feed = new BinanceKlineFeed(watchlist, tf, onCandle, (m) => console.log(`  ${m}`));
  feed.start();

  const flusher = setInterval(() => {
    for (const o of tracker.tick(Date.now() / 1000)) handleOutcome(o);
  }, 1000);

  const status = setInterval(() => {
    const st = feed.status();
    const hot = watchlist
      .map((s) => ({ s, p: engine.peek(s) }))
      .filter((x) => x.p && x.p.count >= 3 && x.p.colour)
      .sort((a, b) => b.p!.count - a.p!.count)
      .slice(0, 6)
      .map((x) => `${x.s.replace(/USDT$/, '')} ${x.p!.count}${x.p!.colour === 'red' ? '🔴' : '🟢'}`);
    console.log(`  [status] sockets ${st.open}/${st.conns} | candles ${candleCount} | alerts ${alertCount} | top: ${hot.join('  ') || '—'}`);
  }, 30_000);

  // Watchdog: klines for 50 pairs should arrive every minute; 3 min of
  // silence means the feed is broken in a way reconnects didn't fix.
  const watchdog = setInterval(() => {
    const silentSec = (Date.now() - feed.status().lastEventAt) / 1000;
    if (silentSec > 180) {
      const msg = `⚠️ Crypto scan: no Binance events for ${Math.round(silentSec)}s — restarting feed.`;
      console.warn(`\n  ${msg}\n`);
      void telegram.send(msg);
      feed.stop();
      feed.start();
    }
  }, 60_000);

  const heartbeat = config.heartbeatMin > 0
    ? setInterval(() => {
        telegram.enqueue(`💓 Crypto scan alive | pairs ${watchlist.length} | candles ${candleCount} | alerts ${alertCount} | ${tracker.summary()}`);
      }, config.heartbeatMin * 60_000)
    : null;

  await waitForStop();
  clearInterval(flusher);
  clearInterval(status);
  clearInterval(watchdog);
  if (heartbeat) clearInterval(heartbeat);
  feed.stop();
  console.log(`\n  Session: ${alertCount} alerts | ${tracker.summary()}`);
  console.log(`  Outcome log: ${paths.outcomesCryptoFile}  (analyse with: npm run report)`);
  await telegram.drain();
}

main().catch((err) => { console.error('Crypto scan failed:', err); process.exit(1); });
